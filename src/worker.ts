import { content } from "./generated/content";

type GeneratedContent = {
  site: {
    name: string;
    logo?: string | { light?: string; dark?: string };
    favicon?: string;
    colors: {
      primary?: string;
      light?: string;
      dark?: string;
    };
    navbar?: {
      links?: Array<{ label: string; href: string }>;
      primary?: { label: string; href: string; type?: string };
    };
    globalAnchors?: Array<{ label: string; href: string; icon?: string }>;
    navTabs?: Array<{ label: string; href: string }>;
  };
  nav: Array<{
    title: string;
    pages: Array<{
      title: string;
      route: string;
    }>;
  }>;
  pages: Array<{
    title: string;
    description: string;
    route: string;
    sourcePath: string;
    html: string;
    markdown: string;
  }>;
  assets: Array<{
    route: string;
    contentType: string;
    base64: string;
  }>;
};

type AiSearchChunk = {
  id?: string;
  score?: number;
  text?: string;
  item?: {
    key?: string;
    metadata?: Record<string, unknown>;
  };
};

type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
};

type AiSearchBinding = {
  search(input: {
    query?: string;
    messages?: ChatMessage[];
    ai_search_options?: Record<string, unknown>;
  }): Promise<{ chunks?: AiSearchChunk[] }>;
  chatCompletions?(input: {
    messages: ChatMessage[];
    model?: string;
    stream?: boolean;
    ai_search_options?: Record<string, unknown>;
  }): Promise<{
    choices?: Array<{ message?: { role?: string; content?: string } }>;
    chunks?: AiSearchChunk[];
  }>;
};

type Env = {
  DOCS_SEARCH?: AiSearchBinding;
};

const docsContent = content as unknown as GeneratedContent;

type Page = GeneratedContent["pages"][number];
type Asset = GeneratedContent["assets"][number];

const pages = [...docsContent.pages];
const pageByRoute = new Map(pages.map((page) => [normalizeRoute(page.route), page]));
const assetByRoute = new Map((docsContent.assets ?? []).map((asset) => [normalizeRoute(asset.route), asset]));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const markdownPath = isMarkdownPath(url.pathname);
    const route = normalizeRoute(markdownPath ? stripMarkdownExtension(url.pathname) : url.pathname);

    if (route === "/api/search") {
      return handleSearch(request, env, ctx);
    }

    if (route === "/api/chat") {
      return handleChat(request, env);
    }

    if (route === "/sitemap.xml") {
      return xmlResponse(renderSitemap(url.origin));
    }

    if (route === "/llms.txt") {
      return textResponse(renderLlmsTxt(url.origin), "text/plain; charset=utf-8");
    }

    if (route === "/robots.txt") {
      return textResponse(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, "text/plain; charset=utf-8");
    }

    const asset = assetByRoute.get(route);
    if (asset) {
      return assetResponse(asset);
    }

    const page = pageByRoute.get(route) ?? (route === "/" ? pages[0] : undefined);
    const initialTheme = themeFromCookie(request.headers.get("cookie"));

    if (!page) {
      return htmlResponse(renderShell(undefined, url, 404, initialTheme), 404);
    }

    if (wantsMarkdown(request, markdownPath)) {
      return markdownResponse(renderPageMarkdown(page, url.origin));
    }

    return htmlResponse(renderShell(page, url, 200, initialTheme), 200);
  }
};

async function handleSearch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let query = url.searchParams.get("q")?.trim() ?? "";

  if (request.method === "POST") {
    const body = await request.json<{ query?: string }>().catch((): { query?: string } => ({}));
    query = body.query?.trim() ?? query;
  }

  if (!query) {
    return jsonResponse({ results: [] });
  }

  if (env.DOCS_SEARCH?.search) {
    const cacheKey = new Request(`${url.origin}/api/search?q=${encodeURIComponent(query.toLowerCase())}`);
    const searchCache = await caches.open("docsflare-search");

    if (request.method === "GET") {
      const cached = await searchCache.match(cacheKey);
      if (cached) return cached;
    }

    try {
      const response = await env.DOCS_SEARCH.search({
        query,
        ai_search_options: {
          retrieval: {
            retrieval_type: "hybrid",
            max_num_results: 8
          }
        }
      });

      const results = (response.chunks ?? []).map((chunk) => resultFromAiSearchChunk(chunk));
      const payload = jsonResponse(
        { provider: "cloudflare-ai-search", results },
        { "cache-control": "public, max-age=300, s-maxage=300" }
      );

      if (request.method === "GET") {
        ctx.waitUntil(searchCache.put(cacheKey, payload.clone()));
      }

      return payload;
    } catch (error) {
      console.warn("Cloudflare AI Search failed, falling back to static search", error);
    }
  }

  return jsonResponse({ provider: "static-fallback", results: localSearch(query) });
}

function resultFromAiSearchChunk(chunk: AiSearchChunk) {
  const metadata = chunk.item?.metadata ?? {};
  const metadataPath = stringFromUnknown(metadata.path) ?? stringFromUnknown(metadata.url);
  const keyPath = chunk.item?.key ? sourceKeyToRoute(chunk.item.key) : undefined;
  const url = metadataPath ?? keyPath ?? "/";
  const matchingPage = pages.find((page) => normalizeRoute(page.route) === normalizeRoute(url));

  return {
    title: stringFromUnknown(metadata.title) ?? matchingPage?.title ?? chunk.item?.key ?? "Result",
    url,
    excerpt: excerpt(chunk.text ?? matchingPage?.description ?? "", 220),
    score: chunk.score ?? null
  };
}

function localSearch(query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return pages
    .map((page) => {
      const haystack = `${page.title} ${page.description} ${page.markdown}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { page, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ page, score }) => ({
      title: page.title,
      url: page.route,
      excerpt: excerpt(page.description || stripMdx(page.markdown), 220),
      score
    }));
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { "cache-control": "no-store" }, 405);
  }

  const body = await request.json<{ messages?: Array<{ role?: string; content?: string }> }>().catch((): { messages?: Array<{ role?: string; content?: string }> } => ({}));
  const messages = normalizeChatMessages(body.messages);
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  if (!lastUserMessage.trim()) {
    return jsonResponse({ error: "Missing user message" }, { "cache-control": "no-store" }, 400);
  }

  if (env.DOCS_SEARCH?.chatCompletions) {
    try {
      const response = await env.DOCS_SEARCH.chatCompletions({
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        messages: [
          {
            role: "system",
            content: `You are the ${docsContent.site.name} documentation assistant. Answer only from the retrieved documentation context. If the docs do not contain the answer, say you could not find it in the docs. Keep answers concise and include relevant doc links when useful.`
          },
          ...messages
        ],
        ai_search_options: {
          retrieval: {
            retrieval_type: "hybrid",
            max_num_results: 6
          },
          query_rewrite: {
            enabled: true
          },
          cache: {
            enabled: true,
            cache_threshold: "close_enough"
          }
        }
      });

      const answer = response.choices?.[0]?.message?.content?.trim() ?? "";
      return jsonResponse({
        provider: "cloudflare-ai-search-chat-completions",
        answer: answer || "I could not find an answer in the docs.",
        sources: sourceResultsFromChunks(response.chunks ?? [])
      });
    } catch (error) {
      console.warn("Cloudflare AI Search chat completions failed, falling back to source results", error);
    }
  }

  const sources = localSearch(lastUserMessage).slice(0, 4);
  return jsonResponse({
    provider: "static-fallback",
    answer: sources.length
      ? "I could not generate an AI answer locally, but these docs look relevant."
      : "I could not find a matching page in the docs.",
    sources
  });
}

function normalizeChatMessages(messages: Array<{ role?: string; content?: string }> | undefined): ChatMessage[] {
  const allowedRoles = new Set(["user", "assistant"] as const);
  return (messages ?? [])
    .filter((message): message is { role: "user" | "assistant"; content: string } =>
      allowedRoles.has(message.role as "user" | "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    )
    .slice(-10)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 4000)
    }));
}

function sourceResultsFromChunks(chunks: AiSearchChunk[]) {
  const seen = new Set<string>();
  return chunks.flatMap((chunk) => {
    const result = resultFromAiSearchChunk(chunk);
    const key = normalizeRoute(result.url);
    if (seen.has(key)) return [];
    seen.add(key);
    return [result];
  }).slice(0, 5);
}

function renderShell(page: Page | undefined, url: URL, status = 200, initialTheme?: "dark" | "light"): string {
  const title = page ? `${page.title} - ${docsContent.site.name}` : `Not found - ${docsContent.site.name}`;
  const description = page?.description ?? `${docsContent.site.name} documentation`;
  const themeAttribute = initialTheme ? ` data-theme="${initialTheme}"` : "";
  const themeStyle = initialTheme ? ` style="background:${initialTheme === "dark" ? "#0d1117" : "#fbfcfd"};color-scheme:${initialTheme}"` : "";
  const currentPath = page?.route ?? url.pathname;

  return `<!doctype html>
<html lang="en"${themeAttribute}${themeStyle}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  ${docsContent.site.favicon ? `<link rel="icon" href="${escapeHtml(docsContent.site.favicon)}">` : ""}
  <style>
    html { background: #fbfcfd; color-scheme: light; }
    html[data-theme="dark"] { background: #0d1117; color-scheme: dark; }
    @media (prefers-color-scheme: dark) {
      html:not([data-theme="light"]) { background: #0d1117; color-scheme: dark; }
    }
  </style>
  <script>
    (function () {
      const darkBg = "#0d1117";
      const lightBg = "#fbfcfd";
      let theme;
      try { theme = localStorage.getItem("docsflare-theme"); } catch {}
      theme = theme || document.cookie.match(/(?:^|; )docsflare-theme=(dark|light)/)?.[1];
      theme = theme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      theme = theme === "dark" ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.background = theme === "dark" ? darkBg : lightBg;
      document.documentElement.style.colorScheme = theme;
      document.cookie = "docsflare-theme=" + theme + "; path=/; max-age=31536000; SameSite=Lax";
    })();
  </script>
  <style>${css()}</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/">
        ${renderBrand()}
      </a>
      <div class="mobile-icons">
        <button class="mobile-search" type="button" data-open-search aria-label="Search"></button>
        <button class="theme-toggle mobile-theme" type="button" data-theme-toggle aria-label="Switch to dark theme" title="Switch to dark theme">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"></path>
          </svg>
        </button>
        <button class="mobile-menu" type="button" data-toggle-mobile-nav aria-controls="site-sidebar" aria-expanded="false" aria-label="Menu"><span></span></button>
      </div>
      <div class="top-actions">
        ${renderExternalLinks()}
        ${docsContent.site.navbar?.primary ? `<a class="primary-action" href="${escapeHtml(docsContent.site.navbar.primary.href)}">${escapeHtml(docsContent.site.navbar.primary.label)}</a>` : ""}
        <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to dark theme" title="Switch to dark theme">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"></path>
          </svg>
        </button>
      </div>
      <button class="search-trigger top-search" type="button" data-open-search>
        <span>Find docs</span>
        <kbd>Cmd K</kbd>
      </button>
    </div>
    <nav class="top-tabs" aria-label="Documentation sections">${renderTopTabs(currentPath)}</nav>
    ${renderMobileCrumb(currentPath, page)}
  </header>
  <div class="app">
    <div class="mobile-nav-overlay" hidden data-mobile-nav-overlay data-close-mobile-nav></div>
    <aside class="sidebar" id="site-sidebar">
      <button class="search-trigger" type="button" data-open-search>
        <span>Find docs</span>
        <kbd>/</kbd>
      </button>
      ${renderSidebarAnchors()}
      <nav>${renderNav(currentPath)}</nav>
    </aside>
    <main class="main">
      ${page ? renderArticle(page) : renderNotFound(status)}
    </main>
  </div>
  <div class="search-panel" hidden data-search-panel>
    <div class="search-dialog">
      <div class="search-box">
        <input data-search-input placeholder="Search docs..." autocomplete="off">
        <button type="button" data-close-search aria-label="Close search">Esc</button>
      </div>
      <div class="search-results" data-search-results></div>
    </div>
  </div>
  <button class="chat-launcher" type="button" data-open-chat>Ask docs</button>
  <div class="chat-panel" hidden data-chat-panel>
    <div class="chat-dialog">
      <div class="chat-header">
        <div>
          <strong>Ask the docs</strong>
          <span>Answers from Cloudflare AI Search</span>
        </div>
        <button type="button" data-close-chat aria-label="Close chat">Esc</button>
      </div>
      <div class="chat-messages" data-chat-messages>
        <div class="chat-message assistant">Ask a question about these docs.</div>
      </div>
      <form class="chat-form" data-chat-form>
        <textarea data-chat-input rows="1" placeholder="Ask about camelAI..."></textarea>
        <button type="submit">Send</button>
      </form>
    </div>
  </div>
  <script type="application/json" id="docs-search-index">${renderSearchIndexJson()}</script>
  <script>${clientScript()}</script>
</body>
</html>`;
}

function renderSearchIndexJson(): string {
  return JSON.stringify(
    pages.map((page) => ({
      title: page.title,
      url: page.route,
      description: page.description,
      text: excerpt(stripMdx(page.markdown), 1800)
    }))
  ).replace(/</g, "\\u003c");
}

function renderBrand(): string {
  const logo = docsContent.site.logo;
  const logoPath = typeof logo === "string" ? logo : undefined;

  if (logoPath) {
    return `<img class="brand-logo" src="${escapeHtml(logoPath)}" alt="${escapeHtml(docsContent.site.name)}">`;
  }

  if (typeof logo === "object" && (logo.light || logo.dark)) {
    if (logo.light && logo.dark && logo.light !== logo.dark) {
      return `<img class="brand-logo brand-logo-light" src="${escapeHtml(logo.light)}" alt="${escapeHtml(docsContent.site.name)}"><img class="brand-logo brand-logo-dark" src="${escapeHtml(logo.dark)}" alt="${escapeHtml(docsContent.site.name)}">`;
    }

    const singleLogoPath = logo.light ?? logo.dark;
    if (singleLogoPath) {
      return `<img class="brand-logo" src="${escapeHtml(singleLogoPath)}" alt="${escapeHtml(docsContent.site.name)}">`;
    }
  }

  return `<span class="brand-mark">${escapeHtml(docsContent.site.name.slice(0, 1))}</span><span>${escapeHtml(docsContent.site.name)}</span>`;
}

function renderArticle(page: Page): string {
  const isApiPage = page.sourcePath.startsWith("openapi:");
  const pageIndex = pages.findIndex((candidate) => candidate.route === page.route);
  const previous = pages[pageIndex - 1];
  const next = pages[pageIndex + 1];
  const sectionLabel = currentSectionLabel(page.route);

  return `<article class="doc${isApiPage ? " api-doc" : ""}">
    ${isApiPage ? "" : `<header>
      <p class="eyebrow">${escapeHtml(sectionLabel ?? page.sourcePath)}</p>
      <h1>${escapeHtml(page.title)}</h1>
      ${page.description ? `<p class="description">${escapeHtml(page.description)}</p>` : ""}
    </header>`}
    <div class="content">${isApiPage ? page.html : stripLeadingH1(page.html)}</div>
    <footer class="pager">
      ${previous ? `<a href="${previous.route}"><span>Previous</span>${escapeHtml(previous.title)}</a>` : "<span></span>"}
      ${next ? `<a href="${next.route}"><span>Next</span>${escapeHtml(next.title)}</a>` : ""}
    </footer>
  </article>
  ${renderTableOfContents(page)}`;
}

function renderNotFound(status: number): string {
  return `<article class="doc">
    <header>
      <p class="eyebrow">${status}</p>
      <h1>Page not found</h1>
      <p class="description">The requested page does not exist in this documentation build.</p>
    </header>
  </article>`;
}

function renderNav(currentPath: string): string {
  const groups = navGroupsForPath(currentPath);
  const currentRoute = normalizeRoute(currentPath);

  return groups
    .map((group) => {
      const groupTitle = groupDisplayTitle(group.title);
      const activeGroup = group.pages.some((page) => normalizeRoute(page.route) === currentRoute);
      const apiReferenceGroup = groupTabTitle(group.title).toLowerCase().includes("api reference");
      const showPages = !apiReferenceGroup || activeGroup;
      const heading = apiReferenceGroup && group.pages[0]
        ? `<a href="${escapeHtml(group.pages[0].route)}">${escapeHtml(groupTitle)}</a>`
        : escapeHtml(groupTitle);

      return `<section class="${apiReferenceGroup ? "api-nav-section" : ""}">
        <h2>${heading}</h2>
        ${showPages ? group.pages
          .map((page) => {
            const active = currentRoute === normalizeRoute(page.route) ? "active" : "";
            return renderNavLink(page, active);
          })
          .join("") : ""}
      </section>`;
    })
    .join("");
}

function renderNavLink(page: { title: string; route: string }, active: string): string {
  const operation = apiOperationTitle(page.title);
  if (!operation) {
    return `<a class="${active}" href="${page.route}">${escapeHtml(page.title)}</a>`;
  }

  const method = operation.method.toLowerCase();
  return `<a class="${active} api-operation-link" href="${page.route}">
    <span class="api-nav-method api-method-${method}">${escapeHtml(operation.method)}</span>
    <span>${escapeHtml(operation.title)}</span>
  </a>`;
}

function apiOperationTitle(title: string): { method: string; title: string } | undefined {
  const match = title.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(.+)$/);
  return match ? { method: match[1], title: match[2] } : undefined;
}

function navGroupsForPath(currentPath: string): GeneratedContent["nav"] {
  const activeTab = currentTabTitle(currentPath) ?? firstTabTitle();
  const scopedGroups = docsContent.nav.filter((group) => groupTabTitle(group.title) === activeTab);
  return scopedGroups.length > 0 ? scopedGroups : docsContent.nav;
}

function renderTopTabs(currentPath: string): string {
  const inferredTabs = [...new Set(docsContent.nav.map((group) => groupTabTitle(group.title)))].map((label) => {
    const firstPage = docsContent.nav.find((group) => groupTabTitle(group.title) === label)?.pages[0];
    return { label, href: firstPage?.route ?? "#" };
  });
  const tabs = docsContent.site.navTabs && docsContent.site.navTabs.length > 0 ? docsContent.site.navTabs : inferredTabs;
  const activeTab = currentTabTitle(currentPath) ?? tabs[0]?.label;

  return tabs
    .map((tab) => {
      const active = activeTab === tab.label ? "active" : "";
      return `<a class="${active}" href="${escapeHtml(tab.href)}">${escapeHtml(tab.label)}</a>`;
    })
    .join("");
}

function renderExternalLinks(): string {
  const links = docsContent.site.navbar?.links ?? [];

  return links.map((link) => `<a class="top-link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
}

function renderSidebarAnchors(): string {
  const links = docsContent.site.globalAnchors ?? [];
  if (links.length === 0) return "";

  return `<div class="sidebar-anchors">
    ${links.map((link) => `<a href="${escapeHtml(link.href)}"><span class="sidebar-anchor-icon">${iconForAnchor(link)}</span>${escapeHtml(link.label)}</a>`).join("")}
  </div>`;
}

function renderMobileCrumb(currentPath: string, page: Page | undefined): string {
  const section = currentSectionLabel(currentPath) ?? currentTabTitle(currentPath) ?? "Docs";
  return `<div class="mobile-crumb">
    <button class="mobile-crumb-menu" type="button" data-toggle-mobile-nav aria-controls="site-sidebar" aria-expanded="false" aria-label="Menu"><span class="mobile-menu-lines"></span></button>
    <span>${escapeHtml(section)}</span>
    <span class="mobile-separator">/</span>
    <strong>${escapeHtml(page?.title ?? "Not found")}</strong>
  </div>`;
}

function themeFromCookie(cookie: string | null): "dark" | "light" | undefined {
  const theme = cookie?.match(/(?:^|; )docsflare-theme=(dark|light)(?:;|$)/)?.[1];
  return theme === "dark" || theme === "light" ? theme : undefined;
}

function iconForAnchor(link: { label: string; icon?: string }): string {
  const icon = link.icon ?? iconNameForLabel(link.label);
  return iconSvg(icon);
}

function iconNameForLabel(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("api") || lower.includes("console")) return "code";
  if (lower.includes("legacy")) return "clock-rotate-left";
  return "browser";
}

function iconSvg(icon: string): string {
  const attrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

  if (icon === "code") {
    return `<svg ${attrs}><path d="m16 18 6-6-6-6"></path><path d="m8 6-6 6 6 6"></path></svg>`;
  }

  if (icon === "clock-rotate-left" || icon === "history") {
    return `<svg ${attrs}><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path><path d="M12 7v5l3 2"></path></svg>`;
  }

  if (icon === "external-link") {
    return `<svg ${attrs}><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>`;
  }

  return `<svg ${attrs}><rect width="18" height="16" x="3" y="4" rx="2"></rect><path d="M3 9h18"></path><path d="M7 6.5h.01"></path><path d="M10 6.5h.01"></path><path d="M13 6.5h.01"></path></svg>`;
}

function renderTableOfContents(page: Page): string {
  if (page.sourcePath.startsWith("openapi:")) return "";

  const headings = Array.from(page.html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g))
    .map((match) => ({
      depth: Number(match[1]),
      id: match[2],
      title: decodeHtmlEntities(stripTags(match[3])).replace(/^#\s*/, "").trim()
    }))
    .filter((heading) => heading.title.length > 0)
    .slice(0, 12);

  if (headings.length === 0) return `<aside class="toc" aria-label="On this page"></aside>`;

  return `<aside class="toc" aria-label="On this page">
    <p>On this page</p>
    ${headings.map((heading) => `<a class="depth-${heading.depth}" href="#${escapeHtml(heading.id)}">${escapeHtml(heading.title)}</a>`).join("")}
  </aside>`;
}

function currentTabTitle(currentPath: string): string | undefined {
  const route = normalizeRoute(currentPath);
  return docsContent.nav.find((group) => group.pages.some((page) => normalizeRoute(page.route) === route))
    ? docsContent.nav
        .filter((group) => group.pages.some((page) => normalizeRoute(page.route) === route))
        .map((group) => groupTabTitle(group.title))[0]
    : undefined;
}

function firstTabTitle(): string | undefined {
  return docsContent.nav[0] ? groupTabTitle(docsContent.nav[0].title) : undefined;
}

function currentSectionLabel(currentPath: string): string | undefined {
  const route = normalizeRoute(currentPath);
  const group = docsContent.nav.find((candidate) => candidate.pages.some((page) => normalizeRoute(page.route) === route));
  return group ? groupDisplayTitle(group.title) : undefined;
}

function groupTabTitle(title: string): string {
  return title.split(" / ")[0] || title;
}

function groupDisplayTitle(title: string): string {
  return title.includes(" / ") ? title.split(" / ").slice(1).join(" / ") : title;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\""
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    const lowerCode = code.toLowerCase();
    if (lowerCode.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lowerCode.slice(2), 16));
    }
    if (lowerCode.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lowerCode.slice(1), 10));
    }
    return namedEntities[lowerCode] ?? entity;
  });
}

function renderLegacyNav(currentPath: string): string {
  return docsContent.nav
    .map((group) => `<section>
      <h2>${escapeHtml(group.title)}</h2>
      ${group.pages
        .map((page) => {
          const active = normalizeRoute(currentPath) === normalizeRoute(page.route) ? "active" : "";
          return renderNavLink(page, active);
        })
        .join("")}
    </section>`)
    .join("");
}

function renderSitemap(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((page) => `  <url><loc>${escapeHtml(origin + page.route)}</loc></url>`).join("\n")}
</urlset>`;
}

function renderLlmsTxt(origin: string): string {
  return `# ${docsContent.site.name}

${pages
  .map((page) => `## ${page.title}

URL: ${origin}${page.route}
Source: ${page.sourcePath}
Description: ${page.description}

${page.markdown}`)
  .join("\n\n")}
`;
}

function renderPageMarkdown(page: Page, origin: string): string {
  const sections = [
    `> ## Documentation Index\n> Fetch the complete documentation index at: ${origin}/llms.txt\n> Use this file to discover all available pages before exploring further.`,
    `# ${page.title}`,
    page.description ? `> ${page.description}` : "",
    page.markdown
  ];

  return `${sections.filter(Boolean).join("\n\n").trim()}\n`;
}

function clientScript(): string {
  return `(() => {
  const panel = document.querySelector('[data-search-panel]');
  const input = document.querySelector('[data-search-input]');
  const results = document.querySelector('[data-search-results]');
  const openButtons = document.querySelectorAll('[data-open-search]');
  const closeButton = document.querySelector('[data-close-search]');
  const chatPanel = document.querySelector('[data-chat-panel]');
  const chatMessages = document.querySelector('[data-chat-messages]');
  const chatForm = document.querySelector('[data-chat-form]');
  const chatInput = document.querySelector('[data-chat-input]');
  const openChatButton = document.querySelector('[data-open-chat]');
  const closeChatButton = document.querySelector('[data-close-chat]');
  const themeButtons = document.querySelectorAll('[data-theme-toggle]');
  const searchIndex = JSON.parse(document.getElementById('docs-search-index')?.textContent || '[]');
  const responseCache = new Map();
  const chatHistory = [];
  let controller;
  let debounceTimer;
  let activeResultIndex = -1;
  let searchLoading = false;
  let navigationController;
  let trackedHeadings = [];
  let trackedTocLinks = [];
  let scrollSpyFrame;

  const themeIcons = {
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"></path></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>'
  };

  function setTheme(theme) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = normalized;
    document.documentElement.style.background = normalized === 'dark' ? '#0d1117' : '#fbfcfd';
    document.documentElement.style.colorScheme = normalized;
    try {
      localStorage.setItem('docsflare-theme', normalized);
    } catch {}
    document.cookie = 'docsflare-theme=' + normalized + '; path=/; max-age=31536000; SameSite=Lax';

    const nextTheme = normalized === 'dark' ? 'light' : 'dark';
    themeButtons.forEach((themeButton) => {
      themeButton.innerHTML = themeIcons[normalized];
      themeButton.setAttribute('aria-label', 'Switch to ' + nextTheme + ' theme');
      themeButton.setAttribute('title', 'Switch to ' + nextTheme + ' theme');
    });
  }

  setTheme(document.documentElement.dataset.theme || 'light');

  function openSearch() {
    setMobileNav(false);
    panel.hidden = false;
    input.focus();
    if (input.value.trim()) renderLocalResults(input.value);
  }

  function closeSearch() {
    panel.hidden = true;
    input.value = '';
    results.innerHTML = '';
    activeResultIndex = -1;
    setSearchLoading(false);
    if (controller) controller.abort();
  }

  function openChat() {
    chatPanel.hidden = false;
    chatInput.focus();
  }

  function closeChat() {
    chatPanel.hidden = true;
  }

  function setMobileNav(open) {
    document.body.classList.toggle('mobile-nav-open', open);
    document.querySelector('[data-mobile-nav-overlay]')?.toggleAttribute('hidden', !open);
    document.querySelectorAll('[data-toggle-mobile-nav]').forEach((button) => {
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function toggleMobileNav() {
    setMobileNav(!document.body.classList.contains('mobile-nav-open'));
  }

  async function submitChat() {
    const content = chatInput.value.trim();
    if (!content) return;

    chatInput.value = '';
    appendChatMessage('user', content);
    chatHistory.push({ role: 'user', content });
    const loading = appendChatMessage('assistant', 'Thinking...');

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: chatHistory.slice(-8) })
      });
      const payload = await response.json();
      loading.innerHTML = renderChatAnswer(payload.answer || 'I could not find an answer in the docs.', payload.sources || []);
      chatHistory.push({ role: 'assistant', content: payload.answer || '' });
    } catch {
      loading.textContent = 'Chat is unavailable right now.';
    }
  }

  function appendChatMessage(role, content) {
    const node = document.createElement('div');
    node.className = 'chat-message ' + role;
    node.textContent = content;
    chatMessages.appendChild(node);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return node;
  }

  function renderChatAnswer(answer, sources) {
    const sourceHtml = sources.length
      ? '<div class="chat-sources"><span>Sources</span>' + sources.map((source) => '<a href="' + escapeHtmlClient(source.url) + '">' + escapeHtmlClient(source.title) + '</a>').join('') + '</div>'
      : '';
    return '<p>' + escapeHtmlClient(answer).replace(/\\n/g, '<br>') + '</p>' + sourceHtml;
  }

  function scheduleSearch(query) {
    const cleanQuery = query.trim();
    if (controller) controller.abort();
    clearTimeout(debounceTimer);

    if (!cleanQuery) {
      results.innerHTML = '';
      activeResultIndex = -1;
      setSearchLoading(false);
      return;
    }

    renderLocalResults(cleanQuery);
    setSearchLoading(true);
    debounceTimer = setTimeout(() => searchAi(cleanQuery).catch((error) => {
      if (error.name !== 'AbortError') {
        results.dataset.provider = 'local';
        setSearchLoading(false);
      }
    }), 160);
  }

  function renderLocalResults(query) {
    const items = localSearch(query);
    results.dataset.provider = 'local';
    results.innerHTML = items.length
      ? renderResults(items, 'Instant results')
      : '<p class="muted">No local results found. Checking AI Search...</p>';
    setActiveResult(-1);
  }

  async function searchAi(query) {
    const cacheKey = query.toLowerCase();
    if (responseCache.has(cacheKey)) {
      renderAiResults(responseCache.get(cacheKey));
      setSearchLoading(false);
      return;
    }

    controller = new AbortController();
    const response = await fetch('/api/search?q=' + encodeURIComponent(query), { signal: controller.signal });
    const payload = await response.json();
    const items = payload.results || [];
    responseCache.set(cacheKey, items);
    renderAiResults(items);
    setSearchLoading(false);
  }

  function renderAiResults(items) {
    results.dataset.provider = 'cloudflare-ai-search';
    if (!items.length && results.innerHTML) return;
    const previousActiveIndex = activeResultIndex;
    results.innerHTML = items.length
      ? renderResults(items, 'AI Search')
      : '<p class="muted">No results found.</p>';
    setActiveResult(items.length ? previousActiveIndex : -1);
  }

  function localSearch(query) {
    const terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
    return searchIndex
      .map((item) => {
        const haystack = (item.title + ' ' + item.description + ' ' + item.text).toLowerCase();
        const title = item.title.toLowerCase();
        const score = terms.reduce((total, term) => {
          if (title.includes(term)) return total + 4;
          if (haystack.includes(term)) return total + 1;
          return total;
        }, 0);
        return { ...item, excerpt: item.description || item.text, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  function renderResults(items, label) {
    return '<div class="search-provider">' + label + '</div>' + items.map((item) =>
      '<a class="search-result" href="' + escapeHtmlClient(item.url) + '"><strong>' + escapeHtmlClient(item.title) + '</strong><span>' + escapeHtmlClient(item.excerpt || '') + '</span></a>'
    ).join('');
  }

  function resultLinks() {
    return Array.from(results.querySelectorAll('.search-result'));
  }

  function setSearchLoading(loading) {
    searchLoading = loading;
    results.classList.toggle('loading', searchLoading);
    const existing = results.querySelector('.search-loading');

    if (!searchLoading) {
      existing?.remove();
      return;
    }

    if (!existing) {
      const loadingNode = document.createElement('div');
      loadingNode.className = 'search-loading';
      loadingNode.setAttribute('role', 'status');
      loadingNode.setAttribute('aria-live', 'polite');
      loadingNode.innerHTML = '<span></span>Searching...';
      results.appendChild(loadingNode);
    }
  }

  function setActiveResult(index) {
    const links = resultLinks();
    activeResultIndex = links.length ? Math.max(-1, Math.min(index, links.length - 1)) : -1;
    links.forEach((link, linkIndex) => {
      const active = linkIndex === activeResultIndex;
      link.classList.toggle('active', active);
      link.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) link.scrollIntoView({ block: 'nearest' });
    });
  }

  function moveActiveResult(delta) {
    const links = resultLinks();
    if (!links.length) return;
    const nextIndex = activeResultIndex < 0
      ? (delta > 0 ? 0 : links.length - 1)
      : (activeResultIndex + delta + links.length) % links.length;
    setActiveResult(nextIndex);
  }

  function openActiveResult() {
    const links = resultLinks();
    if (!links.length) return;
    const selected = links[activeResultIndex >= 0 ? activeResultIndex : 0];
    if (selected instanceof HTMLAnchorElement) {
      navigateTo(selected.href).catch(() => {
        window.location.href = selected.href;
      });
    }
  }

  function setupPageTracking() {
    setupApiVariantMenus();

    const sidebar = document.querySelector('.sidebar');
    const activeSidebarLink = document.querySelector('.sidebar nav a.active');
    if (sidebar && activeSidebarLink) {
      const sidebarRect = sidebar.getBoundingClientRect();
      const linkRect = activeSidebarLink.getBoundingClientRect();
      if (linkRect.top < sidebarRect.top + 20 || linkRect.bottom > sidebarRect.bottom - 20) {
        activeSidebarLink.scrollIntoView({ block: 'nearest' });
      }
    }

    trackedHeadings = Array.from(document.querySelectorAll('.content h2[id], .content h3[id]'));
    trackedTocLinks = Array.from(document.querySelectorAll('.toc a[href^="#"]'));
    syncActiveSection();
  }

  function setupApiVariantMenus() {
    document.querySelectorAll('[data-api-polymorphic]').forEach((group) => {
      const select = group.querySelector('[data-api-variant-select]');
      if (select) syncApiVariantMenu(select);
    });
  }

  function syncApiVariantMenu(select) {
    const group = select.closest('[data-api-polymorphic]');
    if (!group) return;
    const selected = select.value || '0';
    let selectedPanel;
    group.querySelectorAll('[data-api-variant-panel]').forEach((panel) => {
      const active = panel.getAttribute('data-api-variant-panel') === selected;
      panel.hidden = !active;
      if (active) selectedPanel = panel;
    });

    const body = selectedPanel?.getAttribute('data-api-variant-body');
    const page = group.closest('.api-reference-page');
    const curlCode = page?.querySelector('[data-api-curl-code]');
    if (body && curlCode) {
      curlCode.textContent = renderApiCurl(curlCode.dataset.apiCurlMethod, curlCode.dataset.apiCurlPath, body);
    }
  }

  function renderApiCurl(method, path, body) {
    const hasBody = body && body.length > 0;
    return [
      'curl --request ' + (method || 'GET') + ' \\\\',
      '  --url https://api.camelai.com' + (path || '') + ' \\\\',
      "  --header 'Authorization: Bearer <token>'" + (hasBody ? ' \\\\' : ''),
      hasBody ? "  --header 'Content-Type: application/json' \\\\" : '',
      hasBody ? '  --data ' + shellSingleQuote(body) : ''
    ].filter(Boolean).join('\\n');
  }

  function shellSingleQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\\\''") + "'";
  }

  function requestSectionSync() {
    if (scrollSpyFrame) return;
    scrollSpyFrame = requestAnimationFrame(() => {
      scrollSpyFrame = undefined;
      syncActiveSection();
    });
  }

  function syncActiveSection() {
    if (!trackedHeadings.length || !trackedTocLinks.length) return;

    const topbarHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-height')) || 0;
    const topOffset = topbarHeight + 36;
    let activeHeading = trackedHeadings[0];

    for (const heading of trackedHeadings) {
      if (heading.getBoundingClientRect().top <= topOffset) {
        activeHeading = heading;
      } else {
        break;
      }
    }

    const activeHash = '#' + activeHeading.id;
    trackedTocLinks.forEach((link) => {
      link.classList.toggle('active', link.getAttribute('href') === activeHash);
    });
  }

  function linkForClientNavigation(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : undefined;
    const link = target?.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;

    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt' || url.pathname === '/llms.txt') return;
    if (url.pathname === window.location.pathname && url.hash) return;
    return url;
  }

  async function navigateTo(href, options = {}) {
    const url = new URL(href, window.location.href);
    const sidebar = document.querySelector('.sidebar');
    const sidebarScrollTop = sidebar?.scrollTop ?? 0;
    navigationController?.abort();
    navigationController = new AbortController();

    const response = await fetch(url.href, {
      credentials: 'same-origin',
      signal: navigationController.signal,
      headers: { accept: 'text/html' }
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Navigation failed');

    const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
    const nextMain = nextDocument.querySelector('.main');
    const nextSidebar = nextDocument.querySelector('.sidebar');
    const nextTabs = nextDocument.querySelector('.top-tabs');
    const nextCrumb = nextDocument.querySelector('.mobile-crumb');
    if (!nextMain || !nextSidebar || !nextTabs || !nextCrumb) throw new Error('Navigation target is incomplete');

    document.title = nextDocument.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', nextDocument.querySelector('meta[name="description"]')?.getAttribute('content') || '');
    document.querySelector('.main').innerHTML = nextMain.innerHTML;
    document.querySelector('.sidebar').innerHTML = nextSidebar.innerHTML;
    document.querySelector('.top-tabs').innerHTML = nextTabs.innerHTML;
    document.querySelector('.mobile-crumb').innerHTML = nextCrumb.innerHTML;
    document.querySelector('.sidebar').scrollTop = sidebarScrollTop;

    if (!options.replace) history.pushState(null, '', url.href);
    if (panel && !panel.hidden) closeSearch();
    setMobileNav(false);

    if (url.hash) {
      document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
    } else {
      window.scrollTo({ top: 0 });
    }
    setupPageTracking();
  }

  function escapeHtmlClient(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  }

  async function handleCopy(button) {
    const value = button.hasAttribute('data-copy-code')
      ? button.closest('.api-example-block')?.querySelector('code')?.textContent
      : button.getAttribute('data-copy-value');
    if (!value) return;

    await copyText(value);
    const original = button.textContent || 'Copy';
    button.textContent = 'Copied';
    button.classList.add('copied');
    window.setTimeout(() => {
      button.textContent = original;
      button.classList.remove('copied');
    }, 1400);
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  closeButton.addEventListener('click', closeSearch);
  themeButtons.forEach((themeButton) => themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')));
  closeChatButton.addEventListener('click', closeChat);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const copyButton = target?.closest('[data-copy-value], [data-copy-code]');
    if (copyButton instanceof HTMLButtonElement) {
      event.preventDefault();
      handleCopy(copyButton).catch(() => {
        copyButton.textContent = 'Failed';
        window.setTimeout(() => {
          copyButton.textContent = 'Copy';
        }, 1400);
      });
      return;
    }
    if (target?.closest('[data-toggle-mobile-nav]')) {
      event.preventDefault();
      toggleMobileNav();
      return;
    }
    if (target?.closest('[data-close-mobile-nav]')) {
      event.preventDefault();
      setMobileNav(false);
      return;
    }
    if (target?.closest('[data-open-search]')) {
      event.preventDefault();
      openSearch();
      return;
    }
    if (target?.closest('[data-open-chat]')) {
      event.preventDefault();
      openChat();
      return;
    }

    const url = linkForClientNavigation(event);
    if (!url) return;
    event.preventDefault();
    setMobileNav(false);
    navigateTo(url.href).catch((error) => {
      if (error.name !== 'AbortError') window.location.href = url.href;
    });
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches('[data-api-variant-select]')) {
      syncApiVariantMenu(target);
    }
  });
  window.addEventListener('popstate', () => {
    navigateTo(window.location.href, { replace: true }).catch(() => window.location.reload());
  });
  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitChat();
  });
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitChat();
    }
  });
  input.addEventListener('input', () => scheduleSearch(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActiveResult(1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActiveResult(-1);
    }
    if (event.key === 'Home' && resultLinks().length) {
      event.preventDefault();
      setActiveResult(0);
    }
    if (event.key === 'End' && resultLinks().length) {
      event.preventDefault();
      setActiveResult(resultLinks().length - 1);
    }
    if (event.key === 'Enter' && resultLinks().length) {
      event.preventDefault();
      openActiveResult();
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) && document.activeElement !== input) {
      event.preventDefault();
      openSearch();
    }
    if (event.key === 'Escape' && document.body.classList.contains('mobile-nav-open')) setMobileNav(false);
    if (event.key === 'Escape' && !panel.hidden) closeSearch();
    if (event.key === 'Escape' && !chatPanel.hidden) closeChat();
  });
  panel.addEventListener('click', (event) => {
    if (event.target === panel) closeSearch();
  });
  window.addEventListener('scroll', requestSectionSync, { passive: true });
  window.addEventListener('resize', requestSectionSync);
  setupPageTracking();
})();`;
}

function css(): string {
  return `:root {
  color-scheme: light;
  --bg: #fbfcfd; --surface: #ffffff; --surface-alt: #f3f6f8;
  --text: #17202a; --muted: #687483; --line: #dfe5ea;
  --primary: ${docsContent.site.colors.primary ?? "#0f766e"};
  --code: #101923; --topbar-height: 104px; --sidebar-width: 286px; --toc-width: 220px; --radius: 8px;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0d1117; --surface: #121820; --surface-alt: #18212b;
  --text: #e7edf3; --muted: #9aa8b7; --line: #26313d; --code: #070b10;
}
* { box-sizing: border-box; }
html { background: var(--bg); scroll-padding-top: calc(var(--topbar-height) + 24px); }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.68 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }

.topbar { position: sticky; top: 0; z-index: 20; height: var(--topbar-height); border-bottom: 1px solid var(--line); background: var(--surface); }
.topbar-inner, .top-tabs, .app { max-width: 1380px; margin: 0 auto; padding-inline: 36px; }
.topbar-inner { position: relative; height: 60px; display: grid; grid-template-columns: 240px minmax(0, 1fr) 240px; align-items: center; gap: 18px; }
.brand, .top-actions, .mobile-icons, .mobile-crumb, .search-trigger, .chat-header, .chat-form, .search-loading { display: flex; align-items: center; }
.brand { min-width: 0; gap: 10px; color: var(--text); font-size: 14px; font-weight: 680; }
.brand span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand-logo { display: block; width: auto; height: 30px; max-width: 160px; object-fit: contain; object-position: left center; }
.brand-logo-dark { display: none; }
html[data-theme="dark"] .brand-logo-light { display: none; }
html[data-theme="dark"] .brand-logo-dark { display: block; }
.brand-mark { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; background: var(--text); color: var(--surface); flex: 0 0 auto; }
.brand-mark img { max-width: 100%; max-height: 100%; object-fit: contain; }

.top-tabs { height: 44px; display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.top-tabs::-webkit-scrollbar { display: none; }
.top-tabs a, .sidebar-anchors a { border-radius: 6px; color: var(--muted); font-size: 13px; font-weight: 590; }
.top-tabs a { flex: 0 0 auto; line-height: 1; padding: 9px 11px; }
.top-tabs a:hover, .sidebar-anchors a:hover, .search-trigger:hover, .theme-toggle:hover { background: var(--surface-alt); color: var(--text); }
.top-tabs a.active { background: color-mix(in srgb, var(--primary) 10%, var(--surface)); color: var(--primary); font-weight: 690; }
.top-actions { grid-column: 3; justify-content: flex-end; gap: 16px; }
.top-link { color: var(--muted); font-size: 13px; font-weight: 570; white-space: nowrap; }
.top-link:hover { color: var(--primary); }
.primary-action { height: 32px; display: inline-flex; align-items: center; border: 1px solid var(--primary); border-radius: 6px; background: var(--primary); color: white; padding: 0 12px; font-size: 13px; font-weight: 650; white-space: nowrap; }
.theme-toggle { width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.theme-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.mobile-icons, .mobile-crumb { display: none; }

.search-trigger, .mdx-card, .mdx-accordion, .mdx-tab, .mdx-code-group, .mdx-frame, .pager a, .search-dialog, .chat-dialog, .chat-message.assistant, .chat-form textarea, kbd { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.search-trigger { width: 100%; height: 34px; justify-content: space-between; color: var(--muted); padding: 0 10px; font: inherit; cursor: pointer; }
.top-search { position: absolute; left: 50%; top: 50%; width: min(420px, calc(100% - 560px)); height: 36px; background: var(--bg); font-size: 13px; transform: translate(-50%, -50%); }
kbd { border-radius: 4px; padding: 0 5px; color: var(--muted); font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; }

.app { min-height: calc(100vh - var(--topbar-height)); display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); }
.mobile-nav-overlay { display: none; }
.sidebar { position: sticky; top: var(--topbar-height); height: calc(100vh - var(--topbar-height)); border-right: 1px solid var(--line); padding: 30px 24px 32px 0; overflow-y: auto; overflow-x: hidden; }
.sidebar > .search-trigger { display: none; }
.sidebar-anchors { display: grid; gap: 4px; margin-bottom: 28px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.sidebar-anchors a { display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 8px; padding: 6px 8px; }
.sidebar-anchor-icon { display: grid; place-items: center; color: var(--primary); }
.sidebar-anchor-icon svg { width: 16px; height: 16px; }
.sidebar nav, .sidebar nav section { min-width: 0; max-width: 100%; }
.sidebar nav section + section { margin-top: 20px; }
.sidebar nav h2 { margin: 0 0 7px; color: var(--muted); font-size: 12px; line-height: 1.35; font-weight: 700; text-transform: uppercase; }
.sidebar nav h2 a { color: inherit; }
.sidebar nav h2 a:hover { color: var(--text); }
.sidebar nav .api-nav-section h2 { text-transform: none; font-size: 13px; }
.sidebar nav a { display: block; max-width: 100%; border-left: 2px solid transparent; color: var(--muted); font-size: 13.5px; line-height: 1.45; padding: 6px 10px; overflow-wrap: anywhere; }
.sidebar nav a.api-operation-link { display: grid; grid-template-columns: 54px minmax(0, 1fr); align-items: baseline; column-gap: 8px; }
.api-nav-method { border-radius: 5px; padding: 3px 5px; color: white; text-align: center; white-space: nowrap; font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.sidebar nav a:hover { border-left-color: var(--line); color: var(--text); }
.sidebar nav a.active { border-left-color: var(--primary); color: var(--text); font-weight: 680; }

.main { min-width: 0; display: grid; grid-template-columns: minmax(0, 720px) var(--toc-width); gap: 72px; padding: 46px 0 80px 40px; }
.doc { min-width: 0; max-width: 720px; }
.eyebrow { margin: 0 0 10px; color: var(--primary); font-size: 13px; font-weight: 700; }
h1 { margin: 0; color: var(--text); font-size: 32px; line-height: 1.18; letter-spacing: 0; font-weight: 760; }
.description { margin: 12px 0 0; color: var(--muted); font-size: 17px; line-height: 1.58; }
.content { margin-top: 34px; color: color-mix(in srgb, var(--text) 82%, var(--muted)); }
.content h2, .content h3 { color: var(--text); letter-spacing: 0; }
.content h2 { margin: 42px 0 12px; padding-top: 4px; font-size: 21px; line-height: 1.35; font-weight: 720; }
.content h3 { margin: 30px 0 10px; font-size: 17px; line-height: 1.45; font-weight: 700; }
.content p, .content ul, .content ol { margin: 16px 0; }
.content ul, .content ol { padding-left: 1.45rem; }
.content li { margin: 7px 0; padding-left: 2px; }
.content a { color: var(--primary); text-decoration: none; font-weight: 500; }
.content a:hover { text-decoration: underline; text-underline-offset: 3px; }
.content pre { overflow-x: auto; border: 1px solid color-mix(in srgb, var(--line) 70%, #000); border-radius: var(--radius); background: var(--code); color: #e5edf5; padding: 16px; line-height: 1.58; }
.content code { border-radius: 4px; background: var(--surface-alt); color: var(--text); padding: 2px 5px; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.content pre code { background: transparent; padding: 0; color: inherit; }
.content table { width: 100%; border-collapse: collapse; margin: 20px 0; }
.content th, .content td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; }
.heading-anchor { text-decoration: none !important; color: inherit !important; }

.api-doc { grid-column: 1 / -1; max-width: none; }
.api-doc .content { margin-top: 0; }
.api-reference-page { display: grid; grid-template-columns: minmax(0, 720px) minmax(320px, 430px); align-items: start; gap: 56px; }
.api-reference-main h1 { margin-bottom: 14px; }
.api-description { margin: 0 0 24px; color: var(--muted); font-size: 16px; line-height: 1.6; }
.api-route-row { display: flex; align-items: center; gap: 10px; overflow-x: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 10px 12px; }
.api-route-row code { flex: 1 1 auto; min-width: 0; overflow-x: auto; background: transparent; padding: 0; color: var(--text); font-size: 13px; }
.api-method { flex: 0 0 auto; min-width: 56px; border-radius: 5px; padding: 5px 8px; color: white; text-align: center; font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.api-method-get { background: #2563eb; }
.api-method-post { background: #0f766e; }
.api-method-put, .api-method-patch { background: #9333ea; }
.api-method-delete { background: #dc2626; }
.api-method-options, .api-method-head { background: #64748b; }
.api-section { margin-top: 34px; }
.api-section h2 { margin: 0 0 12px; padding: 0; border-bottom: 1px solid var(--line); padding-bottom: 10px; font-size: 18px; }
.api-param { border-bottom: 1px solid var(--line); padding: 14px 0; }
.api-param > div { display: flex; align-items: center; gap: 8px; min-width: 0; }
.api-param code { background: transparent; padding: 0; color: var(--text); font-size: 13px; font-weight: 650; }
.api-param p { margin: 5px 0 0; color: var(--muted); font-size: 13.5px; line-height: 1.55; }
.api-required { border-radius: 999px; background: color-mix(in srgb, var(--primary) 12%, var(--surface)); color: var(--primary); padding: 2px 7px; font-size: 11px; font-weight: 700; }
.api-schema-note { margin: 0 0 14px; color: var(--muted); font-size: 13.5px; }
.api-schema-note code { background: var(--surface-alt); padding: 2px 5px; }
.api-polymorphic { margin-top: 10px; }
.api-variant-menu { display: grid; gap: 7px; margin-bottom: 14px; }
.api-variant-menu span { color: var(--text); font-size: 13px; font-weight: 680; }
.api-variant-menu select { appearance: none; width: 100%; min-width: 0; min-height: 38px; border: 1px solid var(--line); border-radius: 6px; background-color: var(--surface); background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 18px) 50%, calc(100% - 12px) 50%; background-repeat: no-repeat; background-size: 6px 6px, 6px 6px; color: var(--text); padding: 8px 42px 8px 12px; font: inherit; font-size: 13px; line-height: 1.4; }
.api-variant-menu select:hover { border-color: color-mix(in srgb, var(--primary) 34%, var(--line)); }
.api-variant-menu select:focus { outline: 2px solid color-mix(in srgb, var(--primary) 24%, transparent); outline-offset: 2px; border-color: var(--primary); }
.api-variant { margin: 16px 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 14px 16px 4px; }
.api-variant[hidden] { display: none; }
.api-variant h3 { margin: 0 0 2px; color: var(--text); font-size: 14px; font-weight: 720; }
.api-variant .api-param:last-child { border-bottom: 0; }
.api-example-panel { position: sticky; top: calc(var(--topbar-height) + 30px); display: grid; gap: 14px; min-width: 0; }
.api-example-block { overflow: hidden; border: 1px solid color-mix(in srgb, var(--line) 72%, #000); border-radius: var(--radius); background: var(--code); color: #e5edf5; }
.api-example-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid rgba(255, 255, 255, .09); padding: 8px 10px 8px 14px; color: #aebaca; font-size: 12px; font-weight: 700; }
.api-example-block pre { max-height: 420px; margin: 0; overflow: auto; border: 0; border-radius: 0; background: transparent; padding: 14px; font-size: 12px; line-height: 1.55; }
.api-example-block code { background: transparent; padding: 0; color: inherit; }
.copy-button { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-alt); color: var(--muted); padding: 5px 9px; font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
.copy-button:hover { border-color: color-mix(in srgb, var(--primary) 35%, var(--line)); color: var(--text); }
.copy-button:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 26%, transparent); outline-offset: 2px; }
.copy-button.copied { border-color: color-mix(in srgb, var(--primary) 45%, var(--line)); color: var(--primary); }
.copy-button-dark { border-color: rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06); color: #c8d3df; }
.copy-button-dark:hover { border-color: rgba(255, 255, 255, .28); color: #fff; }
.copy-button-dark.copied { border-color: rgba(20, 184, 166, .58); color: #7dd3c7; }

.mdx-card-group, .mdx-tabs, .mdx-columns { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
.mdx-tabs { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 20px 0; }
.mdx-card, .mdx-tab, .mdx-accordion, .mdx-code-group, .mdx-frame, .pager a { padding: 14px; }
.mdx-card { position: relative; min-height: 156px; display: block; padding: 18px; text-decoration: none !important; transition: border-color .15s ease, background-color .15s ease; }
.mdx-card-group[data-cols="1"] .mdx-card, .content > .mdx-card { min-height: 112px; }
.mdx-card[href]::after { content: ""; position: absolute; right: 18px; top: 20px; width: 7px; height: 7px; border-top: 1.5px solid var(--muted); border-right: 1.5px solid var(--muted); transform: rotate(45deg); }
.mdx-card:hover { border-color: color-mix(in srgb, var(--primary) 42%, var(--line)); background: color-mix(in srgb, var(--primary) 3%, var(--surface)); }
.mdx-card-icon { display: grid; place-items: center; width: 32px; height: 32px; margin-bottom: 16px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; background: color-mix(in srgb, currentColor 10%, transparent); color: var(--primary); }
.mdx-card-icon svg { display: block; width: 18px; height: 18px; }
.mdx-card strong, .mdx-card div { display: block; }
.mdx-card strong { color: var(--text); font-weight: 680; }
.mdx-card div { margin-top: 7px; color: var(--muted); font-size: 13.5px; line-height: 1.55; }
.mdx-card div p { margin: 0; }

.mdx-callout { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 13px 16px; margin: 20px 0; }
.mdx-callout > strong { display: none; }
.mdx-callout p:first-child, .mdx-tab h3, .mdx-update h2 { margin-top: 0; }
.mdx-callout p:last-child { margin-bottom: 0; }
.mdx-accordion { margin: 12px 0; }
.mdx-accordion summary { cursor: pointer; font-weight: 650; }
.mdx-code-group { padding: 10px; margin: 20px 0; }
.mdx-code-group pre, .mdx-card div p { margin: 0; }
.mdx-code-group pre + pre { margin-top: 10px; }

.mdx-steps { counter-reset: steps; list-style: none; padding-left: 0; }
.mdx-steps li { position: relative; padding-left: 42px; padding-bottom: 18px; }
.mdx-steps li::before { counter-increment: steps; content: counter(steps); position: absolute; left: 0; top: 2px; display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--primary); font-weight: 720; font-size: 13px; }
.mdx-steps li::after { content: ""; position: absolute; left: 12px; top: 32px; bottom: 0; width: 1px; background: var(--line); }
.mdx-steps li:last-child::after { display: none; }
.mdx-update { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 16px; margin: 34px 0; }
.mdx-update::before { content: ""; position: absolute; left: 6px; top: 18px; bottom: -22px; width: 2px; background: var(--line); }
.mdx-update-marker { position: relative; z-index: 1; width: 14px; height: 14px; margin-top: 8px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 0 5px var(--bg); }
.mdx-update-description { margin-top: -6px; color: var(--muted); font-weight: 650; }

.pager { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 56px; padding-top: 28px; border-top: 1px solid var(--line); }
.pager a { font-weight: 650; }
.pager a:hover { border-color: color-mix(in srgb, var(--primary) 36%, var(--line)); }
.pager a:last-child { text-align: right; }
.pager span { display: block; color: var(--muted); font-size: 12px; font-weight: 500; }

.toc { position: sticky; top: calc(var(--topbar-height) + 30px); height: fit-content; max-height: calc(100vh - var(--topbar-height) - 60px); overflow-y: auto; border-left: 1px solid var(--line); padding-left: 16px; color: var(--muted); font-size: 12.5px; }
.toc p { margin: 0 0 10px; color: var(--text); font-weight: 680; }
.toc a { display: block; padding: 4px 0; color: var(--muted); line-height: 1.45; }
.toc a:hover, .toc a.active { color: var(--primary); }
.toc a.active { font-weight: 680; }
.toc .depth-3 { padding-left: 12px; }

.search-panel { position: fixed; inset: 0; background: rgba(13, 17, 23, .42); padding: 10vh 18px 18px; z-index: 100; }
.search-dialog, .chat-dialog { overflow: hidden; box-shadow: 0 18px 54px rgba(13, 17, 23, .22); }
.search-dialog { max-width: 700px; margin: 0 auto; }
.search-box { display: grid; grid-template-columns: minmax(0, 1fr) 56px; border-bottom: 1px solid var(--line); }
.search-box input, .search-box button { height: 54px; border: 0; background: transparent; font: inherit; }
.search-box input { padding: 0 18px; outline: none; }
.search-box button, .chat-header button { color: var(--muted); cursor: pointer; }
.search-results { max-height: min(520px, 62vh); overflow-y: auto; padding: 8px; }
.search-provider { padding: 8px 12px 4px; color: var(--muted); font-size: 12px; font-weight: 680; }
.search-result { display: block; border-radius: 6px; padding: 12px; outline: none; }
.search-result:hover, .search-result.active { background: var(--surface-alt); }
.search-result strong, .search-result span { display: block; }
.search-result span, .muted, .chat-header span { color: var(--muted); }
.search-loading { gap: 8px; padding: 10px 12px 12px; color: var(--muted); font-size: 13px; }
.search-loading span { width: 12px; height: 12px; border: 2px solid color-mix(in srgb, var(--primary) 18%, #d1d5db); border-top-color: var(--primary); border-radius: 50%; animation: spin .7s linear infinite; }
.muted { padding: 12px; margin: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

.chat-launcher { position: fixed; right: 22px; bottom: 22px; z-index: 9; height: 38px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); padding: 0 14px; font: inherit; font-weight: 680; cursor: pointer; }
.chat-launcher:hover { border-color: color-mix(in srgb, var(--primary) 38%, var(--line)); color: var(--primary); }
.chat-panel { position: fixed; right: 22px; bottom: 76px; z-index: 11; width: min(420px, calc(100vw - 32px)); }
.chat-header { justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding: 14px 16px; }
.chat-header strong, .chat-header span { display: block; }
.chat-header span { font-size: 12px; }
.chat-header button { border: 0; background: transparent; font: inherit; }
.chat-messages { height: min(460px, 55vh); overflow-y: auto; padding: 14px; background: var(--bg); }
.chat-message { max-width: 88%; border-radius: var(--radius); padding: 10px 12px; margin: 0 0 10px; white-space: pre-wrap; }
.chat-message p { margin: 0; }
.chat-message.user { margin-left: auto; background: var(--primary); color: white; }
.chat-message.assistant { color: color-mix(in srgb, var(--text) 82%, var(--muted)); }
.chat-sources { display: grid; gap: 4px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.chat-sources span { color: var(--muted); font-size: 12px; font-weight: 650; }
.chat-sources a { color: var(--primary); font-size: 13px; }
.chat-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; border-top: 1px solid var(--line); padding: 12px; background: var(--surface); }
.chat-form textarea { min-height: 40px; max-height: 120px; resize: vertical; padding: 9px 10px; font: inherit; outline: none; }
.chat-form button { border: 0; border-radius: 6px; background: var(--primary); color: white; padding: 0 14px; font: inherit; font-weight: 680; cursor: pointer; }
html[data-theme="dark"] .search-panel { background: rgba(0, 0, 0, .52); }

@media (max-width: 1120px) {
  .topbar-inner { grid-template-columns: minmax(180px, var(--sidebar-width)) minmax(220px, 1fr) auto; }
  .app { grid-template-columns: 244px minmax(0, 1fr); }
  .main { grid-template-columns: minmax(0, 760px); padding-left: 36px; padding-right: 0; }
  .api-reference-page { grid-template-columns: 1fr; gap: 32px; }
  .api-example-panel { position: static; }
  .toc { display: none; }
}
@media (max-width: 820px) {
  :root { --topbar-height: 116px; }
  .topbar { height: var(--topbar-height); position: static; }
  .topbar-inner { height: 60px; display: flex; justify-content: space-between; padding-inline: 20px; }
  .brand-logo { height: 29px; max-width: 160px; }
  .mobile-icons { display: flex; gap: 18px; }
  .mobile-icons button { position: relative; width: 22px; height: 22px; border: 0; background: transparent; padding: 0; color: var(--muted); }
  .mobile-search::before { content: ""; position: absolute; left: 3px; top: 3px; width: 10px; height: 10px; border: 2px solid currentColor; border-radius: 50%; }
  .mobile-search::after { content: ""; position: absolute; left: 14px; top: 14px; width: 7px; height: 2px; background: currentColor; transform: rotate(45deg); transform-origin: left center; border-radius: 2px; }
  .mobile-menu::before, .mobile-menu::after, .mobile-menu span { content: ""; position: absolute; left: 9px; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
  .mobile-menu::before { top: 2px; }
  .mobile-menu span { top: 9px; }
  .mobile-menu::after { top: 16px; }
  .top-actions { display: none; }
  .top-search, .top-tabs { display: none; }
  .mobile-crumb { height: 56px; display: flex; gap: 12px; border-top: 1px solid var(--line); padding: 0 20px; color: var(--muted); font-size: 14px; }
  .mobile-crumb-menu { display: grid; place-items: center; flex: 0 0 auto; width: 30px; height: 30px; border: 0; border-radius: 6px; background: transparent; color: inherit; padding: 0; }
  .mobile-crumb-menu:hover { background: var(--surface-alt); color: var(--text); }
  .mobile-crumb strong { color: var(--text); font-weight: 650; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mobile-menu-lines { position: relative; width: 18px; height: 14px; flex: 0 0 auto; }
  .mobile-menu-lines::before, .mobile-menu-lines::after { content: ""; position: absolute; left: 0; width: 14px; height: 2px; background: var(--muted); border-radius: 2px; }
  .mobile-menu-lines::before { top: 3px; }
  .mobile-menu-lines::after { top: 9px; }
  .app { display: block; padding: 0; }
  .sidebar { display: none; }
  .mobile-nav-open { overflow: hidden; }
  .mobile-nav-open .mobile-nav-overlay { display: block; position: fixed; inset: var(--topbar-height) 0 0; z-index: 80; background: rgba(15, 23, 42, .34); backdrop-filter: blur(2px); }
  .mobile-nav-open .sidebar { display: block; position: fixed; z-index: 90; left: 0; top: var(--topbar-height); width: min(84vw, 320px); max-width: 100vw; height: calc(100vh - var(--topbar-height)); border-right: 1px solid var(--line); background: var(--bg); padding: 20px 20px 28px; box-shadow: 18px 0 36px rgba(15, 23, 42, .18); }
  .sidebar > .search-trigger { display: flex; }
  .main { display: block; padding: 40px 20px 64px; }
  h1 { font-size: 26px; line-height: 1.25; }
  .description { font-size: 17px; }
  .content { margin-top: 36px; }
  .mdx-card-group, .mdx-tabs, .mdx-columns, .pager { grid-template-columns: 1fr; }
  .api-reference-page { display: block; }
  .api-example-panel { margin-top: 28px; }
  .api-route-row { align-items: flex-start; flex-direction: column; }
  .api-route-row code { white-space: nowrap; max-width: 100%; overflow-x: auto; }
  .mdx-card { min-height: 132px; }
  .content > .mdx-card { min-height: 124px; }
  .pager a:last-child { text-align: left; }
  .chat-launcher { right: 16px; bottom: 16px; }
  .chat-panel { right: 16px; bottom: 68px; }
}`;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "vary": "accept"
    }
  });
}

function jsonResponse(data: unknown, headers: Record<string, string> = { "cache-control": "no-store" }, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function textResponse(text: string, contentType: string): Response {
  return new Response(text, {
    headers: {
      "content-type": contentType
    }
  });
}

function markdownResponse(markdown: string): Response {
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": "inline",
      "link": "</llms.txt>; rel=\"llms-txt\"",
      "vary": "accept",
      "x-llms-txt": "/llms.txt"
    }
  });
}

function xmlResponse(xml: string): Response {
  return textResponse(xml, "application/xml; charset=utf-8");
}

function assetResponse(asset: Asset): Response {
  const binary = atob(asset.base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Response(bytes, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}

function wantsMarkdown(request: Request, forced = false): boolean {
  if (forced) return true;

  const accept = request.headers.get("accept");
  if (!accept) return false;

  const preferences = accept
    .split(",")
    .map((item, index) => {
      const [rawType, ...params] = item.trim().split(";").map((part) => part.trim());
      const qParam = params.find((param) => param.startsWith("q="));
      const quality = qParam ? Number(qParam.slice(2)) : 1;
      return {
        type: rawType.toLowerCase(),
        quality: Number.isFinite(quality) ? quality : 0,
        index
      };
    })
    .filter((item) => item.type.length > 0 && item.quality > 0);

  const markdown = bestAccepted(preferences, ["text/markdown", "text/mdx", "application/mdx", "text/x-markdown"]);
  if (!markdown) return false;

  const html = bestAccepted(preferences, ["text/html", "application/xhtml+xml"]);
  if (!html) return true;

  return markdown.quality > html.quality || (markdown.quality === html.quality && markdown.index < html.index);
}

function bestAccepted(preferences: Array<{ type: string; quality: number; index: number }>, types: string[]): { quality: number; index: number } | undefined {
  return preferences
    .filter((item) => types.includes(item.type))
    .sort((a, b) => b.quality - a.quality || a.index - b.index)[0];
}

function isMarkdownPath(pathname: string): boolean {
  return /\.(md|mdx)$/i.test(pathname);
}

function stripMarkdownExtension(pathname: string): string {
  return pathname.replace(/\.(md|mdx)$/i, "");
}

function normalizeRoute(pathname: string): string {
  const route = pathname.replace(/\/+$/, "") || "/";
  return route === "/index" ? "/" : route;
}

function sourceKeyToRoute(key: string): string {
  const withoutOrigin = key.replace(/^https?:\/\/[^/]+/, "");
  const withoutExtension = withoutOrigin.replace(/\.(mdx|md|html)$/i, "").replace(/__/g, "/");
  return normalizeRoute(withoutExtension.startsWith("/") ? withoutExtension : `/${withoutExtension}`);
}

function excerpt(value: string, maxLength: number): string {
  const text = stripMdx(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function stripMdx(value: string): string {
  return value
    .replace(/---[\s\S]*?---/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>{}[\]()]/g, " ");
}

function stripLeadingH1(html: string): string {
  return html.replace(/^<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, "");
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
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
