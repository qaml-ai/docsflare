import { compile } from "@mdx-js/mdx";
import { MDXProvider } from "@mdx-js/react";
import matter from "gray-matter";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import * as jsxRuntime from "react/jsx-runtime";

type MintConfig = {
  name?: string;
  logo?: string | { light?: string; dark?: string };
  favicon?: string;
  colors?: {
    primary?: string;
    light?: string;
    dark?: string;
  };
  navbar?: {
    links?: Array<{ label?: string; href?: string }>;
    primary?: { type?: string; label?: string; href?: string };
  };
  navigation?: unknown;
};

type PageRef = {
  title?: string;
  path: string;
};

type NavGroup = {
  title: string;
  pages: PageRef[];
};

type BuiltPage = {
  title: string;
  description: string;
  route: string;
  sourcePath: string;
  html: string;
  markdown: string;
};

type BuiltAsset = {
  route: string;
  contentType: string;
  base64: string;
};

type NavLink = {
  label: string;
  href: string;
};

const projectRoot = process.cwd();
const root = process.env.DOCSFLARE_CONTENT_DIR ? path.resolve(process.env.DOCSFLARE_CONTENT_DIR) : path.join(projectRoot, "docs");
const generatedDir = path.join(projectRoot, "src", "generated");
const ignoredDirs = new Set([
  ".git",
  ".wrangler",
  ".docsflare",
  "dist",
  "node_modules",
  "scripts",
  "src"
]);

function readConfig(): { config: MintConfig; filename: string } {
  for (const filename of ["docs.json", "mint.json"]) {
    const absolute = path.join(root, filename);
    if (existsSync(absolute)) {
      return { config: JSON.parse(readFileSync(absolute, "utf8")) as MintConfig, filename };
    }
  }

  throw new Error(`Missing docs.json or mint.json in ${root}. Run "docsflare init" to create starter content.`);
}

function pageRefFromUnknown(value: unknown): PageRef | undefined {
  if (typeof value === "string") {
    if (isExternal(value)) return undefined;
    return { path: stripExtension(value) };
  }

  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const rawPath = firstString(record.page, record.path, record.href, record.url);
  if (!rawPath || isExternal(rawPath)) return undefined;

  return {
    title: firstString(record.title, record.label, record.name),
    path: stripExtension(rawPath)
  };
}

function normalizeNavigation(navigation: unknown): NavGroup[] {
  const groups: NavGroup[] = [];
  const uncategorized: PageRef[] = [];

  function visit(value: unknown, inheritedTitle?: string) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedTitle);
      return;
    }

    const pageRef = pageRefFromUnknown(value);
    if (pageRef && !hasNestedNavigation(value)) {
      uncategorized.push(pageRef);
      return;
    }

    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const ownTitle = firstString(record.group, record.tab, record.anchor, record.title, record.name, record.label);
    const title = ownTitle && inheritedTitle && record.group ? `${inheritedTitle} / ${ownTitle}` : ownTitle ?? inheritedTitle;
    const pages = collectPages(record.pages);

    if (title && pages.length > 0) {
      groups.push({ title, pages });
    }

    for (const key of ["groups", "tabs", "anchors", "dropdowns", "versions"]) {
      if (record[key]) visit(record[key], title);
    }
  }

  visit(navigation);

  if (groups.length === 0 && uncategorized.length > 0) {
    groups.push({ title: "Docs", pages: uncategorized });
  }

  return groups;
}

function hasNestedNavigation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.pages || record.groups || record.tabs || record.anchors || record.dropdowns || record.versions);
}

function collectPages(value: unknown): PageRef[] {
  if (!Array.isArray(value)) return [];
  const pages: PageRef[] = [];

  for (const item of value) {
    const page = pageRefFromUnknown(item);
    if (page) {
      pages.push(page);
      continue;
    }

    if (item && typeof item === "object") {
      const nested = (item as Record<string, unknown>).pages;
      pages.push(...collectPages(nested));
    }
  }

  return pages;
}

function discoverMarkdownFiles(dir = root): string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const relative = path.relative(root, absolute);
    const stats = statSync(absolute);

    if (stats.isDirectory()) {
      if (!ignoredDirs.has(entry)) files.push(...discoverMarkdownFiles(absolute));
      continue;
    }

    if (stats.isFile() && /\.(mdx|md)$/.test(entry) && entry.toLowerCase() !== "readme.md") {
      files.push(relative);
    }
  }

  return files;
}

function resolvePagePath(pagePath: string): string | undefined {
  const normalized = pagePath.replace(/^\/+/, "");
  const candidates = [
    normalized,
    `${normalized}.mdx`,
    `${normalized}.md`,
    path.join(normalized, "index.mdx"),
    path.join(normalized, "index.md")
  ];

  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      return path.relative(root, absolute);
    }
  }

  return undefined;
}

async function renderMdx(source: string, sourcePath: string): Promise<string> {
  const preparedSource = preprocessMdx(source);
  const compiled = String(
    await compile(preparedSource, {
      outputFormat: "function-body",
      development: false,
      remarkPlugins: [remarkGfm],
      rehypePlugins: [
        rehypeSlug,
        [
          rehypeAutolinkHeadings,
          {
            behavior: "wrap",
            properties: {
              className: ["heading-anchor"],
              ariaLabel: "Link to heading"
            }
          }
        ]
      ]
    })
  );

  const scope = {
    React,
    MDXProvider,
    ...jsxRuntime,
    useMDXComponents: () => mdxComponents
  };
  const fn = new Function(compiled);
  const { default: Content } = fn(scope) as { default: React.ComponentType<{ components: typeof mdxComponents }> };

  return renderToStaticMarkup(
    React.createElement(MDXProvider, { components: mdxComponents }, React.createElement(Content, { components: mdxComponents }))
  );
}

function preprocessMdx(source: string): string {
  return escapeProseBraces(source.replace(/^(#{1,6}\s+.+?)\s+\{#[A-Za-z0-9_-]+\}\s*$/gm, "$1"));
}

function escapeProseBraces(source: string): string {
  let inFence = false;

  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }

      if (inFence || /^\s*(<|<\/|{|}|import\s|export\s)/.test(line)) {
        return line;
      }

      return line.replace(/[{}]/g, (brace) => (brace === "{" ? "&#123;" : "&#125;"));
    })
    .join("\n");
}

const mdxComponents = {
  CardGroup: ({ children, cols }: { children?: ReactNode; cols?: number }) =>
    React.createElement("div", { className: "mdx-card-group", "data-cols": String(cols ?? 2), style: { "--cols": String(cols ?? 2) } as React.CSSProperties }, children),
  Card: ({ children, title, href, icon, color }: { children?: ReactNode; title?: string; href?: string; icon?: string; color?: string }) => {
    const Tag = href ? "a" : "div";
    return React.createElement(
      Tag,
      { className: "mdx-card", href },
      React.createElement("span", { className: "mdx-card-icon", style: { color: color ?? undefined } }, iconSvg(icon)),
      React.createElement("strong", null, title),
      React.createElement("div", null, children)
    );
  },
  Info: callout("info", "Info"),
  Note: callout("note", "Note"),
  Tip: callout("tip", "Tip"),
  Warning: callout("warning", "Warning"),
  Check: callout("check", "Check"),
  Accordion: ({ children, title }: { children?: ReactNode; title?: string }) =>
    React.createElement("details", { className: "mdx-accordion" }, React.createElement("summary", null, title), React.createElement("div", null, children)),
  AccordionGroup: ({ children }: { children?: ReactNode }) => React.createElement("div", { className: "mdx-accordion-group" }, children),
  Tabs: ({ children }: { children?: ReactNode }) => React.createElement("div", { className: "mdx-tabs" }, children),
  Tab: ({ children, title }: { children?: ReactNode; title?: string }) =>
    React.createElement("section", { className: "mdx-tab" }, React.createElement("h3", null, title), children),
  Steps: ({ children }: { children?: ReactNode }) => React.createElement("ol", { className: "mdx-steps" }, children),
  Step: ({ children, title }: { children?: ReactNode; title?: string }) =>
    React.createElement("li", null, title ? React.createElement("strong", null, title) : null, children),
  Frame: ({ children }: { children?: ReactNode }) => React.createElement("div", { className: "mdx-frame" }, children),
  CodeGroup: ({ children }: { children?: ReactNode }) => React.createElement("div", { className: "mdx-code-group" }, children),
  Columns: ({ children, cols }: { children?: ReactNode; cols?: number }) =>
    React.createElement("div", { className: "mdx-columns", style: { "--cols": String(cols ?? 2) } as React.CSSProperties }, children),
  Update: ({ children, label, description }: { children?: ReactNode; label?: string; description?: string }) =>
    React.createElement(
      "section",
      { className: "mdx-update" },
      React.createElement("div", { className: "mdx-update-marker" }),
      React.createElement(
        "div",
        null,
        React.createElement("h2", null, label),
        description ? React.createElement("p", { className: "mdx-update-description" }, description) : null,
        children
      )
    )
};

function iconSvg(name = "code"): React.ReactElement {
  const paths: Record<string, string[]> = {
    rocket: ["M5 19c4-8 8-12 16-14-2 8-6 12-14 16l-2-2z", "M14 6l4 4", "M5 19l-2 4 4-2"],
    globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M3 12h18", "M12 3c3 3 3 15 0 18", "M12 3c-3 3-3 15 0 18"],
    "hard-drive": ["M4 6h16l2 7v5H2v-5l2-7z", "M6 15h.01", "M18 15h.01"],
    plug: ["M9 7v5", "M15 7v5", "M7 12h10v2a5 5 0 0 1-10 0v-2z", "M12 19v2"],
    clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
    brain: ["M8 8a4 4 0 0 1 8 0", "M8 16a4 4 0 0 0 8 0", "M8 8v8", "M16 8v8", "M8 12h8"],
    robot: ["M6 8h12v10H6V8z", "M9 12h.01", "M15 12h.01", "M10 16h4", "M12 5v3"],
    wrench: ["M14 6l4 4-8 8-4-4 8-8z", "M5 19l4-4"],
    browser: ["M4 5h16v14H4V5z", "M4 9h16"],
    "credit-card": ["M3 6h18v12H3V6z", "M3 10h18", "M7 15h4"],
    bookmark: ["M7 4h10v16l-5-3-5 3V4z"],
    "chart-line": ["M4 18h16", "M6 15l4-4 3 3 5-7"],
    newspaper: ["M4 5h16v14H4V5z", "M8 9h8", "M8 13h8", "M8 17h5"],
    code: ["M9 18l-6-6 6-6", "M15 6l6 6-6 6"]
  };
  const selected = paths[name] ?? paths.code;
  return React.createElement(
    "svg",
    { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
    selected.map((d, index) => React.createElement("path", { key: index, d }))
  );
}

function callout(kind: string, label: string) {
  return ({ children }: { children?: ReactNode }) =>
    React.createElement(
      "aside",
      { className: `mdx-callout mdx-callout-${kind}` },
      React.createElement("strong", null, label),
      React.createElement("div", null, children)
    );
}

function routeFromPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  const withoutExtension = path.join(parsed.dir, parsed.name).replace(/\\/g, "/");
  const route = withoutExtension.replace(/(^|\/)index$/, "");
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1];
  return heading ? stripMarkdown(heading) : humanize(fallback);
}

function stripMarkdown(value: string): string {
  return value.replace(/[`*_#[\]()]/g, "").trim();
}

function humanize(value: string): string {
  return stripExtension(path.basename(value)).replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stripExtension(value: string): string {
  return value.replace(/\.(mdx|md)$/i, "").replace(/\/index$/i, "");
}

function isExternal(value: string): boolean {
  return /^https?:\/\//.test(value) || value.startsWith("mailto:");
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function navigationRecord(navigation: unknown): Record<string, unknown> {
  return navigation && typeof navigation === "object" && !Array.isArray(navigation) ? navigation as Record<string, unknown> : {};
}

function extractGlobalAnchors(navigation: unknown): NavLink[] {
  const global = navigationRecord(navigationRecord(navigation).global);
  const anchors = global.anchors;
  if (!Array.isArray(anchors)) return [];

  return anchors.flatMap((anchor) => {
    if (!anchor || typeof anchor !== "object") return [];
    const record = anchor as Record<string, unknown>;
    const label = firstString(record.anchor, record.label, record.name, record.title);
    const href = firstString(record.href, record.url, record.path);
    return label && href ? [{ label, href }] : [];
  });
}

function extractNavbarLinks(config: MintConfig): NavLink[] {
  const links = config.navbar?.links ?? [];
  return links.flatMap((link) => {
    const label = firstString(link.label);
    const href = firstString(link.href);
    return label && href ? [{ label, href }] : [];
  });
}

function extractNavigationTabs(navigation: unknown): NavLink[] {
  const tabs = navigationRecord(navigation).tabs;
  if (!Array.isArray(tabs)) return [];

  return tabs.flatMap((tab) => {
    if (!tab || typeof tab !== "object") return [];
    const record = tab as Record<string, unknown>;
    const label = firstString(record.tab, record.title, record.name, record.label);
    const firstPage = collectPages(record.groups).at(0) ?? collectPages(record.pages).at(0);
    const href = firstPage ? `/${pageKey(firstPage.path)}` : "#";
    return label ? [{ label, href }] : [];
  });
}

function pageKey(value: string): string {
  return stripExtension(value).replace(/^\/+/, "").replace(/\\/g, "/");
}

function escapeForTypeScript(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

function discoverAssets(dir = root): BuiltAsset[] {
  const entries = readdirSync(dir).sort();
  const assets: BuiltAsset[] = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);

    if (stats.isDirectory()) {
      if (!ignoredDirs.has(entry)) assets.push(...discoverAssets(absolute));
      continue;
    }

    if (!stats.isFile()) continue;
    const contentType = contentTypeForPath(absolute);
    if (!contentType) continue;
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    assets.push({
      route: `/${relative}`,
      contentType,
      base64: readFileSync(absolute).toString("base64")
    });
  }

  return assets;
}

function contentTypeForPath(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return undefined;
  }
}

async function main() {
  const { config, filename } = readConfig();
  const nav = normalizeNavigation(config.navigation);
  const navPagePaths = new Set(nav.flatMap((group) => group.pages.map((page) => pageKey(page.path))));
  const allFiles = discoverMarkdownFiles();
  const filesByKey = new Map(allFiles.map((file) => [pageKey(file), file]));
  const orderedFiles: string[] = [];

  if (navPagePaths.size > 0) {
    for (const pagePath of navPagePaths) {
      const resolved = resolvePagePath(pagePath) ?? filesByKey.get(pagePath);
      if (resolved && !orderedFiles.includes(resolved)) orderedFiles.push(resolved);
    }
  } else {
    orderedFiles.push(...allFiles);
  }

  const pages: BuiltPage[] = [];
  const titleBySource = new Map<string, string>();

  for (const sourcePath of orderedFiles) {
    const absolute = path.join(root, sourcePath);
    const raw = readFileSync(absolute, "utf8");
    const parsed = matter(raw);
    const route = typeof parsed.data.path === "string" ? parsed.data.path : routeFromPath(sourcePath);
    const title = typeof parsed.data.title === "string" ? parsed.data.title : titleFromMarkdown(parsed.content, sourcePath);
    const description = typeof parsed.data.description === "string" ? parsed.data.description : "";
    let html: string;
    try {
      html = await renderMdx(parsed.content, sourcePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to render ${sourcePath}: ${message}`, { cause: error });
    }

    titleBySource.set(pageKey(sourcePath), title);
    pages.push({
      title,
      description,
      route,
      sourcePath,
      html,
      markdown: parsed.content.trim()
    });
  }

  const normalizedNav = nav.length > 0
    ? nav.map((group) => ({
        title: group.title,
        pages: group.pages
          .map((page) => {
            const resolved = resolvePagePath(page.path);
            if (!resolved) return undefined;
            const builtPage = pages.find((candidate) => candidate.sourcePath === resolved);
            if (!builtPage) return undefined;
            return {
              title: page.title ?? titleBySource.get(pageKey(resolved)) ?? humanize(page.path),
              route: builtPage.route
            };
          })
          .filter(Boolean)
      })).filter((group) => group.pages.length > 0)
    : [{ title: "Docs", pages: pages.map((page) => ({ title: page.title, route: page.route })) }];

  const output = {
    site: {
      name: config.name ?? path.basename(root),
      logo: config.logo,
      favicon: config.favicon,
      colors: config.colors ?? {},
      navbar: {
        links: extractNavbarLinks(config),
        primary: config.navbar?.primary?.label && config.navbar?.primary?.href
          ? {
              label: config.navbar.primary.label,
              href: config.navbar.primary.href,
              type: config.navbar.primary.type ?? "button"
            }
          : undefined
      },
      globalAnchors: extractGlobalAnchors(config.navigation)
      ,
      navTabs: extractNavigationTabs(config.navigation)
    },
    configFile: filename,
    nav: normalizedNav,
    pages,
    assets: discoverAssets()
  };

  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    path.join(generatedDir, "content.ts"),
    `/* This file is generated by docsflare build. */\nexport const content = ${escapeForTypeScript(output)} as const;\n`
  );

  console.log(`Built ${pages.length} page(s) from ${path.relative(projectRoot, path.join(root, filename))}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
