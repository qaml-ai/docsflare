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
  basePath?: string;
  /** Built-in Docsflare visual preset. */
  theme?: string;
  appearance?: {
    default?: "system" | "light" | "dark";
    strict?: boolean;
  };
  fonts?: FontsConfig;
  background?: BackgroundConfig;
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

type FontDefinition = {
  family?: string;
  weight?: string | number;
  source?: string;
  format?: "woff" | "woff2";
};

type FontsConfig = FontDefinition & {
  heading?: FontDefinition;
  body?: FontDefinition;
  /** Accepted for code-focused sites while retaining the Mintlify-compatible shape. */
  mono?: FontDefinition;
};

type ThemeValue<T> = T | { light?: T; dark?: T };

type BackgroundConfig = {
  decoration?: "gradient" | "grid" | "windows";
  color?: ThemeValue<string>;
  image?: ThemeValue<string>;
};

type PageRef = {
  title?: string;
  path: string;
};

type OpenApiOperation = {
  specUrl: string;
  spec: Record<string, unknown>;
  method: string;
  path: string;
  tag: string;
  route: string;
  title: string;
  navTitle: string;
  description: string;
  operation: Record<string, unknown>;
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
  updatedAt?: string;
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
  icon?: string;
};

const projectRoot = process.cwd();
const root = process.env.DOCSFLARE_CONTENT_DIR ? path.resolve(process.env.DOCSFLARE_CONTENT_DIR) : path.join(projectRoot, "docs");
const generatedDir = process.env.DOCSFLARE_OUTPUT_DIR ? path.resolve(process.env.DOCSFLARE_OUTPUT_DIR) : path.join(projectRoot, ".docsflare");
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

function collectOpenApiSources(navigation: unknown): string[] {
  const sources = new Set<string>();

  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const source = firstString(record.openapi);
    if (source) sources.add(source);

    for (const key of ["pages", "groups", "tabs", "anchors", "dropdowns", "versions"]) {
      if (record[key]) visit(record[key]);
    }
  }

  visit(navigation);
  return [...sources];
}

async function loadOpenApiOperations(navigation: unknown): Promise<Map<string, OpenApiOperation[]>> {
  const sources = collectOpenApiSources(navigation);
  const operationsBySource = new Map<string, OpenApiOperation[]>();

  for (const source of sources) {
    const spec = await readOpenApiSpec(source);
    operationsBySource.set(source, operationsFromSpec(source, spec));
  }

  return operationsBySource;
}

async function readOpenApiSpec(source: string): Promise<Record<string, unknown>> {
  if (/^https?:\/\//.test(source)) {
    const url = new URL(source);
    if (!url.searchParams.has("format")) url.searchParams.set("format", "json");
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI schema ${source}: ${response.status} ${response.statusText}`);
    }
    return await response.json() as Record<string, unknown>;
  }

  return JSON.parse(readFileSync(path.resolve(root, source), "utf8")) as Record<string, unknown>;
}

function operationsFromSpec(source: string, spec: Record<string, unknown>): OpenApiOperation[] {
  const paths = recordFromUnknown(spec.paths);
  const operations: OpenApiOperation[] = [];

  for (const [operationPath, pathItem] of Object.entries(paths)) {
    const pathRecord = recordFromUnknown(pathItem);
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = recordFromUnknown(pathRecord[method]);
      if (Object.keys(operation).length === 0) continue;
      const tag = firstString(arrayFromUnknown(operation.tags)[0]) ?? firstPathSegment(operationPath);
      const title = firstString(operation.summary, operation.operationId) ?? humanize(operationPath);

      operations.push({
        specUrl: source,
        spec,
        method,
        path: operationPath,
        tag,
        route: "",
        title,
        navTitle: `${method.toUpperCase()} ${title}`,
        description: firstString(operation.description) ?? "",
        operation
      });
    }
  }

  assignOpenApiRoutes(operations);
  return operations.sort((a, b) => a.tag.localeCompare(b.tag) || methodOrder(a.method) - methodOrder(b.method) || a.route.localeCompare(b.route));
}

function assignOpenApiRoutes(operations: OpenApiOperation[]): void {
  const operationsByBaseRoute = new Map<string, OpenApiOperation[]>();

  for (const operation of operations) {
    const baseRoute = openApiBaseRoute(operation);
    operationsByBaseRoute.set(baseRoute, [...operationsByBaseRoute.get(baseRoute) ?? [], operation]);
  }

  const usedRoutes = new Set<string>();
  for (const [baseRoute, groupedOperations] of operationsByBaseRoute) {
    groupedOperations.forEach((operation, index) => {
      const candidate = index === 0 ? baseRoute : openApiMethodRoute(operation);
      operation.route = uniqueOpenApiRoute(candidate, operation, usedRoutes);
    });
  }
}

function openApiBaseRoute(operation: OpenApiOperation): string {
  return `/api-reference/${slugify(operation.tag)}/${slugify(operation.title)}`;
}

function openApiMethodRoute(operation: OpenApiOperation): string {
  return `/api-reference/${slugify(operation.tag)}/${slugify(`${operation.method} ${operation.title}`)}`;
}

function uniqueOpenApiRoute(candidate: string, operation: OpenApiOperation, usedRoutes: Set<string>): string {
  if (!usedRoutes.has(candidate)) {
    usedRoutes.add(candidate);
    return candidate;
  }

  const pathSuffix = slugify(`${operation.method} ${operation.path}`);
  const withPath = `${candidate}-${pathSuffix}`;
  if (!usedRoutes.has(withPath)) {
    usedRoutes.add(withPath);
    return withPath;
  }

  let counter = 2;
  while (usedRoutes.has(`${withPath}-${counter}`)) counter += 1;
  const uniqueRoute = `${withPath}-${counter}`;
  usedRoutes.add(uniqueRoute);
  return uniqueRoute;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstPathSegment(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments[0] === "api" && /^v\d+$/i.test(segments[1] ?? "")) {
    return segments[2] ?? "api";
  }
  return segments[0] ?? "api";
}

function methodOrder(method: string): number {
  return ["get", "post", "put", "patch", "delete"].indexOf(method);
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

function normalizeNavigation(navigation: unknown, openApiOperations: Map<string, OpenApiOperation[]>): NavGroup[] {
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
    const pages = collectPages(record.pages, openApiOperations);
    if (record.openapi) {
      groups.push(...collectOpenApiGroups(record.openapi, inheritedTitle ?? title, openApiOperations));
    }

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

function collectPages(value: unknown, openApiOperations: Map<string, OpenApiOperation[]>): PageRef[] {
  if (!Array.isArray(value)) return [];
  const pages: PageRef[] = [];

  for (const item of value) {
    const page = pageRefFromUnknown(item);
    if (page) {
      pages.push(page);
      continue;
    }

    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (record.openapi) {
        pages.push(...collectOpenApiPageRefs(record.openapi, openApiOperations));
      }
      const nested = record.pages;
      pages.push(...collectPages(nested, openApiOperations));
    }
  }

  return pages;
}

function collectOpenApiPageRefs(source: unknown, openApiOperations: Map<string, OpenApiOperation[]>): PageRef[] {
  const sourceKey = typeof source === "string" ? source : undefined;
  const operations = sourceKey ? openApiOperations.get(sourceKey) ?? [] : [];
  return operations.map((operation) => ({
    title: operation.navTitle,
    path: operation.route.replace(/^\//, "")
  }));
}

function collectOpenApiGroups(source: unknown, inheritedTitle: string | undefined, openApiOperations: Map<string, OpenApiOperation[]>): NavGroup[] {
  const sourceKey = typeof source === "string" ? source : undefined;
  const operations = sourceKey ? openApiOperations.get(sourceKey) ?? [] : [];
  const operationsByTag = new Map<string, OpenApiOperation[]>();

  for (const operation of operations) {
    operationsByTag.set(operation.tag, [...operationsByTag.get(operation.tag) ?? [], operation]);
  }

  return [...operationsByTag.entries()].map(([tag, tagOperations]) => ({
    title: inheritedTitle ? `${inheritedTitle} / ${tag}` : tag,
    pages: tagOperations.map((operation) => ({
      title: operation.navTitle,
      path: operation.route.replace(/^\//, "")
    }))
  }));
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
      remarkPlugins: [remarkGfm, remarkCodeTitles],
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

function remarkCodeTitles() {
  return (tree: unknown) => {
    function visit(node: unknown): void {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.type === "code" && typeof record.meta === "string" && record.meta.trim()) {
        const data = recordFromUnknown(record.data);
        const hProperties = recordFromUnknown(data.hProperties);
        hProperties["data-title"] = record.meta.trim();
        data.hProperties = hProperties;
        record.data = data;
      }
      arrayFromUnknown(record.children).forEach(visit);
    }
    visit(tree);
  };
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

      return line
        .split(/(`+[^`]*`+)/g)
        .map((part) => part.startsWith("`") ? part : part.replace(/[{}]/g, (brace) => (brace === "{" ? "&#123;" : "&#125;")))
        .join("");
    })
    .join("\n");
}

type MdxElementProps = Record<string, unknown> & { children?: ReactNode; title?: string };

function childElements(children: ReactNode): React.ReactElement<MdxElementProps>[] {
  return React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<MdxElementProps>[];
}

function renderTabs({ children }: { children?: ReactNode }): React.ReactElement {
  const tabs = childElements(children);
  return React.createElement(
    "div",
    { className: "mdx-tabs", "data-mdx-tabs": true },
    React.createElement(
      "div",
      { className: "mdx-tab-list", role: "tablist", "aria-label": "Content tabs" },
      tabs.map((tab, index) => React.createElement(
        "button",
        {
          key: `tab-${index}`,
          type: "button",
          className: `mdx-tab-button${index === 0 ? " active" : ""}`,
          role: "tab",
          "aria-selected": index === 0,
          tabIndex: index === 0 ? 0 : -1,
          "data-mdx-tab-button": String(index)
        },
        tab.props.title ?? `Tab ${index + 1}`
      ))
    ),
    tabs.map((tab, index) => React.createElement(
      "section",
      {
        key: `panel-${index}`,
        className: "mdx-tab-panel",
        role: "tabpanel",
        hidden: index !== 0,
        "data-mdx-tab-panel": String(index)
      },
      tab.props.children
    ))
  );
}

function codeLabel(element: React.ReactElement<MdxElementProps>, index: number): string {
  const code = React.isValidElement(element.props.children) ? element.props.children as React.ReactElement<MdxElementProps> : undefined;
  const className = typeof code?.props.className === "string" ? code.props.className : "";
  const language = className.match(/language-([\w-]+)/)?.[1];
  const title = firstString(code?.props["data-title"], code?.props.title);
  return title ?? language ?? `Example ${index + 1}`;
}

function renderCodeGroup({ children }: { children?: ReactNode }): React.ReactElement {
  const examples = childElements(children);
  if (examples.length <= 1) {
    return React.createElement("div", { className: "mdx-code-group" }, children);
  }
  return React.createElement(
    "div",
    { className: "mdx-code-group mdx-tabs", "data-mdx-tabs": true },
    React.createElement(
      "div",
      { className: "mdx-tab-list", role: "tablist", "aria-label": "Code examples" },
      examples.map((example, index) => React.createElement(
        "button",
        {
          key: `code-tab-${index}`,
          type: "button",
          className: `mdx-tab-button${index === 0 ? " active" : ""}`,
          role: "tab",
          "aria-selected": index === 0,
          tabIndex: index === 0 ? 0 : -1,
          "data-mdx-tab-button": String(index)
        },
        codeLabel(example, index)
      ))
    ),
    examples.map((example, index) => React.createElement(
      "div",
      { key: `code-panel-${index}`, className: "mdx-tab-panel", role: "tabpanel", hidden: index !== 0, "data-mdx-tab-panel": String(index) },
      example
    ))
  );
}

function field({ children, name, type, required, deprecated, default: defaultValue, query, path: pathName, body, header, pre, post }: MdxElementProps): React.ReactElement {
  const fieldName = firstString(name, query, pathName, body, header) ?? "field";
  const labels = [...arrayFromUnknown(pre), ...arrayFromUnknown(post)].filter((value): value is string => typeof value === "string");
  return React.createElement(
    "div",
    { className: `mdx-field${deprecated ? " deprecated" : ""}` },
    React.createElement(
      "div",
      { className: "mdx-field-heading" },
      React.createElement("code", null, fieldName),
      type ? React.createElement("span", { className: "mdx-field-type" }, String(type)) : null,
      required ? React.createElement("span", { className: "mdx-badge mdx-badge-required" }, "required") : null,
      deprecated ? React.createElement("span", { className: "mdx-badge" }, "deprecated") : null,
      labels.map((label, index) => React.createElement("span", { className: "mdx-badge", key: index }, label))
    ),
    defaultValue !== undefined ? React.createElement("div", { className: "mdx-field-default" }, "Default: ", React.createElement("code", null, String(defaultValue))) : null,
    React.createElement("div", { className: "mdx-field-body" }, children)
  );
}

function treeItem(kind: "folder" | "file") {
  return ({ children, name }: MdxElementProps) => React.createElement(
    "li",
    { className: `mdx-tree-${kind}` },
    React.createElement("span", null, kind === "folder" ? "▸" : "·", " ", name === undefined ? "" : String(name)),
    children ? React.createElement("ul", null, children) : null
  );
}

function passthrough({ children }: { children?: ReactNode }): React.ReactElement {
  return React.createElement(React.Fragment, null, children);
}

const mdxComponents = {
  CardGroup: ({ children, cols }: { children?: ReactNode; cols?: number }) =>
    React.createElement("div", { className: "mdx-card-group", "data-cols": String(cols ?? 2), style: { "--cols": String(cols ?? 2) } as React.CSSProperties }, children),
  Card: ({ children, title, href, icon, color, cta }: { children?: ReactNode; title?: string; href?: string; icon?: string; color?: string; cta?: string }) => {
    const Tag = href ? "a" : "div";
    return React.createElement(
      Tag,
      { className: "mdx-card", href },
      icon ? React.createElement("span", { className: "mdx-card-icon", style: { color: color ?? undefined } }, iconSvg(icon)) : null,
      React.createElement("strong", null, title),
      React.createElement("div", null, children),
      cta ? React.createElement("span", { className: "mdx-card-cta" }, cta) : null
    );
  },
  Info: callout("info", "Info"),
  Note: callout("note", "Note"),
  Tip: callout("tip", "Tip"),
  Warning: callout("warning", "Warning"),
  Check: callout("check", "Check"),
  Danger: callout("danger", "Danger"),
  Callout: ({ children, icon, color }: MdxElementProps) => React.createElement(
    "aside",
    { className: "mdx-callout mdx-callout-custom", style: color ? { "--callout-color": String(color) } as React.CSSProperties : undefined },
    React.createElement("span", { className: "mdx-callout-icon" }, iconSvg(typeof icon === "string" ? icon : "info")),
    React.createElement("div", null, children)
  ),
  Accordion: ({ children, title, defaultOpen }: MdxElementProps) =>
    React.createElement("details", { className: "mdx-accordion", open: Boolean(defaultOpen) }, React.createElement("summary", null, title), React.createElement("div", null, children)),
  AccordionGroup: ({ children }: { children?: ReactNode }) => React.createElement("div", { className: "mdx-accordion-group" }, children),
  Expandable: ({ children, title, defaultOpen }: MdxElementProps) => React.createElement(
    "details",
    { className: "mdx-expandable", open: Boolean(defaultOpen) },
    React.createElement("summary", null, React.createElement("span", null, "Show ", title ?? "details")),
    React.createElement("div", null, children)
  ),
  Tabs: renderTabs,
  Tab: passthrough,
  Steps: ({ children }: { children?: ReactNode }) => React.createElement("ol", { className: "mdx-steps" }, children),
  Step: ({ children, title, icon }: MdxElementProps) => React.createElement(
    "li",
    { style: icon ? { "--step-icon": `"${String(icon)}"` } as React.CSSProperties : undefined },
    title ? React.createElement("strong", null, title) : null,
    React.createElement("div", null, children)
  ),
  Frame: ({ children, caption }: MdxElementProps) => React.createElement(
    "figure",
    { className: "mdx-frame" },
    children,
    caption ? React.createElement("figcaption", null, String(caption)) : null
  ),
  CodeGroup: renderCodeGroup,
  Columns: ({ children, cols }: { children?: ReactNode; cols?: number }) =>
    React.createElement("div", { className: "mdx-columns", style: { "--cols": String(cols ?? 2) } as React.CSSProperties }, children),
  Column: ({ children }: { children?: ReactNode }) => React.createElement("div", { className: "mdx-column" }, children),
  Panel: ({ children, title, icon }: MdxElementProps) => React.createElement(
    "aside",
    { className: "mdx-panel" },
    title ? React.createElement("strong", null, icon ? React.createElement("span", { className: "mdx-inline-icon" }, iconSvg(String(icon))) : null, title) : null,
    React.createElement("div", null, children)
  ),
  Banner: ({ children }: { children?: ReactNode }) => React.createElement("aside", { className: "mdx-banner" }, children),
  Badge: ({ children, color }: MdxElementProps) => React.createElement("span", { className: "mdx-badge", style: color ? { "--badge-color": String(color) } as React.CSSProperties : undefined }, children),
  Tooltip: ({ children, tip, content }: MdxElementProps) => React.createElement("span", { className: "mdx-tooltip", "data-tooltip": firstString(tip, content) ?? "" }, children),
  Icon: ({ icon, name, color, size }: MdxElementProps) => React.createElement(
    "span",
    { className: "mdx-icon", style: { color: color ? String(color) : undefined, width: size ? String(size) : undefined, height: size ? String(size) : undefined } },
    iconSvg(firstString(icon, name) ?? "code")
  ),
  Color: ({ color, name, value }: MdxElementProps) => React.createElement(
    "span",
    { className: "mdx-color" },
    React.createElement("span", { className: "mdx-color-swatch", style: { background: firstString(color, value) ?? "transparent" } }),
    React.createElement("span", null, firstString(name, color, value))
  ),
  Tile: ({ children, title, href, icon }: MdxElementProps) => {
    const Tag = href ? "a" : "div";
    return React.createElement(Tag, { className: "mdx-tile", href: href ? String(href) : undefined }, icon ? React.createElement("span", { className: "mdx-tile-icon" }, iconSvg(String(icon))) : null, React.createElement("strong", null, title), children);
  },
  TileGroup: ({ children, cols }: MdxElementProps) => React.createElement("div", { className: "mdx-tile-group", style: { "--cols": String(cols ?? 3) } as React.CSSProperties }, children),
  ParamField: field,
  ResponseField: field,
  RequestExample: ({ children }: { children?: ReactNode }) => React.createElement("section", { className: "mdx-example mdx-request-example" }, React.createElement("strong", null, "Request"), renderCodeGroup({ children })),
  ResponseExample: ({ children }: { children?: ReactNode }) => React.createElement("section", { className: "mdx-example mdx-response-example" }, React.createElement("strong", null, "Response"), renderCodeGroup({ children })),
  Tree: ({ children }: { children?: ReactNode }) => React.createElement("div", { className: "mdx-tree" }, React.createElement("ul", null, children)),
  TreeRoot: passthrough,
  TreeFolder: treeItem("folder"),
  TreeFile: treeItem("file"),
  Prompt: ({ children, title }: MdxElementProps) => React.createElement("section", { className: "mdx-prompt" }, title ? React.createElement("strong", null, title) : null, React.createElement("div", null, children)),
  View: passthrough,
  Visibility: passthrough,
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
    info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"],
    note: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M8 13h8", "M8 17h5"],
    tip: ["M9 18h6", "M10 22h4", "M8.5 14.5A6 6 0 1 1 15.5 14.5c-.9.7-1.5 1.5-1.5 2.5h-4c0-1-.6-1.8-1.5-2.5z"],
    check: ["M20 6 9 17l-5-5"],
    "triangle-alert": ["M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"],
    folder: ["M3 5h6l2 2h10v12H3V5z"],
    "folder-open": ["M3 6h6l2 2h10l-2 10H3V6z", "M3 10h18"],
    file: ["M6 2h8l4 4v16H6V2z", "M14 2v5h5"],
    database: ["M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z", "M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5", "M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"],
    cloud: ["M17.5 19H7a5 5 0 0 1-.5-10A7 7 0 0 1 20 11.5 3.5 3.5 0 0 1 17.5 19z"],
    envelope: ["M3 5h18v14H3V5z", "m3 7 9 6 9-6"],
    "layer-group": ["m12 2 9 5-9 5-9-5 9-5z", "m3 12 9 5 9-5", "m3 17 9 5 9-5"],
    "clock-rotate-left": ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"],
    "circle-dot": ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
    seedling: ["M12 22V10", "M12 14C8 14 5 11 5 7c4 0 7 2 7 6", "M12 10c0-4 3-7 7-7 0 4-3 7-7 7"],
    users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
    building: ["M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18", "M9 22v-4h6v4", "M8 6h.01", "M12 6h.01", "M16 6h.01", "M8 10h.01", "M12 10h.01", "M16 10h.01", "M8 14h.01", "M12 14h.01", "M16 14h.01"],
    rocket: [
      "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
      "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
      "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0",
      "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"
    ],
    globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M3 12h18", "M12 3c3 3 3 15 0 18", "M12 3c-3 3-3 15 0 18"],
    "hard-drive": ["M3 6h18l-2 9H5L3 6z", "M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3", "M7 18h.01", "M17 18h.01"],
    plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M6 8h12v4a6 6 0 0 1-12 0V8z"],
    clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
    brain: [
      "M9.5 2A2.5 2.5 0 0 0 7 4.5v.2A4 4 0 0 0 5 12a4 4 0 0 0 2 7.3v.2A2.5 2.5 0 0 0 11.5 21V3.5A1.5 1.5 0 0 0 10 2h-.5z",
      "M14.5 2A2.5 2.5 0 0 1 17 4.5v.2A4 4 0 0 1 19 12a4 4 0 0 1-2 7.3v.2A2.5 2.5 0 0 1 12.5 21V3.5A1.5 1.5 0 0 1 14 2h.5z",
      "M7 9h4",
      "M13 9h4",
      "M7 15h4",
      "M13 15h4"
    ],
    robot: ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M9 13h.01", "M15 13h.01", "M10 17h4"],
    wrench: ["M14.5 5.5a4 4 0 0 0 4 4L9 19l-4-4 9.5-9.5z", "M5 15l-2 2v4h4l2-2"],
    "arrows-spin": ["M21 12a9 9 0 0 1-14.8 6.9L3 16", "M3 21v-5h5", "M3 12A9 9 0 0 1 17.8 5.1L21 8", "M21 3v5h-5"],
    browser: ["M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M3 9h18", "M7 6.5h.01", "M10 6.5h.01", "M13 6.5h.01"],
    "credit-card": ["M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z", "M2 10h20", "M6 15h4"],
    bookmark: ["M7 4h10v16l-5-3-5 3V4z"],
    "chart-line": ["M3 3v18h18", "M7 15l4-4 3 3 5-7", "M7 15h.01", "M11 11h.01", "M14 14h.01", "M19 7h.01"],
    bell: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9", "M10 21h4"],
    "arrows-rotate": ["M20 7h-5V2", "M4 17h5v5", "M18.4 17a8 8 0 0 1-13.9-2", "M5.6 7A8 8 0 0 1 19.5 9"],
    "pen-nib": ["m12 19 7-7 3 3-7 7-3-3z", "m18 13-6-6-9 3-1 8 8-1 3-9z", "M2 22l5-5", "M11 7l4 4"],
    newspaper: ["M4 5h16v14H4V5z", "M8 9h8", "M8 13h8", "M8 17h5", "M5 5v14"],
    code: ["m18 16 4-4-4-4", "m6 8-4 4 4 4", "m14.5 4-5 16"]
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
      React.createElement("span", { className: "mdx-callout-icon" }, iconSvg(kind === "warning" || kind === "danger" ? "triangle-alert" : kind)),
      React.createElement("strong", { className: "sr-only" }, label),
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

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "operation";
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}

function defaultOpenApiMarkdown(openApi: OpenApiOperation): string {
  const methodLabel = openApi.method.toUpperCase();
  const description = openApi.description ? `\n<p class="api-description">${escapeHtml(openApi.description)}</p>` : "";
  const parameters = renderOpenApiParameters(openApi);
  const requestBody = renderOpenApiRequestBody(openApi);
  const response = renderOpenApiResponse(openApi);
  const curl = renderCurlExample(openApi);
  const responseExample = renderResponseExample(openApi);

  return `<div class="api-reference-page">
  <div class="api-reference-main">
    <p class="eyebrow">${escapeHtml(openApi.tag)}</p>
    <h1>${escapeHtml(openApi.title)}</h1>
    ${description}
    <div class="api-route-row">
      <span class="api-method api-method-${openApi.method}">${methodLabel}</span>
      <code>${escapeHtml(openApi.path)}</code>
      <button class="copy-button" type="button" data-copy-value="${escapeHtml(openApi.path)}" aria-label="Copy API path">Copy</button>
    </div>
    ${parameters}
    ${requestBody}
    ${response}
  </div>
  <aside class="api-example-panel">
    <div class="api-example-block">
      <div class="api-example-heading"><span>cURL</span><button class="copy-button copy-button-dark" type="button" data-copy-code aria-label="Copy cURL example">Copy</button></div>
      <pre><code data-api-curl-code data-api-curl-method="${methodLabel}" data-api-curl-path="${escapeHtml(openApi.path)}">${escapeHtml(curl)}</code></pre>
    </div>
    <div class="api-example-block">
      <div class="api-example-heading"><span>200</span><button class="copy-button copy-button-dark" type="button" data-copy-code aria-label="Copy response example">Copy</button></div>
      <pre><code>${escapeHtml(responseExample)}</code></pre>
    </div>
  </aside>
</div>`;
}

function renderOpenApiParameters(openApi: OpenApiOperation): string {
  const operationParameters = arrayFromUnknown(openApi.operation.parameters);
  const pathParameters = operationParameters.filter((parameter) => recordFromUnknown(parameter).in === "path");
  const queryParameters = operationParameters.filter((parameter) => recordFromUnknown(parameter).in === "query");
  const headerParameters = [
    {
      name: "Authorization",
      in: "header",
      required: true,
      description: "API key authentication using Bearer scheme"
    }
  ];
  const sections = [
    parameterSection("Headers", headerParameters),
    parameterSection("Path Parameters", pathParameters),
    parameterSection("Query Parameters", queryParameters)
  ].filter(Boolean);

  return sections.length ? `<section class="api-section">${sections.join("")}</section>` : "";
}

function parameterSection(title: string, parameters: unknown[]): string {
  if (parameters.length === 0) return "";

  return `<h2>${escapeHtml(title)}</h2>
${parameters.map((parameter) => {
  const record = recordFromUnknown(parameter);
  const schema = resolveSchema(record.schema, record);
  const type = schemaTypeLabel(schema);
  const required = record.required === true ? '<span class="api-required">required</span>' : "";
  const description = firstString(record.description) ?? "";
  return `<div class="api-param">
    <div><code>${escapeHtml(firstString(record.name) ?? "parameter")}</code>${required}</div>
    <p>${escapeHtml(type)}${description ? ` - ${escapeHtml(description)}` : ""}</p>
  </div>`;
}).join("")}`;
}

function renderOpenApiRequestBody(openApi: OpenApiOperation): string {
  const requestBody = recordFromUnknown(openApi.operation.requestBody);
  const content = recordFromUnknown(requestBody.content);
  const json = recordFromUnknown(content["application/json"]);
  const schema = resolveSchema(json.schema, openApi.spec);
  if (Object.keys(schema).length === 0) return "";

  return `<section class="api-section">
    <h2>Request Body</h2>
    ${renderSchemaFields(schema, openApi.spec)}
  </section>`;
}

function renderOpenApiResponse(openApi: OpenApiOperation): string {
  const responses = recordFromUnknown(openApi.operation.responses);
  const response = recordFromUnknown(responses["200"] ?? Object.values(responses)[0]);
  const content = recordFromUnknown(response.content);
  const json = recordFromUnknown(content["application/json"]);
  const schema = resolveSchema(json.schema, openApi.spec);
  const description = firstString(response.description);

  if (Object.keys(schema).length === 0 && !description) return "";

  return `<section class="api-section">
    <h2>Response</h2>
    ${description ? `<p>${escapeHtml(description)}</p>` : ""}
    ${renderSchemaFields(schema, openApi.spec)}
  </section>`;
}

function renderSchemaFields(schema: Record<string, unknown>, spec: Record<string, unknown>, depth = 0): string {
  const resolved = resolveSchema(schema, spec);
  const variants = [...arrayFromUnknown(resolved.oneOf), ...arrayFromUnknown(resolved.anyOf)];
  if (variants.length > 0 && depth < 2) {
    const discriminator = recordFromUnknown(resolved.discriminator);
    const discriminatorProperty = firstString(discriminator.propertyName);
    const labels = variants.map((variant, index) => schemaVariantLabel(variant, index));

    return `<div class="api-polymorphic" data-api-polymorphic>
  ${discriminatorProperty ? `<p class="api-schema-note">One of these shapes, selected by <code>${escapeHtml(discriminatorProperty)}</code>.</p>` : ""}
  <label class="api-variant-menu">
    <span>Request shape</span>
    <select data-api-variant-select>
      ${labels.map((label, index) => `<option value="${index}">${escapeHtml(label)}</option>`).join("")}
    </select>
  </label>
${variants.map((variant, index) => {
  const variantSchema = resolveSchema(variant, spec);
  const variantBody = JSON.stringify(sampleFromSchema(variantSchema, spec), null, 2);
  return `<div class="api-variant" data-api-variant-panel="${index}" data-api-variant-body="${escapeHtml(variantBody)}"${index === 0 ? "" : " hidden"}>
    <h3>${escapeHtml(labels[index])}</h3>
    ${renderSchemaFields(variantSchema, spec, depth + 1)}
  </div>`;
}).join("")}
</div>`;
  }

  const combinedSchema = mergeAllOfSchemas(resolved, spec);
  const target = combinedSchema.type === "array" ? resolveSchema(recordFromUnknown(combinedSchema.items), spec) : combinedSchema;
  const properties = recordFromUnknown(target.properties);
  const required = new Set(arrayFromUnknown(target.required).filter((item): item is string => typeof item === "string"));

  if (Object.keys(properties).length === 0) {
    return `<div class="api-param"><div><code>${escapeHtml(schemaTypeLabel(combinedSchema))}</code></div></div>`;
  }

  return Object.entries(properties).slice(0, 18).map(([name, property]) => {
    const propertySchema = resolveSchema(property, spec);
    const description = firstString(propertySchema.description);
    return `<div class="api-param">
      <div><code>${escapeHtml(name)}</code>${required.has(name) ? '<span class="api-required">required</span>' : ""}</div>
      <p>${escapeHtml(schemaTypeLabel(propertySchema))}${description ? ` - ${escapeHtml(description)}` : ""}</p>
    </div>`;
  }).join("");
}

function schemaVariantLabel(schema: unknown, index: number): string {
  const record = recordFromUnknown(schema);
  const ref = firstString(record.$ref);
  if (ref) return humanize(ref.split("/").at(-1) ?? `Variant ${index + 1}`);
  return firstString(record.title) ?? `Variant ${index + 1}`;
}

function mergeAllOfSchemas(schema: Record<string, unknown>, spec: Record<string, unknown>): Record<string, unknown> {
  const allOf = arrayFromUnknown(schema.allOf);
  if (allOf.length === 0) return schema;

  return allOf.reduce<Record<string, unknown>>((merged, item) => {
    const resolved = mergeAllOfSchemas(resolveSchema(item, spec), spec);
    return {
      ...merged,
      ...resolved,
      properties: {
        ...recordFromUnknown(merged.properties),
        ...recordFromUnknown(resolved.properties)
      },
      required: [
        ...arrayFromUnknown(merged.required),
        ...arrayFromUnknown(resolved.required)
      ]
    };
  }, { type: "object" });
}

function renderCurlExample(openApi: OpenApiOperation, bodyExample = renderRequestBodyExample(openApi)): string {
  const method = openApi.method.toUpperCase();
  const hasBody = bodyExample.length > 0;
  return [
    `curl --request ${method} \\`,
    `  --url https://api.camelai.com${openApi.path} \\`,
    "  --header 'Authorization: Bearer <token>'" + (hasBody ? " \\" : ""),
    hasBody ? "  --header 'Content-Type: application/json' \\" : "",
    hasBody ? `  --data ${shellSingleQuote(bodyExample)}` : ""
  ].filter(Boolean).join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderRequestBodyExample(openApi: OpenApiOperation): string {
  const requestBody = recordFromUnknown(openApi.operation.requestBody);
  const content = recordFromUnknown(requestBody.content);
  const json = recordFromUnknown(content["application/json"]);
  const schema = resolveSchema(json.schema, openApi.spec);
  if (Object.keys(schema).length === 0) return "";

  return JSON.stringify(sampleFromSchema(schema, openApi.spec), null, 2);
}

function renderResponseExample(openApi: OpenApiOperation): string {
  const responses = recordFromUnknown(openApi.operation.responses);
  const response = recordFromUnknown(responses["200"] ?? Object.values(responses)[0]);
  const content = recordFromUnknown(response.content);
  const json = recordFromUnknown(content["application/json"]);
  const schema = resolveSchema(json.schema, openApi.spec);
  return JSON.stringify(sampleFromSchema(schema, openApi.spec), null, 2);
}

function resolveSchema(value: unknown, spec: Record<string, unknown>): Record<string, unknown> {
  const schema = recordFromUnknown(value);
  const ref = firstString(schema.$ref);
  if (!ref?.startsWith("#/")) return schema;

  return ref.slice(2).split("/").reduce<unknown>((current, segment) => recordFromUnknown(current)[segment], spec) as Record<string, unknown>;
}

function sampleFromSchema(schema: Record<string, unknown>, spec: Record<string, unknown>, depth = 0, hint = ""): unknown {
  const resolved = resolveSchema(schema, spec);
  if (depth > 4) return "<unknown>";
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum)) return resolved.enum[0];
  const variant = arrayFromUnknown(resolved.oneOf)[0] ?? arrayFromUnknown(resolved.anyOf)[0];
  if (variant) return sampleFromSchema(recordFromUnknown(variant), spec, depth + 1, hint);
  if (arrayFromUnknown(resolved.allOf).length > 0) return sampleFromSchema(mergeAllOfSchemas(resolved, spec), spec, depth + 1, hint);

  if (resolved.type === "array") {
    return [sampleFromSchema(recordFromUnknown(resolved.items), spec, depth + 1, hint)];
  }

  if (resolved.type === "object" || resolved.properties) {
    const properties = recordFromUnknown(resolved.properties);
    return Object.fromEntries(Object.entries(properties).slice(0, 12).map(([name, property]) => [name, sampleFromSchema(recordFromUnknown(property), spec, depth + 1, name)]));
  }

  if (Array.isArray(resolved.const) && resolved.const.length > 0) return resolved.const[0];
  if (resolved.const !== undefined) return resolved.const;
  if (resolved.format === "date-time") return "2023-11-07T05:31:56Z";
  if (resolved.format === "date") return "2023-11-07";
  if (resolved.format === "uuid") return "123e4567-e89b-12d3-a456-426614174000";
  if (resolved.type === "integer" || resolved.type === "number") return 123;
  if (resolved.type === "boolean") return true;
  if (resolved.type === "string") return sampleStringForSchema(resolved, hint);
  if (hint.toLowerCase().includes("recommendations")) return ["What changed in revenue last month?"];
  return "<unknown>";
}

function sampleStringForSchema(schema: Record<string, unknown>, hint = ""): string {
  const rawDescription = firstString(schema.description) ?? "";
  const title = firstString(schema.title)?.toLowerCase() ?? "";
  const description = rawDescription.toLowerCase();
  const combined = `${hint.toLowerCase()} ${title} ${description}`;
  const requiredLiteral = rawDescription.match(/must be [`'"]?([a-z0-9_-]+)[`'"]?/i)?.[1];
  if (requiredLiteral) return requiredLiteral;

  if (combined.includes("email")) return "user@example.com";
  if (combined.includes("url") || schema.format === "uri") return "https://example.com";
  if (combined.includes("password")) return "secure-password";
  if (combined.includes("connection_string")) return "postgresql://db_user:secure-password@db.example.com:5432/analytics";
  if (combined.includes("schema")) return "public";
  if (combined.includes("color")) return "#2563eb";
  if (combined.includes("start_message")) return "Ask a question about your data";
  if (combined.includes("hostname") || combined.includes("host")) return "db.example.com";
  if (combined.includes("username") || combined.includes("user")) return "db_user";
  if (combined.includes("database")) return "analytics";
  if (combined.includes("account")) return "production";
  if (combined.includes("name")) return "Production";
  if (combined.includes("query")) return "SELECT * FROM orders LIMIT 10";
  if (combined.includes("title")) return "Monthly revenue";
  if (combined.includes("key")) return "key_123";
  return "<string>";
}

function schemaTypeLabel(schema: Record<string, unknown>): string {
  if (arrayFromUnknown(schema.oneOf).length > 0) return "oneOf";
  if (arrayFromUnknown(schema.anyOf).length > 0) return "anyOf";
  if (arrayFromUnknown(schema.allOf).length > 0) return "object";
  const type = firstString(schema.type) ?? (schema.properties ? "object" : "any");
  const format = firstString(schema.format);
  const enumValues = arrayFromUnknown(schema.enum).filter((value): value is string => typeof value === "string");
  if (enumValues.length > 0) return `enum<${type}>: ${enumValues.join(", ")}`;
  return format ? `${type}<${format}>` : type;
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
    const icon = firstString(record.icon);
    return label && href ? [{ label, href, ...(icon ? { icon } : {}) }] : [];
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

function extractNavigationTabs(navigation: unknown, openApiOperations: Map<string, OpenApiOperation[]>): NavLink[] {
  const tabs = navigationRecord(navigation).tabs;
  if (!Array.isArray(tabs)) return [];

  return tabs.flatMap((tab) => {
    if (!tab || typeof tab !== "object") return [];
    const record = tab as Record<string, unknown>;
    const label = firstString(record.tab, record.title, record.name, record.label);
    const firstPage = collectPages(record.groups, openApiOperations).at(0) ?? collectPages(record.pages, openApiOperations).at(0);
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
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return undefined;
  }
}

function rewriteRelativeCssUrls(css: string, stylesheetPath: string): string {
  return css.replace(/url\(\s*(?:(["'])(.*?)\1|([^'"\)]*))\s*\)/gi, (match, quote: string | undefined, quoted: string | undefined, unquoted: string | undefined) => {
    const value = (quoted ?? unquoted ?? "").trim();
    if (!value || value.startsWith("/") || value.startsWith("//") || value.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(value)) {
      return match;
    }

    const suffixIndex = value.search(/[?#]/);
    const pathname = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? "" : value.slice(suffixIndex);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(stylesheetPath), pathname.replace(/\\/g, "/")));
    if (resolved === ".." || resolved.startsWith("../")) {
      throw new Error(`Stylesheet ${stylesheetPath} references a URL outside the content directory: ${value}`);
    }

    const delimiter = quote ?? "";
    return `url(${delimiter}/${resolved}${suffix}${delimiter})`;
  });
}

/**
 * Loads project-authored stylesheets in a stable order. Symlinks and generated or
 * dependency directories are skipped so a content tree cannot make the build read
 * CSS from outside its root.
 */
function discoverCustomCss(): string {
  const stylesheets: Array<{ relative: string; css: string }> = [];
  const generatedOrDependencyDirs = new Set([".git", ".wrangler", ".docsflare", "node_modules"]);

  function visit(currentDir: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!generatedOrDependencyDirs.has(entry.name)) visit(absolute);
        continue;
      }

      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".css") continue;
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (relative.startsWith("../") || path.isAbsolute(relative)) {
        throw new Error(`Refusing to read stylesheet outside the content directory: ${absolute}`);
      }
      stylesheets.push({ relative, css: rewriteRelativeCssUrls(readFileSync(absolute, "utf8"), relative) });
    }
  }

  visit(root);
  return stylesheets
    .sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)
    .map(({ relative, css }) => `/* ${relative.replace(/\*\//g, "* / ")} */\n${css}`)
    .join("\n\n");
}

async function main() {
  const { config, filename } = readConfig();
  const openApiOperations = await loadOpenApiOperations(config.navigation);
  const nav = normalizeNavigation(config.navigation, openApiOperations);
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
    const updatedAt = pageUpdatedAt(parsed.data.updated ?? parsed.data.lastModified, statSync(absolute).mtime);
    const markdown = parsed.content.trim();
    let html: string;
    try {
      html = await renderMdx(markdown, sourcePath);
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
      updatedAt,
      html,
      markdown
    });
  }

  const virtualRoutes = new Set(pages.map((page) => pageKey(page.route)));
  for (const operation of [...openApiOperations.values()].flat()) {
    if (virtualRoutes.has(pageKey(operation.route))) continue;
    const sourcePath = `openapi:${operation.method.toUpperCase()} ${operation.path}`;
    const markdown = defaultOpenApiMarkdown(operation);

    virtualRoutes.add(pageKey(operation.route));
    pages.push({
      title: operation.title,
      description: operation.description,
      route: operation.route,
      sourcePath,
      html: markdown,
      markdown
    });
  }

  const normalizedNav = nav.length > 0
    ? nav.map((group) => ({
        title: group.title,
        pages: group.pages
          .map((page) => {
            const resolved = resolvePagePath(page.path);
            const builtPage = resolved
              ? pages.find((candidate) => candidate.sourcePath === resolved)
              : pages.find((candidate) => pageKey(candidate.route) === pageKey(page.path));
            if (!builtPage) return undefined;
            return {
              title: page.title ?? (resolved ? titleBySource.get(pageKey(resolved)) : undefined) ?? builtPage.title ?? humanize(page.path),
              route: builtPage.route
            };
          })
          .filter(Boolean)
      })).filter((group) => group.pages.length > 0)
    : [{ title: "Docs", pages: pages.map((page) => ({ title: page.title, route: page.route })) }];

  const output = {
    site: {
      name: config.name ?? path.basename(root),
      basePath: firstString(process.env.DOCSFLARE_BASE_PATH, config.basePath),
      logo: config.logo,
      favicon: config.favicon,
      colors: config.colors ?? {},
      theme: config.theme,
      appearance: config.appearance,
      fonts: config.fonts,
      background: config.background,
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
      navTabs: extractNavigationTabs(config.navigation, openApiOperations)
    },
    configFile: filename,
    nav: normalizedNav,
    pages,
    assets: discoverAssets(),
    customCss: discoverCustomCss()
  };

  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    path.join(generatedDir, "content.ts"),
    `/* This file is generated by docsflare build. */\nexport const content = ${escapeForTypeScript(output)} as const;\n`
  );

  console.log(`Built ${pages.length} page(s) from ${path.relative(projectRoot, path.join(root, filename))}.`);
}

function pageUpdatedAt(frontmatterValue: unknown, fileModifiedAt: Date): string {
  const candidate = frontmatterValue instanceof Date
    ? frontmatterValue
    : typeof frontmatterValue === "string" || typeof frontmatterValue === "number"
      ? new Date(frontmatterValue)
      : fileModifiedAt;
  return Number.isNaN(candidate.getTime()) ? fileModifiedAt.toISOString() : candidate.toISOString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
