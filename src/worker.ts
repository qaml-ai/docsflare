import { content } from "./content";

type GeneratedContent = {
  site: {
    name: string;
    basePath?: string;
    logo?: string | { light?: string; dark?: string };
    favicon?: string;
    colors: {
      primary?: string;
      light?: string;
      dark?: string;
    };
    /** Optional design-token overrides emitted by the content builder. */
    appearance?: unknown;
    fonts?: unknown;
    background?: unknown;
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
    updatedAt?: string;
    html: string;
    markdown: string;
  }>;
  assets: Array<{
    route: string;
    contentType: string;
    base64: string;
  }>;
  /** Project CSS, emitted verbatim after Docsflare's built-in stylesheet. */
  customCss?: unknown;
};

export type SearchChunk = {
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

export type SearchProvider = {
  /** Identifier returned by the search and chat APIs. */
  id?: string;
  search(input: {
    query?: string;
    messages?: ChatMessage[];
    ai_search_options?: Record<string, unknown>;
  }): Promise<{ chunks?: SearchChunk[] }>;
  chatCompletions?(input: {
    messages: ChatMessage[];
    model?: string;
    stream?: boolean;
    ai_search_options?: Record<string, unknown>;
  }): Promise<{
    choices?: Array<{ message?: { role?: string; content?: string } }>;
    chunks?: SearchChunk[];
  }>;
};

export type DocsflareEnv = {
  /** Portable provider binding for non-Cloudflare runtimes and custom adapters. */
  SEARCH?: SearchProvider;
  /** Cloudflare AI Search instance binding. */
  AI_SEARCH?: SearchProvider;
};

export type RuntimeContext = {
  waitUntil(promise: Promise<unknown>): void;
};


const docsContent = content as unknown as GeneratedContent;

function appearanceConfig(): { default: "system" | "light" | "dark"; strict: boolean } {
  const value = recordFromUnknown(docsContent.site.appearance);
  const requestedDefault = typeof value?.default === "string" ? value.default.toLowerCase() : "system";
  return {
    default: requestedDefault === "light" || requestedDefault === "dark" ? requestedDefault : "system",
    strict: value?.strict === true
  };
}

function initialThemeForRequest(cookie: string | null): "dark" | "light" | undefined {
  const appearance = appearanceConfig();
  if (!appearance.strict) {
    const saved = themeFromCookie(cookie);
    if (saved) return saved;
  }
  return appearance.default === "system" ? undefined : appearance.default;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type Page = GeneratedContent["pages"][number];
type Asset = GeneratedContent["assets"][number];

const pages = [...docsContent.pages];
const pageByRoute = new Map(pages.map((page) => [normalizeRoute(page.route), page]));
const assetByRoute = new Map((docsContent.assets ?? []).map((asset) => [normalizeRoute(asset.route), asset]));
const searchIndexJsonByBasePath = new Map<string, string>();
const legacyRedirects = new Map([
  ["/api-reference/ask_camel/ask-camel", "/api-reference/ask-camel/ask-camel"],
  ["/api-reference/internal_api/post-internal_apichat-recommendations", "/api-reference/internal-api/internal-api-chat-recommendations-create"],
  ["/api-reference/internal_api/post-internal_apichatrecommendations", "/api-reference/internal-api/internal-api-chat-recommendations-create-2"],
  ["/api-reference/internal_api/post-internal_apisendmessage", "/api-reference/internal-api/internal-api-sendmessage-create"]
]);

export async function handleRequest(
  request: Request,
  env: DocsflareEnv = {},
  ctx: RuntimeContext = defaultRuntimeContext()
): Promise<Response> {
    const url = new URL(request.url);
    const siteBasePath = configuredBasePath();
    const basePath = basePathForRequest(url.pathname, siteBasePath);
    const routePath = stripBasePath(url.pathname, basePath);
    const markdownPath = isMarkdownPath(url.pathname);
    const route = normalizeRoute(markdownPath ? stripMarkdownExtension(routePath) : routePath);

    if (route === "/api/search") {
      return handleSearch(request, env, ctx);
    }

    if (route === "/api/chat") {
      return handleChat(request, env);
    }

    if (route === "/sitemap.xml") {
      return xmlResponse(renderSitemap(url.origin, basePath));
    }

    if (route === "/llms.txt") {
      return textResponse(renderLlmsTxt(url.origin, basePath), "text/plain; charset=utf-8");
    }

    if (route === "/robots.txt") {
      return textResponse(`User-agent: *\nAllow: /\nSitemap: ${absoluteUrl(routeWithBase("/sitemap.xml", basePath), url.origin)}\n`, "text/plain; charset=utf-8");
    }

    const asset = assetByRoute.get(route);
    if (asset) {
      return assetResponse(asset);
    }

    const page = pageByRoute.get(route) ?? (route === "/" ? pages[0] : undefined);
    const initialTheme = initialThemeForRequest(request.headers.get("cookie"));

    if (!page) {
      const redirectTarget = legacyRedirects.get(route) ?? redirectForMiss(route);
      if (redirectTarget) {
        return redirectResponse(absoluteUrl(routeWithBase(redirectTarget, basePath), url.origin));
      }
      return htmlResponse(renderShell(undefined, url, 404, initialTheme, basePath), 404);
    }

    if (wantsMarkdown(request, markdownPath)) {
      return markdownResponse(renderPageMarkdown(page, url.origin, basePath), basePath);
    }

    return htmlResponse(renderShell(page, url, 200, initialTheme, basePath), 200);
}

export default {
  fetch: handleRequest
};

type RuntimeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

function searchProvider(env: DocsflareEnv): SearchProvider | undefined {
  return env.SEARCH ?? env.AI_SEARCH;
}

function searchProviderId(env: DocsflareEnv, provider: SearchProvider): string {
  return provider.id ?? (env.AI_SEARCH === provider ? "cloudflare-ai-search" : "external-search");
}

async function openCache(name: string): Promise<RuntimeCache | undefined> {
  const cacheStorage = (globalThis as typeof globalThis & {
    caches?: { open(cacheName: string): Promise<RuntimeCache> };
  }).caches;
  return cacheStorage?.open(name);
}

function defaultRuntimeContext(): RuntimeContext {
  return {
    waitUntil(promise) {
      void promise.catch((error) => console.error("Docsflare background task failed", error));
    }
  };
}

async function handleSearch(request: Request, env: DocsflareEnv, ctx: RuntimeContext): Promise<Response> {
  const url = new URL(request.url);
  const basePath = basePathForRequest(url.pathname, configuredBasePath());
  let query = url.searchParams.get("q")?.trim() ?? "";

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({})) as { query?: string };
    query = body.query?.trim() ?? query;
  }

  if (!query) {
    return jsonResponse({ results: [] });
  }

  const provider = searchProvider(env);
  if (provider?.search) {
    const providerId = searchProviderId(env, provider);
    const cacheKey = new Request(`${url.origin}${routeWithBase("/api/search", basePath)}?q=${encodeURIComponent(query.toLowerCase())}`);
    const searchCache = await openCache("docsflare-search");

    if (request.method === "GET") {
      const cached = await searchCache?.match(cacheKey);
      if (cached) return cached;
    }

    try {
      const response = await provider.search({
        query,
        ai_search_options: {
          retrieval: {
            retrieval_type: "hybrid",
            max_num_results: 8
          }
        }
      });

      const results = prefixResultUrls((response.chunks ?? []).map((chunk) => resultFromAiSearchChunk(chunk)), basePath);
      const payload = jsonResponse(
        { provider: providerId, results },
        { "cache-control": "public, max-age=300, s-maxage=300" }
      );

      if (request.method === "GET") {
        if (searchCache) ctx.waitUntil(searchCache.put(cacheKey, payload.clone()));
      }

      return payload;
    } catch (error) {
      console.warn(`${providerId} failed, falling back to static search`, error);
    }
  }

  return jsonResponse({ provider: "static-fallback", results: prefixResultUrls(localSearch(query), basePath) });
}

function resultFromAiSearchChunk(chunk: SearchChunk) {
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

function prefixResultUrls<T extends { url: string }>(results: T[], basePath: string): T[] {
  if (!basePath) return results;
  return results.map((result) => ({ ...result, url: routeWithBase(result.url, basePath) }));
}

async function handleChat(request: Request, env: DocsflareEnv): Promise<Response> {
  const basePath = basePathForRequest(new URL(request.url).pathname, configuredBasePath());

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { "cache-control": "no-store" }, 405);
  }

  const body = await request.json().catch(() => ({})) as { messages?: Array<{ role?: string; content?: string }> };
  const messages = normalizeChatMessages(body.messages);
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  if (!lastUserMessage.trim()) {
    return jsonResponse({ error: "Missing user message" }, { "cache-control": "no-store" }, 400);
  }

  const provider = searchProvider(env);
  if (provider?.chatCompletions) {
    const providerId = searchProviderId(env, provider);
    try {
      const response = await provider.chatCompletions({
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
        provider: `${providerId}-chat-completions`,
        answer: answer || "I could not find an answer in the docs.",
        sources: prefixResultUrls(sourceResultsFromChunks(response.chunks ?? []), basePath)
      });
    } catch (error) {
      console.warn(`${providerId} chat completions failed, falling back to source results`, error);
    }
  }

  const sources = prefixResultUrls(localSearch(lastUserMessage).slice(0, 4), basePath);
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

function sourceResultsFromChunks(chunks: SearchChunk[]) {
  const seen = new Set<string>();
  return chunks.flatMap((chunk) => {
    const result = resultFromAiSearchChunk(chunk);
    const key = normalizeRoute(result.url);
    if (seen.has(key)) return [];
    seen.add(key);
    return [result];
  }).slice(0, 5);
}

function renderShell(page: Page | undefined, url: URL, status = 200, initialTheme?: "dark" | "light", basePath = ""): string {
  const title = page ? `${page.title} - ${docsContent.site.name}` : `Not found - ${docsContent.site.name}`;
  const description = page?.description ?? `${docsContent.site.name} documentation`;
  const seoMeta = renderSeoMeta(page, url, status, title, description, basePath);
  const themeAttribute = initialTheme ? ` data-theme="${initialTheme}"` : "";
  const design = resolvedDesign();
  const appearance = appearanceConfig();
  const themeStyle = initialTheme ? ` style="background:${escapeHtml(initialTheme === "dark" ? design.darkBackground : design.lightBackground)};color-scheme:${initialTheme}"` : "";
  const currentPath = page?.route ?? url.pathname;

  return `<!doctype html>
<html lang="en"${themeAttribute}${themeStyle}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  ${seoMeta}
  ${docsContent.site.favicon ? `<link rel="icon" href="${escapeHtml(docsContent.site.favicon)}">` : ""}
  <style>
    html { background: ${design.lightBackground}; color-scheme: light; }
    html[data-theme="dark"] { background: ${design.darkBackground}; color-scheme: dark; }
    @media (prefers-color-scheme: dark) {
      html:not([data-theme="light"]) { background: ${design.darkBackground}; color-scheme: dark; }
    }
  </style>
  <script>
    (function () {
      const darkBg = ${JSON.stringify(design.darkBackground)};
      const lightBg = ${JSON.stringify(design.lightBackground)};
      const appearanceDefault = ${JSON.stringify(appearance.default)};
      const strictAppearance = ${JSON.stringify(appearance.strict)};
      let theme;
      if (!strictAppearance) {
        try { theme = localStorage.getItem("docsflare-theme"); } catch {}
        theme = theme || document.cookie.match(/(?:^|; )docsflare-theme=(dark|light)/)?.[1];
      }
      theme = theme || (appearanceDefault === "system" ? undefined : appearanceDefault);
      theme = theme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      theme = theme === "dark" ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.background = theme === "dark" ? darkBg : lightBg;
      document.documentElement.style.colorScheme = theme;
      document.cookie = "docsflare-theme=" + theme + "; path=/; max-age=31536000; SameSite=Lax";
    })();
  </script>
  <style>${css(basePath)}</style>
  ${renderCustomCss(basePath)}
</head>
<body>
  <header class="topbar" data-docsflare-component="topbar">
    <div class="topbar-inner">
      <a class="brand" href="${escapeHtml(routeWithBase("/", basePath))}">
        ${renderBrand(basePath)}
      </a>
      <div class="mobile-icons">
        <button class="mobile-search" type="button" data-open-search aria-label="Search"></button>
        ${appearance.strict ? "" : `<button class="theme-toggle mobile-theme" type="button" data-theme-toggle aria-label="Switch to dark theme" title="Switch to dark theme">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"></path>
          </svg>
        </button>`}
        <button class="mobile-menu" type="button" data-toggle-mobile-nav aria-controls="site-sidebar" aria-expanded="false" aria-label="Menu"><span></span></button>
      </div>
      <div class="top-actions">
        ${renderExternalLinks()}
        ${docsContent.site.navbar?.primary ? `<a class="primary-action" href="${escapeHtml(docsContent.site.navbar.primary.href)}">${escapeHtml(docsContent.site.navbar.primary.label)}</a>` : ""}
        ${appearance.strict ? "" : `<button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to dark theme" title="Switch to dark theme">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"></path>
          </svg>
        </button>`}
      </div>
      <button class="search-trigger top-search" type="button" data-open-search>
        <span>Find docs</span>
        <kbd>Cmd K</kbd>
      </button>
    </div>
    <nav class="top-tabs" aria-label="Documentation sections">${renderTopTabs(currentPath, basePath)}</nav>
    ${renderMobileCrumb(currentPath, page)}
  </header>
  <div class="app">
    <div class="mobile-nav-overlay" hidden data-mobile-nav-overlay data-close-mobile-nav></div>
    <aside class="sidebar" id="site-sidebar" data-docsflare-component="sidebar">
      <button class="search-trigger" type="button" data-open-search>
        <span>Find docs</span>
        <kbd>/</kbd>
      </button>
      ${renderSidebarAnchors(basePath)}
      <nav>${renderNav(currentPath, basePath)}</nav>
    </aside>
    <main class="main" data-docsflare-component="content">
      ${page ? renderArticle(page, basePath) : renderNotFound(status)}
    </main>
  </div>
  <div class="search-panel" hidden data-search-panel data-docsflare-component="search">
    <div class="search-dialog">
      <div class="search-box">
        <input data-search-input placeholder="Search docs..." autocomplete="off">
        <button class="overlay-close" type="button" data-close-search aria-label="Close search"><span aria-hidden="true"></span></button>
      </div>
      <div class="search-results" data-search-results></div>
    </div>
  </div>
  <button class="chat-launcher" type="button" data-open-chat>Ask docs</button>
  <div class="chat-panel" hidden data-chat-panel data-docsflare-component="chat">
    <div class="chat-dialog">
      <div class="chat-header">
        <div>
          <strong>Ask the docs</strong>
          <span>Answers from your documentation</span>
        </div>
        <button class="overlay-close" type="button" data-close-chat aria-label="Close chat"><span aria-hidden="true"></span></button>
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
  <script type="application/json" id="docs-search-index">${renderSearchIndexJson(basePath)}</script>
  <script>${clientScript(basePath)}</script>
</body>
</html>`;
}

function renderSeoMeta(page: Page | undefined, url: URL, status: number, title: string, description: string, basePath: string): string {
  const route = page?.route ?? normalizeRoute(url.pathname);
  const canonicalUrl = absoluteUrl(routeWithBase(route, basePath), url.origin);
  const origin = url.origin;
  const robots = status >= 400 ? "noindex, nofollow" : "index, follow";
  const primaryColor = docsContent.site.colors.primary ?? "#0f766e";
  const imageUrl = primaryShareImageUrl(origin, basePath);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: canonicalUrl,
    isPartOf: {
      "@type": "WebSite",
      name: docsContent.site.name,
      url: origin
    }
  };

  const imageMeta = imageUrl ? `
  <meta data-docsflare-managed-meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta data-docsflare-managed-meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : "";

  return `<meta data-docsflare-managed-meta name="robots" content="${robots}">
  <meta data-docsflare-managed-meta name="application-name" content="${escapeHtml(docsContent.site.name)}">
  <meta data-docsflare-managed-meta name="apple-mobile-web-app-title" content="${escapeHtml(docsContent.site.name)}">
  <meta data-docsflare-managed-meta name="theme-color" content="${escapeHtml(primaryColor)}">
  <meta data-docsflare-managed-meta name="format-detection" content="telephone=no">
  <meta data-docsflare-managed-meta name="canonical" content="${escapeHtml(canonicalUrl)}">
  <link data-docsflare-managed-meta rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <link data-docsflare-managed-meta rel="alternate" type="application/xml" title="Sitemap" href="${escapeHtml(absoluteUrl(routeWithBase("/sitemap.xml", basePath), origin))}">
  <link data-docsflare-managed-meta rel="alternate" type="text/plain" title="llms.txt" href="${escapeHtml(absoluteUrl(routeWithBase("/llms.txt", basePath), origin))}">
  <meta data-docsflare-managed-meta property="og:site_name" content="${escapeHtml(docsContent.site.name)}">
  <meta data-docsflare-managed-meta property="og:title" content="${escapeHtml(title)}">
  <meta data-docsflare-managed-meta property="og:description" content="${escapeHtml(description)}">
  <meta data-docsflare-managed-meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta data-docsflare-managed-meta property="og:type" content="website">${imageMeta}
  <meta data-docsflare-managed-meta name="twitter:card" content="summary">
  <meta data-docsflare-managed-meta name="twitter:title" content="${escapeHtml(title)}">
  <meta data-docsflare-managed-meta name="twitter:description" content="${escapeHtml(description)}">
  <script data-docsflare-managed-meta type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd))}</script>`;
}

function primaryShareImageUrl(origin: string, basePath: string): string | undefined {
  const logo = docsContent.site.logo;
  const logoPath = typeof logo === "string" ? logo : logo?.light ?? logo?.dark;
  return logoPath ? absoluteUrl(routeWithBase(logoPath, basePath), origin) : undefined;
}

function absoluteUrl(path: string, origin: string): string {
  return new URL(path, origin).toString();
}

function renderSearchIndexJson(basePath = ""): string {
  const cached = searchIndexJsonByBasePath.get(basePath);
  if (cached) return cached;

  const rendered = JSON.stringify(
    pages.map((page) => ({
      title: page.title,
      url: routeWithBase(page.route, basePath),
      description: page.description,
      text: excerpt(stripMdx(page.markdown.slice(0, 1200)), 360)
    }))
  ).replace(/</g, "\\u003c");
  searchIndexJsonByBasePath.set(basePath, rendered);
  return rendered;
}

function renderBrand(basePath = ""): string {
  const logo = docsContent.site.logo;
  const logoPath = typeof logo === "string" ? logo : undefined;

  if (logoPath) {
    return `<img class="brand-logo" src="${escapeHtml(routeWithBase(logoPath, basePath))}" alt="${escapeHtml(docsContent.site.name)}">`;
  }

  if (typeof logo === "object" && (logo.light || logo.dark)) {
    if (logo.light && logo.dark && logo.light !== logo.dark) {
      return `<img class="brand-logo brand-logo-light" src="${escapeHtml(routeWithBase(logo.light, basePath))}" alt="${escapeHtml(docsContent.site.name)}"><img class="brand-logo brand-logo-dark" src="${escapeHtml(routeWithBase(logo.dark, basePath))}" alt="${escapeHtml(docsContent.site.name)}">`;
    }

    const singleLogoPath = logo.light ?? logo.dark;
    if (singleLogoPath) {
      return `<img class="brand-logo" src="${escapeHtml(routeWithBase(singleLogoPath, basePath))}" alt="${escapeHtml(docsContent.site.name)}">`;
    }
  }

  return `<span class="brand-mark">${escapeHtml(docsContent.site.name.slice(0, 1))}</span><span>${escapeHtml(docsContent.site.name)}</span>`;
}

function renderArticle(page: Page, basePath = ""): string {
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
    <div class="content">${addComponentHooks(prefixInternalHtmlLinks(isApiPage ? page.html : stripLeadingH1(page.html), basePath))}</div>
    <footer class="pager">
      ${previous ? `<a href="${routeWithBase(previous.route, basePath)}"><span>Previous</span>${escapeHtml(previous.title)}</a>` : "<span></span>"}
      ${next ? `<a href="${routeWithBase(next.route, basePath)}"><span>Next</span>${escapeHtml(next.title)}</a>` : ""}
    </footer>
  </article>
  ${renderTableOfContents(page)}`;
}

function addComponentHooks(html: string): string {
  const withCards = addClassComponentHook(html, "mdx-card", "card");
  const withCallouts = addClassComponentHook(withCards, "mdx-callout", "callout");
  return withCallouts.replace(/<pre(?![^>]*\bdata-docsflare-component=)([^>]*)>/gi, '<pre data-docsflare-component="code"$1>');
}

function addClassComponentHook(html: string, className: string, component: string): string {
  const pattern = new RegExp(`<([a-z][\\w-]*)(?=[^>]*\\bclass="[^"]*\\b${className}\\b[^"]*")(?![^>]*\\bdata-docsflare-component=)([^>]*)>`, "gi");
  return html.replace(pattern, `<$1 data-docsflare-component="${component}"$2>`);
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

function renderNav(currentPath: string, basePath = ""): string {
  const groups = navGroupsForPath(currentPath);
  const currentRoute = normalizeRoute(currentPath);

  return groups
    .map((group) => {
      const groupTitle = groupDisplayTitle(group.title);
      const activeGroup = group.pages.some((page) => normalizeRoute(page.route) === currentRoute);
      const apiReferenceGroup = groupTabTitle(group.title).toLowerCase().includes("api reference");
      const showPages = !apiReferenceGroup || activeGroup;
      const heading = apiReferenceGroup && group.pages[0]
        ? `<a href="${escapeHtml(routeWithBase(group.pages[0].route, basePath))}">${escapeHtml(groupTitle)}</a>`
        : escapeHtml(groupTitle);

      return `<section class="${apiReferenceGroup ? "api-nav-section" : ""}">
        <h2>${heading}</h2>
        ${showPages ? group.pages
          .map((page) => {
            const active = currentRoute === normalizeRoute(page.route) ? "active" : "";
            return renderNavLink(page, active, basePath);
          })
          .join("") : ""}
      </section>`;
    })
    .join("");
}

function renderNavLink(page: { title: string; route: string }, active: string, basePath = ""): string {
  const operation = apiOperationTitle(page.title);
  if (!operation) {
    return `<a class="${active}" href="${routeWithBase(page.route, basePath)}">${escapeHtml(page.title)}</a>`;
  }

  const method = operation.method.toLowerCase();
  return `<a class="${active} api-operation-link" href="${routeWithBase(page.route, basePath)}">
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

function renderTopTabs(currentPath: string, basePath = ""): string {
  const inferredTabs = [...new Set(docsContent.nav.map((group) => groupTabTitle(group.title)))].map((label) => {
    const firstPage = docsContent.nav.find((group) => groupTabTitle(group.title) === label)?.pages[0];
    return { label, href: firstPage?.route ?? "#" };
  });
  const tabs = docsContent.site.navTabs && docsContent.site.navTabs.length > 0 ? docsContent.site.navTabs : inferredTabs;
  const activeTab = currentTabTitle(currentPath) ?? tabs[0]?.label;

  return tabs
    .map((tab) => {
      const active = activeTab === tab.label ? "active" : "";
      return `<a class="${active}" href="${escapeHtml(routeWithBase(tab.href, basePath))}">${escapeHtml(tab.label)}</a>`;
    })
    .join("");
}

function renderExternalLinks(): string {
  const links = docsContent.site.navbar?.links ?? [];

  return links.map((link) => `<a class="top-link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
}

function renderSidebarAnchors(basePath = ""): string {
  const links = docsContent.site.globalAnchors ?? [];
  if (links.length === 0) return "";

  return `<div class="sidebar-anchors">
    ${links.map((link) => `<a href="${escapeHtml(routeWithBase(link.href, basePath))}"><span class="sidebar-anchor-icon">${iconForAnchor(link)}</span>${escapeHtml(link.label)}</a>`).join("")}
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

  if (headings.length === 0) return `<aside class="toc" data-docsflare-component="toc" aria-label="On this page"></aside>`;

  return `<aside class="toc" data-docsflare-component="toc" aria-label="On this page">
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

function renderLegacyNav(currentPath: string, basePath = ""): string {
  return docsContent.nav
    .map((group) => `<section>
      <h2>${escapeHtml(group.title)}</h2>
      ${group.pages
        .map((page) => {
          const active = normalizeRoute(currentPath) === normalizeRoute(page.route) ? "active" : "";
          return renderNavLink(page, active, basePath);
        })
        .join("")}
    </section>`)
    .join("");
}

function renderSitemap(origin: string, basePath = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((page) => `  <url><loc>${escapeHtml(absoluteUrl(routeWithBase(page.route, basePath), origin))}</loc>${page.updatedAt ? `<lastmod>${escapeHtml(page.updatedAt)}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`;
}

function renderLlmsTxt(origin: string, basePath = ""): string {
  return `# ${docsContent.site.name}

${pages
  .map((page) => `## ${page.title}

URL: ${absoluteUrl(routeWithBase(page.route, basePath), origin)}
Source: ${page.sourcePath}
Description: ${page.description}

${prefixInternalMarkdownLinks(page.markdown, basePath)}`)
  .join("\n\n")}
`;
}

function renderPageMarkdown(page: Page, origin: string, basePath = ""): string {
  const sections = [
    `> ## Documentation Index\n> Fetch the complete documentation index at: ${absoluteUrl(routeWithBase("/llms.txt", basePath), origin)}\n> Use this file to discover all available pages before exploring further.`,
    `# ${page.title}`,
    page.description ? `> ${page.description}` : "",
    prefixInternalMarkdownLinks(page.markdown, basePath)
  ];

  return `${sections.filter(Boolean).join("\n\n").trim()}\n`;
}

function clientScript(basePath = ""): string {
  const design = resolvedDesign();
  return `(() => {
  const basePath = ${JSON.stringify(basePath)};
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

  function withBasePath(path) {
    if (!basePath || !path.startsWith('/')) return path;
    if (path === basePath || path.startsWith(basePath + '/')) return path;
    return basePath + path;
  }

  function pathWithoutBase(path) {
    if (!basePath) return path;
    if (path === basePath) return '/';
    if (path.startsWith(basePath + '/')) return path.slice(basePath.length) || '/';
    return path;
  }

  const themeIcons = {
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"></path></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>'
  };

  function setTheme(theme) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = normalized;
    document.documentElement.style.background = normalized === 'dark' ? ${JSON.stringify(design.darkBackground)} : ${JSON.stringify(design.lightBackground)};
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
      const response = await fetch(withBasePath('/api/chat'), {
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
    const response = await fetch(withBasePath('/api/search') + '?q=' + encodeURIComponent(query), { signal: controller.signal });
    const payload = await response.json();
    const items = payload.results || [];
    responseCache.set(cacheKey, items);
    renderAiResults(items);
    setSearchLoading(false);
  }

  function renderAiResults(items) {
    results.dataset.provider = 'external-search';
    if (!items.length && results.innerHTML) return;
    const previousActiveIndex = activeResultIndex;
    results.innerHTML = items.length
      ? renderResults(items, 'Enhanced results')
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
    setupMdxTabs();

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

  function setupMdxTabs() {
    document.querySelectorAll('[data-mdx-tabs]').forEach((group, groupIndex) => {
      const buttons = Array.from(group.querySelectorAll('[data-mdx-tab-button]'));
      const panels = Array.from(group.querySelectorAll('[data-mdx-tab-panel]'));
      buttons.forEach((button, index) => {
        const tabId = 'mdx-tab-' + groupIndex + '-' + index;
        const panelId = 'mdx-panel-' + groupIndex + '-' + index;
        button.id = tabId;
        button.setAttribute('aria-controls', panelId);
        panels[index]?.setAttribute('id', panelId);
        panels[index]?.setAttribute('aria-labelledby', tabId);
      });
    });
  }

  function selectMdxTab(button, focus = false) {
    const group = button.closest('[data-mdx-tabs]');
    if (!group) return;
    const selected = button.getAttribute('data-mdx-tab-button');
    group.querySelectorAll('[data-mdx-tab-button]').forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-selected', active ? 'true' : 'false');
      candidate.setAttribute('tabindex', active ? '0' : '-1');
    });
    group.querySelectorAll('[data-mdx-tab-panel]').forEach((panel) => {
      panel.toggleAttribute('hidden', panel.getAttribute('data-mdx-tab-panel') !== selected);
    });
    if (focus) button.focus();
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
    const routePath = pathWithoutBase(url.pathname);
    if (routePath.startsWith('/api/') || routePath === '/sitemap.xml' || routePath === '/robots.txt' || routePath === '/llms.txt') return;
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
    syncManagedMeta(nextDocument);
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

  function syncManagedMeta(nextDocument) {
    document.querySelectorAll('[data-docsflare-managed-meta]').forEach((node) => node.remove());
    const descriptionMeta = document.querySelector('meta[name="description"]');
    nextDocument.querySelectorAll('[data-docsflare-managed-meta]').forEach((node) => {
      document.head.insertBefore(node.cloneNode(true), descriptionMeta?.nextSibling || null);
    });
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
    const tabButton = target?.closest('[data-mdx-tab-button]');
    if (tabButton instanceof HTMLButtonElement) {
      event.preventDefault();
      selectMdxTab(tabButton);
      return;
    }
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
    if (target?.closest('[data-close-search]')) {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (target?.closest('[data-close-chat]')) {
      event.preventDefault();
      closeChat();
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
    const tabButton = event.target instanceof HTMLButtonElement ? event.target.closest('[data-mdx-tab-button]') : null;
    if (tabButton instanceof HTMLButtonElement && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const buttons = Array.from(tabButton.closest('[data-mdx-tabs]')?.querySelectorAll('[data-mdx-tab-button]') || []);
      const current = buttons.indexOf(tabButton);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      if (buttons[next] instanceof HTMLButtonElement) {
        event.preventDefault();
        selectMdxTab(buttons[next], true);
      }
      return;
    }
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

type ResolvedDesign = {
  lightBackground: string;
  darkBackground: string;
  lightPrimary: string;
  darkPrimary: string;
  primaryStrong: string;
  lightBackgroundImage: string;
  darkBackgroundImage: string;
  bodyFont: string;
  headingFont: string;
  monoFont: string;
};

function resolvedDesign(basePath = ""): ResolvedDesign {
  const fonts = recordFromUnknown(docsContent.site.fonts);
  const background = recordFromUnknown(docsContent.site.background);
  const backgroundColor = recordFromUnknown(background?.color);
  const backgroundImage = recordFromUnknown(background?.image);
  const bodyFont = fontValue(fonts?.body) ?? fontValue(fonts?.sans) ?? fontValue(docsContent.site.fonts);
  const headingFont = fontValue(fonts?.heading) ?? bodyFont;
  const monoFont = fontValue(fonts?.mono, "mono");
  const primary = safeCssValue(docsContent.site.colors?.primary, "#0f766e");

  return {
    lightBackground: safeCssValue(backgroundColor?.light ?? background?.color ?? (typeof docsContent.site.background === "string" ? docsContent.site.background : undefined), "#fbfcfd"),
    darkBackground: safeCssValue(backgroundColor?.dark ?? (typeof background?.color === "string" ? background.color : undefined), "#0d1117"),
    lightPrimary: primary,
    darkPrimary: safeCssValue(docsContent.site.colors?.light, primary),
    primaryStrong: safeCssValue(docsContent.site.colors?.dark, primary),
    lightBackgroundImage: backgroundImageCss(backgroundImage?.light ?? background?.image, background?.decoration, "light", basePath),
    darkBackgroundImage: backgroundImageCss(backgroundImage?.dark ?? (typeof background?.image === "string" ? background.image : undefined), background?.decoration, "dark", basePath),
    bodyFont: bodyFont ?? 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    headingFont: headingFont ?? bodyFont ?? 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    monoFont: monoFont ?? "ui-monospace, SFMono-Regular, Menlo, monospace"
  };
}

function backgroundImageCss(image: unknown, decoration: unknown, mode: "light" | "dark", basePath: string): string {
  const source = optionalCssUrl(image);
  if (source) return `url(${JSON.stringify(assetUrlWithBase(source, basePath))})`;
  if (decoration === "grid") {
    const line = mode === "dark" ? "rgba(255,255,255,.045)" : "rgba(15,23,42,.045)";
    return `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`;
  }
  if (decoration === "windows") {
    return mode === "dark"
      ? "radial-gradient(circle at 12% 8%, rgba(45,212,191,.10), transparent 28%), radial-gradient(circle at 88% 22%, rgba(96,165,250,.08), transparent 24%)"
      : "radial-gradient(circle at 12% 8%, rgba(20,184,166,.09), transparent 28%), radial-gradient(circle at 88% 22%, rgba(59,130,246,.07), transparent 24%)";
  }
  if (decoration === "gradient") {
    return mode === "dark"
      ? "radial-gradient(circle at 50% 0%, rgba(45,212,191,.09), transparent 34%)"
      : "radial-gradient(circle at 50% 0%, rgba(20,184,166,.08), transparent 34%)";
  }
  return "none";
}

function fontValue(value: unknown, kind: "sans" | "mono" = "sans"): string | undefined {
  const object = recordFromUnknown(value);
  if (typeof value === "string") return optionalCssValue(value);
  const family = optionalCssValue(object?.family);
  return family ? `${JSON.stringify(family)}, ${kind === "mono" ? "ui-monospace, monospace" : "ui-sans-serif, system-ui, sans-serif"}` : undefined;
}

function fontFaceCss(basePath: string): string {
  const fonts = recordFromUnknown(docsContent.site.fonts);
  if (!fonts) return "";
  const candidates = [fonts, recordFromUnknown(fonts.body), recordFromUnknown(fonts.heading), recordFromUnknown(fonts.mono)];
  const seen = new Set<string>();
  return candidates.flatMap((font) => {
    if (!font) return [];
    const family = optionalCssValue(font.family);
    const source = optionalCssUrl(font.source);
    if (!family || !source) return [];
    const key = `${family}\0${source}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const format = font.format === "woff" || font.format === "woff2" ? ` format(${JSON.stringify(font.format)})` : "";
    const weight = fontWeightValue(font.weight) ?? "100 900";
    return [`@font-face { font-family: ${JSON.stringify(family)}; src: url(${JSON.stringify(assetUrlWithBase(source, basePath))})${format}; font-style: normal; font-weight: ${weight}; font-display: swap; }\n`];
  }).join("");
}

function optionalCssValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 300 && !/[;{}<>]/.test(trimmed) ? trimmed : undefined;
}

function fontWeightValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000) return String(value);
  return optionalCssValue(value);
}

function optionalCssUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 2048 && !/[\n\r;{}<>]/.test(trimmed) ? trimmed : undefined;
}

function safeCssValue(value: unknown, fallback: string): string {
  return optionalCssValue(value) ?? fallback;
}

function assetUrlWithBase(source: string, basePath: string): string {
  return source.startsWith("//") ? source : routeWithBase(source, basePath);
}

function renderCustomCss(basePath = ""): string {
  if (typeof docsContent.customCss !== "string" || !docsContent.customCss.trim()) return "";
  // Keep project CSS last in the cascade while preventing an accidental style end tag
  // from changing the surrounding generated document.
  const cssText = docsContent.customCss
    .replace(/url\(\s*(?:(["'])(\/(?!\/)[^"']*)\1|(\/(?!\/)[^)\s]*))\s*\)/gi, (_match, quote: string | undefined, quotedPath: string | undefined, barePath: string | undefined) => {
      const path = quotedPath ?? barePath;
      if (!path) return _match;
      const rewritten = routeWithBase(path, basePath);
      return `url(${quote ?? ""}${rewritten}${quote ?? ""})`;
    })
    .replace(/<\/style/gi, "<\\/style");
  return `<style data-docsflare-custom-css>${cssText}</style>`;
}

function css(basePath = ""): string {
  const design = resolvedDesign(basePath);
  return `${fontFaceCss(basePath)}:root {
  color-scheme: light;
  --docsflare-color-primary: ${design.lightPrimary};
  --docsflare-color-primary-strong: ${design.primaryStrong};
  --docsflare-color-primary-dark: var(--docsflare-color-primary-strong);
  --docsflare-color-background: ${design.lightBackground};
  --docsflare-color-surface: #ffffff;
  --docsflare-color-surface-muted: #f3f6f8;
  --docsflare-color-text: #17202a;
  --docsflare-color-text-muted: #687483;
  --docsflare-color-border: #dfe5ea;
  --docsflare-color-code-background: #101923;
  --docsflare-background-image: ${design.lightBackgroundImage};
  --docsflare-font-body: ${design.bodyFont};
  --docsflare-font-heading: ${design.headingFont};
  --docsflare-font-mono: ${design.monoFont};
  --docsflare-space-1: 4px; --docsflare-space-2: 8px; --docsflare-space-3: 12px;
  --docsflare-space-4: 16px; --docsflare-space-5: 24px; --docsflare-space-6: 32px;
  --docsflare-radius-sm: 6px;
  --docsflare-radius-md: 10px;
  --docsflare-radius-lg: 12px;
  --docsflare-radius-pill: 999px;
  --docsflare-radius: var(--docsflare-radius-md);
  --docsflare-radius-small: var(--docsflare-radius-sm);
  --docsflare-content-width: 720px;
  --docsflare-sidebar-width: 286px;
  --docsflare-space-page: 36px;
  --docsflare-color-muted: var(--docsflare-color-text-muted);
  --docsflare-component-background: var(--docsflare-color-surface);
  --docsflare-component-background-hover: var(--docsflare-color-surface-muted);
  --docsflare-component-border: var(--docsflare-color-border);
  --docsflare-component-shadow: 0 1px 2px rgba(15,23,42,.025);
  --docsflare-heading-weight: 760;
  --bg: var(--docsflare-color-background); --surface: var(--docsflare-color-surface); --surface-alt: var(--docsflare-color-surface-muted);
  --text: var(--docsflare-color-text); --muted: var(--docsflare-color-muted); --line: var(--docsflare-color-border);
  --primary: var(--docsflare-color-primary); --code: var(--docsflare-color-code-background);
  --topbar-height: 104px; --sidebar-width: var(--docsflare-sidebar-width); --toc-width: 220px; --radius: var(--docsflare-radius);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --docsflare-color-primary: ${design.darkPrimary};
  --docsflare-color-background: ${design.darkBackground};
  --docsflare-color-surface: #121820; --docsflare-color-surface-muted: #18212b;
  --docsflare-color-text: #e7edf3; --docsflare-color-text-muted: #9aa8b7;
  --docsflare-color-border: #26313d; --docsflare-color-code-background: #070b10;
  --docsflare-background-image: ${design.darkBackgroundImage};
  --docsflare-component-shadow: 0 1px 2px rgba(0, 0, 0, .18);
}
* { box-sizing: border-box; }
html { background: var(--bg); scroll-padding-top: calc(var(--topbar-height) + 24px); }
body { margin: 0; background-color: var(--bg); background-image: var(--docsflare-background-image); background-size: ${recordFromUnknown(docsContent.site.background)?.decoration === "grid" ? "24px 24px" : "cover"}; background-attachment: fixed; color: var(--text); font: 14.5px/1.72 var(--docsflare-font-body); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
a { color: inherit; text-decoration: none; }

h1, h2, h3, h4, h5, h6 { font-family: var(--docsflare-font-heading); }
code, pre, kbd { font-family: var(--docsflare-font-mono); }

.topbar { position: sticky; top: 0; z-index: 20; height: var(--topbar-height); border-bottom: 1px solid var(--line); background: var(--surface); }
.topbar-inner, .top-tabs, .app { max-width: 1380px; margin: 0 auto; padding-inline: var(--docsflare-space-page); }
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
.primary-action { height: 32px; display: inline-flex; align-items: center; border: 1px solid var(--docsflare-color-primary-strong); border-radius: 6px; background: var(--docsflare-color-primary-strong); color: white; padding: 0 12px; font-size: 13px; font-weight: 650; white-space: nowrap; }
.theme-toggle { width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; }
.theme-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.mobile-icons, .mobile-crumb { display: none; }

.search-trigger, .mdx-card, .mdx-accordion, .mdx-expandable, .mdx-tabs, .mdx-code-group, .mdx-frame, .mdx-panel, .mdx-field, .mdx-example, .mdx-prompt, .mdx-tree, .pager a, .search-dialog, .chat-dialog, .chat-message.assistant, .chat-form textarea, kbd { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.search-trigger { width: 100%; height: 34px; justify-content: space-between; color: var(--muted); padding: 0 10px; font: inherit; cursor: pointer; }
.top-search { position: absolute; left: 50%; top: 50%; width: min(420px, calc(100% - 560px)); height: 36px; background: var(--bg); font-size: 13px; transform: translate(-50%, -50%); }
kbd { border-radius: 4px; padding: 0 5px; color: var(--muted); font: 10.5px var(--docsflare-font-mono); }

.app { min-height: calc(100vh - var(--topbar-height)); display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); }
.mobile-nav-overlay { display: none; }
.sidebar { position: sticky; top: var(--topbar-height); height: calc(100vh - var(--topbar-height)); border-right: 1px solid var(--line); padding: 30px 24px 32px 0; overflow-y: auto; overflow-x: hidden; }
.sidebar > .search-trigger { display: none; }
.sidebar-anchors { display: grid; gap: 4px; margin-bottom: 28px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.sidebar-anchors a { display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: center; gap: 8px; padding: 6px 8px; }
.sidebar-anchor-icon { display: grid; place-items: center; color: var(--primary); }
.sidebar-anchor-icon svg { width: 16px; height: 16px; }
.sidebar nav, .sidebar nav section { min-width: 0; max-width: 100%; }
.sidebar nav section + section { margin-top: 24px; }
.sidebar nav h2 { margin: 0 0 8px; color: var(--text); font-size: 12.5px; line-height: 1.35; font-weight: 720; }
.sidebar nav h2 a { color: inherit; }
.sidebar nav h2 a:hover { color: var(--text); }
.sidebar nav .api-nav-section h2 { text-transform: none; font-size: 13px; }
.sidebar nav a { display: block; max-width: 100%; border-radius: 7px; color: var(--muted); font-size: 13.5px; line-height: 1.45; padding: 6px 10px; overflow-wrap: anywhere; transition: background-color .15s ease, color .15s ease; }
.sidebar nav a.api-operation-link { display: grid; grid-template-columns: 54px minmax(0, 1fr); align-items: baseline; column-gap: 8px; }
.api-nav-method { border-radius: 5px; padding: 3px 5px; color: white; text-align: center; white-space: nowrap; font: 700 10px/1 var(--docsflare-font-mono); }
.sidebar nav a:hover { background: var(--surface-alt); color: var(--text); }
.sidebar nav a.active { background: color-mix(in srgb, var(--primary) 10%, var(--surface)); color: var(--primary); font-weight: 690; }

.main { min-width: 0; display: grid; grid-template-columns: minmax(0, var(--docsflare-content-width)) var(--toc-width); gap: 72px; padding: 50px 0 96px 44px; }
.doc { min-width: 0; max-width: var(--docsflare-content-width); }
.eyebrow { margin: 0 0 10px; color: var(--primary); font-size: 13px; font-weight: 700; }
h1 { margin: 0; color: var(--text); font-size: 34px; line-height: 1.16; letter-spacing: -.025em; font-weight: var(--docsflare-heading-weight); }
.description { margin: 13px 0 0; max-width: 640px; color: var(--muted); font-size: 17.5px; line-height: 1.6; }
.content { margin-top: 38px; color: color-mix(in srgb, var(--text) 88%, var(--muted)); font-size: 15px; line-height: 1.72; }
.content h2, .content h3 { color: var(--text); letter-spacing: 0; }
.content h2 { margin: 50px 0 15px; padding-top: 4px; font-size: 22px; line-height: 1.32; font-weight: 730; }
.content h3 { margin: 36px 0 12px; font-size: 17.5px; line-height: 1.42; font-weight: 710; }
.content p, .content ul, .content ol { margin: 18px 0; }
.content ul, .content ol { padding-left: 1.45rem; }
.content li { margin: 8px 0; padding-left: 3px; }
.content a { color: var(--primary); text-decoration: none; font-weight: 500; }
.content a:hover { text-decoration: underline; text-underline-offset: 3px; }
.content blockquote { position: relative; margin: 22px 0; border: 1px solid color-mix(in srgb, var(--primary) 20%, var(--line)); border-left: 4px solid color-mix(in srgb, var(--primary) 72%, var(--line)); border-radius: 4px 11px 11px 4px; background: color-mix(in srgb, var(--primary) 5%, var(--surface)); color: color-mix(in srgb, var(--text) 92%, var(--muted)); padding: 15px 18px 15px 19px; box-shadow: 0 1px 2px rgba(15, 23, 42, .025); }
.content blockquote::before { content: "Prompt"; display: block; margin-bottom: 7px; color: var(--primary); font-size: 10.5px; line-height: 1; font-weight: 760; letter-spacing: .08em; text-transform: uppercase; }
.content blockquote > :first-child { margin-top: 0; }
.content blockquote > :last-child { margin-bottom: 0; }
.content pre { overflow-x: auto; border: 1px solid color-mix(in srgb, var(--line) 70%, #000); border-radius: var(--radius); background: var(--code); color: #e5edf5; padding: 16px; line-height: 1.58; }
.content code { border-radius: 4px; background: var(--surface-alt); color: var(--text); padding: 2px 5px; font: 12.5px var(--docsflare-font-mono); }
.content pre code { background: transparent; padding: 0; color: inherit; }
.content table { display: block; width: 100%; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 26px 0; font-size: 13.5px; line-height: 1.48; scrollbar-width: thin; }
.content th, .content td { border-bottom: 1px solid var(--line); padding: 11px 10px; text-align: left; vertical-align: top; }
.content th { color: var(--text); font-weight: 700; }
.heading-anchor { text-decoration: none !important; color: inherit !important; }

.api-doc { grid-column: 1 / -1; max-width: none; }
.api-doc .content { margin-top: 0; }
.api-reference-page { display: grid; grid-template-columns: minmax(0, 720px) minmax(320px, 430px); align-items: start; gap: 56px; }
.api-reference-main h1 { margin-bottom: 14px; }
.api-description { margin: 0 0 24px; color: var(--muted); font-size: 16px; line-height: 1.6; }
.api-route-row { display: flex; align-items: center; gap: 10px; overflow-x: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 10px 12px; }
.api-route-row code { flex: 1 1 auto; min-width: 0; overflow-x: auto; background: transparent; padding: 0; color: var(--text); font-size: 13px; }
.api-method { flex: 0 0 auto; min-width: 56px; border-radius: 5px; padding: 5px 8px; color: white; text-align: center; font: 700 11px/1 var(--docsflare-font-mono); }
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
.copy-button { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-alt); color: var(--muted); padding: 5px 9px; font: 700 11px/1 var(--docsflare-font-body); cursor: pointer; }
.copy-button:hover { border-color: color-mix(in srgb, var(--primary) 35%, var(--line)); color: var(--text); }
.copy-button:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 26%, transparent); outline-offset: 2px; }
.copy-button.copied { border-color: color-mix(in srgb, var(--primary) 45%, var(--line)); color: var(--primary); }
.copy-button-dark { border-color: rgba(255, 255, 255, .14); background: rgba(255, 255, 255, .06); color: #c8d3df; }
.copy-button-dark:hover { border-color: rgba(255, 255, 255, .28); color: #fff; }
.copy-button-dark.copied { border-color: rgba(20, 184, 166, .58); color: #7dd3c7; }

.sr-only { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.mdx-card-group, .mdx-columns, .mdx-tile-group { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 14px; margin: 26px 0; }
.mdx-card, .mdx-accordion, .mdx-expandable, .mdx-frame, .mdx-panel, .mdx-prompt, .mdx-tree, .pager a { padding: 14px; }
.mdx-card { position: relative; min-height: 166px; display: block; padding: 20px; border-radius: var(--docsflare-radius-lg); text-decoration: none !important; box-shadow: var(--docsflare-component-shadow); transition: border-color .15s ease, background-color .15s ease, box-shadow .15s ease, transform .15s ease; }
.mdx-card-group[data-cols="1"] .mdx-card, .content > .mdx-card { min-height: 112px; }
.mdx-card[href]::after { content: ""; position: absolute; right: 18px; top: 20px; width: 7px; height: 7px; border-top: 1.5px solid var(--muted); border-right: 1.5px solid var(--muted); transform: rotate(45deg); }
.mdx-card:hover { border-color: color-mix(in srgb, var(--primary) 38%, var(--line)); background: color-mix(in srgb, var(--primary) 3%, var(--surface)); box-shadow: 0 8px 24px rgba(15, 23, 42, .07); transform: translateY(-1px); }
.mdx-card-icon { display: grid; place-items: center; width: 34px; height: 34px; margin-bottom: 17px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 9px; background: color-mix(in srgb, currentColor 9%, transparent); color: var(--primary); }
.mdx-card-icon svg { display: block; width: 18px; height: 18px; }
.mdx-card strong, .mdx-card div { display: block; }
.mdx-card strong { color: var(--text); font-weight: 700; }
.mdx-card div { margin-top: 8px; color: color-mix(in srgb, var(--muted) 92%, var(--text)); font-size: 14px; line-height: 1.58; }
.mdx-card div p { margin: 0; }

.mdx-callout { --callout-color: var(--primary); display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 11px; border: 1px solid color-mix(in srgb, var(--callout-color) 25%, var(--line)); border-radius: var(--radius); background: color-mix(in srgb, var(--callout-color) 7%, var(--surface)); padding: 13px 16px; margin: 20px 0; }
.mdx-callout-info { --callout-color: #3b82f6; }
.mdx-callout-note { --callout-color: #64748b; }
.mdx-callout-tip { --callout-color: #8b5cf6; }
.mdx-callout-warning { --callout-color: #d97706; }
.mdx-callout-check { --callout-color: #059669; }
.mdx-callout-danger { --callout-color: #dc2626; }
.mdx-callout-icon { display: grid; place-items: center; align-self: start; width: 20px; height: 20px; margin-top: 2px; color: var(--callout-color); }
.mdx-callout-icon svg { width: 17px; height: 17px; }
.mdx-callout p:first-child, .mdx-update h2 { margin-top: 0; }
.mdx-callout p:last-child { margin-bottom: 0; }
.mdx-accordion, .mdx-expandable { margin: 11px 0; padding: 0; overflow: clip; }
.mdx-accordion summary, .mdx-expandable summary { position: relative; cursor: pointer; list-style: none; color: var(--text); font-weight: 670; padding: 15px 46px 15px 17px; }
.mdx-accordion summary::-webkit-details-marker, .mdx-expandable summary::-webkit-details-marker { display: none; }
.mdx-accordion summary::after, .mdx-expandable summary::after { content: "+"; position: absolute; right: 16px; top: 50%; color: var(--muted); font-size: 19px; font-weight: 400; transform: translateY(-50%); }
.mdx-accordion[open] summary::after, .mdx-expandable[open] summary::after { content: "−"; }
.mdx-accordion > div, .mdx-expandable > div { border-top: 1px solid var(--line); padding: 4px 16px 14px; }
.mdx-accordion-group { margin: 20px 0; }
.mdx-expandable { border-style: dashed; }
.mdx-expandable summary { color: var(--primary); font-size: 13px; }
.mdx-tabs { overflow: hidden; margin: 20px 0; }
.mdx-tab-list { display: flex; gap: 4px; overflow-x: auto; border-bottom: 1px solid var(--line); background: var(--surface-alt); padding: 7px 8px 0; scrollbar-width: none; }
.mdx-tab-list::-webkit-scrollbar { display: none; }
.mdx-tab-button { position: relative; flex: 0 0 auto; border: 0; background: transparent; color: var(--muted); padding: 8px 11px 10px; font: 650 12.5px/1.2 var(--docsflare-font-body); cursor: pointer; }
.mdx-tab-button::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: transparent; }
.mdx-tab-button:hover, .mdx-tab-button.active { color: var(--text); }
.mdx-tab-button.active::after { background: var(--primary); }
.mdx-tab-button:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 30%, transparent); outline-offset: -2px; border-radius: 5px; }
.mdx-tab-panel { padding: 16px; }
.mdx-tab-panel[hidden] { display: none; }
.mdx-tab-panel > :first-child { margin-top: 0; }
.mdx-tab-panel > :last-child { margin-bottom: 0; }
.mdx-code-group { padding: 0; margin: 20px 0; }
.mdx-code-group:not(.mdx-tabs) { padding: 10px; }
.mdx-code-group pre, .mdx-card div p, .mdx-tab-panel pre { margin: 0; }
.mdx-code-group pre + pre { margin-top: 10px; }

.mdx-steps { counter-reset: steps; list-style: none; padding-left: 0; }
.mdx-steps li { position: relative; padding-left: 46px; padding-bottom: 24px; }
.mdx-steps li::before { counter-increment: steps; content: counter(steps); position: absolute; left: 0; top: 2px; display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--primary); font-weight: 720; font-size: 13px; }
.mdx-steps li::after { content: ""; position: absolute; left: 12px; top: 32px; bottom: 0; width: 1px; background: var(--line); }
.mdx-steps li:last-child::after { display: none; }
.mdx-steps li > strong { display: block; margin: 1px 0 7px; color: var(--text); font-size: 15px; }
.mdx-steps li > div > :first-child { margin-top: 0; }
.mdx-steps li > div > :last-child { margin-bottom: 0; }
.mdx-frame { margin: 22px 0; padding: 8px; text-align: center; }
.mdx-frame > img, .mdx-frame > video { display: block; max-width: 100%; height: auto; border-radius: 5px; }
.mdx-frame figcaption { padding: 8px 6px 1px; color: var(--muted); font-size: 12px; }
.mdx-column > :first-child, .mdx-panel > div > :first-child { margin-top: 0; }
.mdx-column > :last-child, .mdx-panel > div > :last-child { margin-bottom: 0; }
.mdx-panel { margin: 20px 0; background: var(--surface-alt); }
.mdx-panel > strong { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--text); }
.mdx-inline-icon, .mdx-icon { display: inline-grid; place-items: center; vertical-align: -.18em; }
.mdx-inline-icon svg, .mdx-icon svg { width: 1em; height: 1em; }
.mdx-banner { border-left: 3px solid var(--primary); border-radius: 0 var(--radius) var(--radius) 0; background: color-mix(in srgb, var(--primary) 8%, var(--surface)); padding: 12px 15px; margin: 20px 0; }
.mdx-banner > :first-child { margin-top: 0; }
.mdx-banner > :last-child { margin-bottom: 0; }
.mdx-badge { --badge-color: var(--primary); display: inline-flex; align-items: center; border: 1px solid color-mix(in srgb, var(--badge-color) 28%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--badge-color) 9%, var(--surface)); color: var(--badge-color); padding: 2px 7px; font-size: 11px; line-height: 1.3; font-weight: 700; vertical-align: .08em; }
.mdx-tooltip { position: relative; border-bottom: 1px dotted var(--muted); cursor: help; }
.mdx-tooltip:hover::after, .mdx-tooltip:focus::after { content: attr(data-tooltip); position: absolute; z-index: 5; left: 50%; bottom: calc(100% + 8px); width: max-content; max-width: 240px; border: 1px solid var(--line); border-radius: 6px; background: var(--text); color: var(--surface); padding: 6px 8px; font-size: 12px; line-height: 1.4; transform: translateX(-50%); box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.mdx-color { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 7px; padding: 5px 9px 5px 5px; }
.mdx-color-swatch { width: 22px; height: 22px; border: 1px solid color-mix(in srgb, var(--text) 18%, transparent); border-radius: 5px; }
.mdx-tile { display: grid; place-items: center; min-height: 116px; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--text) !important; padding: 16px; text-align: center; text-decoration: none !important; }
.mdx-tile:hover { border-color: color-mix(in srgb, var(--primary) 42%, var(--line)); background: color-mix(in srgb, var(--primary) 3%, var(--surface)); }
.mdx-tile-icon { display: grid; place-items: center; color: var(--primary); }
.mdx-tile-icon svg { width: 24px; height: 24px; }
.mdx-field { margin: 12px 0; padding: 14px 16px; }
.mdx-field-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.mdx-field-heading > code { background: transparent; padding: 0; color: var(--text); font-weight: 700; }
.mdx-field-type { color: var(--primary); font: 12px var(--docsflare-font-mono); }
.mdx-field.deprecated { opacity: .72; }
.mdx-field.deprecated .mdx-field-heading > code { text-decoration: line-through; }
.mdx-field-default { margin-top: 6px; color: var(--muted); font-size: 12px; }
.mdx-field-body > :first-child { margin-top: 8px; }
.mdx-field-body > :last-child { margin-bottom: 0; }
.mdx-example { margin: 20px 0; overflow: hidden; }
.mdx-example > strong { display: block; border-bottom: 1px solid var(--line); background: var(--surface-alt); padding: 9px 12px; color: var(--muted); font-size: 12px; }
.mdx-example > .mdx-code-group { margin: -1px; border-radius: 0; }
.mdx-tree { margin: 20px 0; font: 13px/1.7 var(--docsflare-font-mono); }
.mdx-tree ul { margin: 0; padding-left: 20px; list-style: none; }
.mdx-tree > ul { padding-left: 0; }
.mdx-tree li { margin: 2px 0; padding-left: 0; }
.mdx-tree-folder > span { color: var(--text); font-weight: 650; }
.mdx-tree-file > span { color: var(--muted); }
.mdx-prompt { position: relative; margin: 20px 0; overflow: hidden; }
.mdx-prompt > strong { display: block; border-bottom: 1px solid var(--line); background: var(--surface-alt); padding: 9px 13px; }
.mdx-prompt > div { padding: 2px 14px; }
.mdx-update { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 16px; margin: 34px 0; }
.mdx-update::before { content: ""; position: absolute; left: 6px; top: 18px; bottom: -22px; width: 2px; background: var(--line); }
.mdx-update-marker { position: relative; z-index: 1; width: 14px; height: 14px; margin-top: 8px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 0 5px var(--bg); }
.mdx-update-description { margin-top: -6px; color: var(--muted); font-weight: 650; }

.pager { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 72px; padding-top: 30px; border-top: 1px solid var(--line); }
.pager a { min-height: 74px; padding: 16px 18px; border-radius: 12px; font-weight: 670; transition: border-color .15s ease, background-color .15s ease, transform .15s ease; }
.pager a:hover { border-color: color-mix(in srgb, var(--primary) 34%, var(--line)); background: color-mix(in srgb, var(--primary) 3%, var(--surface)); transform: translateY(-1px); }
.pager a:last-child { text-align: right; }
.pager span { display: block; color: var(--muted); font-size: 12px; font-weight: 500; }

.toc { position: sticky; top: calc(var(--topbar-height) + 30px); height: fit-content; max-height: calc(100vh - var(--topbar-height) - 60px); overflow-y: auto; border-left: 1px solid var(--line); padding-left: 18px; color: var(--muted); font-size: 13px; }
.toc p { margin: 0 0 11px; color: var(--text); font-weight: 700; }
.toc a { display: block; padding: 4px 0; color: var(--muted); line-height: 1.5; }
.toc a:hover, .toc a.active { color: var(--primary); }
.toc a.active { font-weight: 680; }
.toc .depth-3 { padding-left: 12px; }

.search-panel { position: fixed; inset: 0; background: rgba(13, 17, 23, .32); padding: 10vh 18px 18px; z-index: 100; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
.search-dialog, .chat-dialog { overflow: hidden; box-shadow: 0 18px 54px rgba(13, 17, 23, .22); }
.search-dialog { max-width: 700px; margin: 0 auto; }
.search-box { display: grid; grid-template-columns: minmax(0, 1fr) 56px; border-bottom: 1px solid var(--line); }
.search-box input, .search-box button { height: 54px; border: 0; background: transparent; font: inherit; font-size: 16px; }
.search-box input { padding: 0 18px; outline: none; }
.search-box button, .chat-header button { color: var(--muted); cursor: pointer; }
.overlay-close { display: grid; place-items: center; }
.overlay-close:hover { color: var(--text); background: var(--surface-alt); }
.overlay-close span { position: relative; display: block; width: 16px; height: 16px; }
.overlay-close span::before, .overlay-close span::after { content: ""; position: absolute; left: 7px; top: 1px; width: 2px; height: 14px; border-radius: 2px; background: currentColor; }
.overlay-close span::before { transform: rotate(45deg); }
.overlay-close span::after { transform: rotate(-45deg); }
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

.chat-launcher { position: fixed; right: 22px; bottom: 22px; z-index: 9; height: 42px; border: 1px solid color-mix(in srgb, var(--primary) 20%, var(--line)); border-radius: 999px; background: var(--surface); color: var(--text); padding: 0 17px; box-shadow: 0 8px 26px rgba(15, 23, 42, .11); font: inherit; font-weight: 680; cursor: pointer; }
.chat-launcher:hover { border-color: color-mix(in srgb, var(--primary) 38%, var(--line)); color: var(--primary); }
.chat-panel { position: fixed; right: 22px; bottom: 76px; z-index: 11; width: min(420px, calc(100vw - 32px)); }
.chat-header { justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding: 14px 16px; }
.chat-header strong, .chat-header span { display: block; }
.chat-header span { font-size: 12px; }
.chat-header button { flex: 0 0 auto; width: 38px; height: 38px; border: 0; border-radius: 6px; background: transparent; font: inherit; }
.chat-messages { height: min(460px, 55vh); overflow-y: auto; padding: 14px; background: var(--bg); }
.chat-message { max-width: 88%; border-radius: var(--radius); padding: 10px 12px; margin: 0 0 10px; white-space: pre-wrap; }
.chat-message p { margin: 0; }
.chat-message.user { margin-left: auto; background: var(--primary); color: white; }
.chat-message.assistant { color: color-mix(in srgb, var(--text) 82%, var(--muted)); }
.chat-sources { display: grid; gap: 4px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.chat-sources span { color: var(--muted); font-size: 12px; font-weight: 650; }
.chat-sources a { color: var(--primary); font-size: 13px; }
.chat-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; border-top: 1px solid var(--line); padding: 12px; background: var(--surface); }
.chat-form textarea { min-height: 40px; max-height: 120px; resize: vertical; padding: 9px 10px; font: inherit; font-size: 16px; outline: none; }
.chat-form button { border: 0; border-radius: 6px; background: var(--primary); color: white; padding: 0 14px; font: inherit; font-size: 16px; font-weight: 680; cursor: pointer; }
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
  .topbar { height: var(--topbar-height); position: sticky; top: 0; }
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
  .main { display: block; padding: 42px 20px 72px; }
  h1 { font-size: 28px; line-height: 1.22; }
  .description { font-size: 16.5px; line-height: 1.58; }
  .content { margin-top: 38px; font-size: 14.5px; line-height: 1.7; }
  .content h2 { margin-top: 44px; font-size: 21px; }
  .content h3 { margin-top: 32px; }
  .mdx-card-group, .mdx-columns, .mdx-tile-group, .pager { grid-template-columns: 1fr; }
  .api-reference-page { display: block; }
  .api-example-panel { margin-top: 28px; }
  .api-route-row { align-items: flex-start; flex-direction: column; }
  .api-route-row code { white-space: nowrap; max-width: 100%; overflow-x: auto; }
  .mdx-card { min-height: 148px; padding: 18px; }
  .content > .mdx-card { min-height: 136px; }
  .content table { font-size: 12.5px; }
  .content th, .content td { padding: 10px 9px; }
  .content blockquote { margin: 18px 0; padding: 14px 15px 14px 16px; }
  .pager a:last-child { text-align: left; }
  .search-panel { padding: 72px 12px 18px; }
  .search-dialog { width: 100%; max-width: 640px; }
  .search-box { grid-template-columns: minmax(0, 1fr) 64px; }
  .search-box input, .search-box button, .chat-form textarea, .chat-form button { font-size: 16px; }
  .search-box input { padding-inline: 14px; }
  .search-results { max-height: min(520px, calc(100dvh - 150px)); overscroll-behavior: contain; }
  .chat-launcher { right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); min-height: 44px; padding-inline: 16px; }
  .chat-panel { left: 12px; right: 12px; bottom: calc(72px + env(safe-area-inset-bottom)); width: auto; }
  .chat-messages { height: min(360px, 48dvh); overscroll-behavior: contain; }
  .chat-form { grid-template-columns: minmax(0, 1fr) 68px; padding: 10px 10px calc(10px + env(safe-area-inset-bottom)); }
  .chat-form textarea { min-height: 44px; max-height: 120px; }
  .chat-form button { min-height: 44px; padding-inline: 0; }
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

function markdownResponse(markdown: string, basePath = ""): Response {
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": "inline",
      "link": `<${routeWithBase("/llms.txt", basePath)}>; rel="llms-txt"`,
      "vary": "accept",
      "x-llms-txt": routeWithBase("/llms.txt", basePath)
    }
  });
}

function xmlResponse(xml: string): Response {
  return textResponse(xml, "application/xml; charset=utf-8");
}

function redirectResponse(location: string, status = 301): Response {
  return new Response(null, {
    status,
    headers: {
      location,
      "cache-control": "public, max-age=3600"
    }
  });
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

function configuredBasePath(): string {
  return normalizeBasePath(docsContent.site.basePath ?? "");
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") return "";
  return normalizeRoute(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
}

function basePathForRequest(pathname: string, configuredBasePath: string): string {
  if (!configuredBasePath) return "";
  return pathname === configuredBasePath || pathname.startsWith(`${configuredBasePath}/`) ? configuredBasePath : "";
}

function stripBasePath(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

function routeWithBase(path: string, basePath: string): string {
  if (!basePath || !path.startsWith("/")) return path;
  if (path === basePath || path.startsWith(`${basePath}/`)) return path;
  return `${basePath}${path === "/" ? "" : path}`;
}

function redirectForMiss(route: string): string | undefined {
  const normalized = normalizeRoute(route);
  const hyphenated = normalized.replaceAll("_", "-");
  if (pageByRoute.has(hyphenated)) return hyphenated;

  const lastSegment = normalized.split("/").filter(Boolean).at(-1);
  const matchingPage = lastSegment
    ? pages.find((page) => normalizeRoute(page.route).split("/").at(-1) === lastSegment)
    : undefined;

  return matchingPage?.route;
}

function prefixInternalHtmlLinks(html: string, basePath: string): string {
  if (!basePath) return html;
  return html.replace(/\s(href|src)="(\/(?!\/)[^"#?]*)([^"]*)"/g, (match, attribute: string, path: string, suffix: string) => {
    if (path === basePath || path.startsWith(`${basePath}/`)) return match;
    return ` ${attribute}="${routeWithBase(path, basePath)}${suffix}"`;
  });
}

function prefixInternalMarkdownLinks(markdown: string, basePath: string): string {
  if (!basePath) return markdown;
  return markdown
    .replace(/\]\((\/(?!\/)[^)#?]*)([^)]*)\)/g, (_match, path: string, suffix: string) => `](${routeWithBase(path, basePath)}${suffix})`)
    .replace(/\s(href|src)="(\/(?!\/)[^"#?]*)([^"]*)"/g, (match, attribute: string, path: string, suffix: string) => {
      if (path === basePath || path.startsWith(`${basePath}/`)) return match;
      return ` ${attribute}="${routeWithBase(path, basePath)}${suffix}"`;
    });
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

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
