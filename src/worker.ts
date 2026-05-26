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
    globalAnchors?: Array<{ label: string; href: string }>;
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
    const route = normalizeRoute(url.pathname);

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

    if (!page) {
      return htmlResponse(renderShell(undefined, url, 404), 404);
    }

    return htmlResponse(renderShell(page, url), 200);
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

function renderShell(page: Page | undefined, url: URL, status = 200): string {
  const title = page ? `${page.title} - ${docsContent.site.name}` : `Not found - ${docsContent.site.name}`;
  const description = page?.description ?? `${docsContent.site.name} documentation`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  ${docsContent.site.favicon ? `<link rel="icon" href="${escapeHtml(docsContent.site.favicon)}">` : ""}
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
        <button class="mobile-menu" type="button" aria-label="Menu"><span></span></button>
      </div>
      <div class="top-actions">
        ${renderExternalLinks()}
        ${docsContent.site.navbar?.primary ? `<a class="primary-action" href="${escapeHtml(docsContent.site.navbar.primary.href)}">${escapeHtml(docsContent.site.navbar.primary.label)}</a>` : ""}
        <button class="theme-toggle" type="button" aria-label="Toggle theme">*</button>
      </div>
      <button class="search-trigger top-search" type="button" data-open-search>
        <span>Search...</span>
        <kbd>Cmd K</kbd>
      </button>
    </div>
    <nav class="top-tabs" aria-label="Documentation sections">${renderTopTabs(url.pathname)}</nav>
    ${renderMobileCrumb(url.pathname, page)}
  </header>
  <div class="app">
    <aside class="sidebar">
      <button class="search-trigger" type="button" data-open-search>
        <span>Search docs</span>
        <kbd>/</kbd>
      </button>
      ${renderSidebarAnchors()}
      <nav>${renderNav(url.pathname)}</nav>
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
  <button class="chat-launcher" type="button" data-open-chat>Ask AI</button>
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
  const logoPath = typeof logo === "string" ? logo : logo?.light ?? logo?.dark;

  if (logoPath) {
    return `<img class="brand-logo" src="${escapeHtml(logoPath)}" alt="${escapeHtml(docsContent.site.name)}">`;
  }

  return `<span class="brand-mark">${escapeHtml(docsContent.site.name.slice(0, 1))}</span><span>${escapeHtml(docsContent.site.name)}</span>`;
}

function renderArticle(page: Page): string {
  const pageIndex = pages.findIndex((candidate) => candidate.route === page.route);
  const previous = pages[pageIndex - 1];
  const next = pages[pageIndex + 1];
  const sectionLabel = currentSectionLabel(page.route);

  return `<article class="doc">
    <header>
      <p class="eyebrow">${escapeHtml(sectionLabel ?? page.sourcePath)}</p>
      <h1>${escapeHtml(page.title)}</h1>
      ${page.description ? `<p class="description">${escapeHtml(page.description)}</p>` : ""}
    </header>
    <div class="content">${stripLeadingH1(page.html)}</div>
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
  const activeTab = currentTabTitle(currentPath);
  const groups = activeTab ? docsContent.nav.filter((group) => groupTabTitle(group.title) === activeTab) : docsContent.nav;

  return groups
    .map((group) => {
      const groupTitle = groupDisplayTitle(group.title);
      return `<section>
        <h2>${escapeHtml(groupTitle)}</h2>
        ${group.pages
          .map((page) => {
            const active = normalizeRoute(currentPath) === normalizeRoute(page.route) ? "active" : "";
            return `<a class="${active}" href="${page.route}">${escapeHtml(page.title)}</a>`;
          })
          .join("")}
      </section>`;
    })
    .join("");
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
    ${links.map((link) => `<a href="${escapeHtml(link.href)}"><span class="sidebar-anchor-icon">${iconForLabel(link.label)}</span>${escapeHtml(link.label)}</a>`).join("")}
  </div>`;
}

function renderMobileCrumb(currentPath: string, page: Page | undefined): string {
  const section = currentSectionLabel(currentPath) ?? currentTabTitle(currentPath) ?? "Docs";
  return `<div class="mobile-crumb">
    <span class="mobile-menu-lines"></span>
    <span>${escapeHtml(section)}</span>
    <span class="mobile-separator">&gt;</span>
    <strong>${escapeHtml(page?.title ?? "Not found")}</strong>
  </div>`;
}

function iconForLabel(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("api") || lower.includes("console")) return "&lt;/&gt;";
  if (lower.includes("legacy")) return "~";
  return "[]";
}

function renderTableOfContents(page: Page): string {
  const headings = Array.from(page.html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g))
    .map((match) => ({
      depth: Number(match[1]),
      id: match[2],
      title: stripTags(match[3]).replace(/^#\s*/, "").trim()
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

function renderLegacyNav(currentPath: string): string {
  return docsContent.nav
    .map((group) => `<section>
      <h2>${escapeHtml(group.title)}</h2>
      ${group.pages
        .map((page) => {
          const active = normalizeRoute(currentPath) === normalizeRoute(page.route) ? "active" : "";
          return `<a class="${active}" href="${page.route}">${escapeHtml(page.title)}</a>`;
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
  const searchIndex = JSON.parse(document.getElementById('docs-search-index')?.textContent || '[]');
  const responseCache = new Map();
  const chatHistory = [];
  let controller;
  let debounceTimer;

  function openSearch() {
    panel.hidden = false;
    input.focus();
    if (input.value.trim()) renderLocalResults(input.value);
  }

  function closeSearch() {
    panel.hidden = true;
    input.value = '';
    results.innerHTML = '';
    if (controller) controller.abort();
  }

  function openChat() {
    chatPanel.hidden = false;
    chatInput.focus();
  }

  function closeChat() {
    chatPanel.hidden = true;
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
      return;
    }

    renderLocalResults(cleanQuery);
    debounceTimer = setTimeout(() => searchAi(cleanQuery).catch((error) => {
      if (error.name !== 'AbortError') results.dataset.provider = 'local';
    }), 160);
  }

  function renderLocalResults(query) {
    const items = localSearch(query);
    results.dataset.provider = 'local';
    results.innerHTML = items.length
      ? renderResults(items, 'Instant results')
      : '<p class="muted">No local results found. Checking AI Search...</p>';
  }

  async function searchAi(query) {
    const cacheKey = query.toLowerCase();
    if (responseCache.has(cacheKey)) {
      renderAiResults(responseCache.get(cacheKey));
      return;
    }

    controller = new AbortController();
    const response = await fetch('/api/search?q=' + encodeURIComponent(query), { signal: controller.signal });
    const payload = await response.json();
    const items = payload.results || [];
    responseCache.set(cacheKey, items);
    renderAiResults(items);
  }

  function renderAiResults(items) {
    results.dataset.provider = 'cloudflare-ai-search';
    if (!items.length && results.innerHTML) return;
    results.innerHTML = items.length
      ? renderResults(items, 'AI Search')
      : '<p class="muted">No results found.</p>';
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

  function escapeHtmlClient(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  }

  openButtons.forEach((button) => button.addEventListener('click', openSearch));
  closeButton.addEventListener('click', closeSearch);
  openChatButton.addEventListener('click', openChat);
  closeChatButton.addEventListener('click', closeChat);
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
  document.addEventListener('keydown', (event) => {
    if ((event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) && document.activeElement !== input) {
      event.preventDefault();
      openSearch();
    }
    if (event.key === 'Escape' && !panel.hidden) closeSearch();
    if (event.key === 'Escape' && !chatPanel.hidden) closeChat();
  });
  panel.addEventListener('click', (event) => {
    if (event.target === panel) closeSearch();
  });
})();`;
}

function css(): string {
  return `:root {
  color-scheme: light;
  --bg: #ffffff;
  --surface: #ffffff;
  --surface-alt: #f7f8fb;
  --text: #111827;
  --muted: #6b7280;
  --line: #e5e7eb;
  --primary: ${docsContent.site.colors.primary ?? "#0f766e"};
  --primary-dark: ${docsContent.site.colors.dark ?? "#134e4a"};
  --primary-light: ${docsContent.site.colors.light ?? docsContent.site.colors.primary ?? "#3f60c1"};
  --code: #0f172a;
  --topbar-height: 112px;
  --sidebar-width: 300px;
  --toc-width: 224px;
}
* { box-sizing: border-box; }
html { scroll-padding-top: calc(var(--topbar-height) + 24px); }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.7 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.topbar { position: sticky; top: 0; z-index: 20; height: var(--topbar-height); border-bottom: 1px solid var(--line); background: rgba(255,255,255,.92); backdrop-filter: blur(14px); }
.topbar-inner { position: relative; height: 64px; max-width: 1440px; margin: 0 auto; display: grid; grid-template-columns: 260px minmax(0, 1fr) 260px; align-items: center; gap: 20px; padding: 0 48px; }
.brand { min-width: 0; display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 15px; color: #1f2937; }
.brand span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand-logo { display: block; width: auto; height: 32px; max-width: 160px; object-fit: contain; object-position: left center; }
.brand-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px; background: var(--primary); color: white; flex: 0 0 auto; }
.brand-mark-image { background: transparent; overflow: hidden; }
.brand-mark img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.top-tabs { height: 48px; max-width: 1440px; margin: 0 auto; display: flex; align-items: flex-end; gap: 24px; padding: 0 48px; overflow-x: auto; scrollbar-width: none; }
.top-tabs::-webkit-scrollbar { display: none; }
.top-tabs a { flex: 0 0 auto; padding: 0 0 16px; border-bottom: 1px solid transparent; color: #4b5563; font-size: 14px; font-weight: 500; line-height: 1; }
.top-tabs a:hover { color: #111827; }
.top-tabs a.active { color: #111827; border-bottom-color: var(--primary); font-weight: 650; }
.top-actions { grid-column: 3; display: flex; align-items: center; justify-content: flex-end; gap: 16px; }
.top-link { color: #4b5563; font-size: 14px; font-weight: 500; white-space: nowrap; }
.top-link:hover { color: var(--primary); }
.primary-action { height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--primary); color: white; padding: 0 13px; font-size: 14px; font-weight: 600; white-space: nowrap; box-shadow: 0 1px 2px rgba(17,24,39,.08); }
.theme-toggle { width: 32px; height: 32px; display: grid; place-items: center; border: 0; background: transparent; color: #9ca3af; font-size: 18px; cursor: pointer; }
.mobile-icons, .mobile-crumb { display: none; }
.search-trigger { width: 100%; height: 36px; display: flex; align-items: center; justify-content: space-between; border: 1px solid var(--line); border-radius: 10px; background: #f9fafb; color: #6b7280; padding: 0 10px; font: inherit; cursor: pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,.6); }
.search-trigger:hover { border-color: #d1d5db; background: #fff; }
.top-search { grid-column: 2; grid-row: 1; justify-self: center; width: min(440px, 100%); height: 38px; border-radius: 12px; background: #fff; font-size: 14px; }
kbd { border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; background: #fff; color: #6b7280; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
.app { min-height: calc(100vh - var(--topbar-height)); max-width: 1440px; margin: 0 auto; display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); padding: 0 48px 0 32px; }
.sidebar { position: sticky; top: var(--topbar-height); height: calc(100vh - var(--topbar-height)); background: rgba(255,255,255,.98); padding: 32px 28px 32px 16px; overflow-y: auto; }
.sidebar > .search-trigger { display: none; }
.sidebar-anchors { display: grid; gap: 8px; margin-bottom: 32px; }
.sidebar-anchors a { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 12px; color: #4b5563; font-size: 14px; }
.sidebar-anchor-icon { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 6px; color: #9ca3af; background: #fafafa; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
.sidebar nav { margin-top: 0; }
.sidebar nav section + section { margin-top: 22px; }
.sidebar nav h2 { margin: 0 0 6px; color: #6b7280; font-size: 13px; line-height: 1.35; font-weight: 600; letter-spacing: 0; }
.sidebar nav a { display: block; border-radius: 8px; padding: 6px 10px; color: #4b5563; font-size: 13.5px; line-height: 1.45; }
.sidebar nav a:hover { color: #111827; background: #f9fafb; }
.sidebar nav a.active { background: color-mix(in srgb, var(--primary) 10%, white); color: var(--primary); font-weight: 600; }
.main { min-width: 0; display: grid; grid-template-columns: minmax(0, 690px) var(--toc-width); gap: 92px; padding: 42px 0 80px 16px; }
.doc { min-width: 0; max-width: 690px; }
.doc > header { padding-bottom: 4px; }
.eyebrow { margin: 0 0 10px; color: var(--primary); font-size: 14px; line-height: 1.25; font-weight: 650; }
h1 { margin: 0; font-size: 30px; line-height: 1.22; letter-spacing: 0; font-weight: 740; color: #111827; }
.description { margin: 10px 0 0; color: #4b5563; font-size: 18px; line-height: 1.6; }
.content { margin-top: 32px; color: #374151; }
.content h2 { margin: 42px 0 12px; padding-top: 4px; font-size: 22px; line-height: 1.35; letter-spacing: 0; font-weight: 700; color: #111827; }
.content h3 { margin: 30px 0 10px; font-size: 17px; line-height: 1.45; letter-spacing: 0; font-weight: 700; color: #111827; }
.content p, .content ul, .content ol { margin: 16px 0; }
.content ul, .content ol { padding-left: 1.45rem; }
.content li { margin: 7px 0; padding-left: 2px; }
.content a { color: var(--primary); text-decoration: none; font-weight: 500; }
.content a:hover { text-decoration: underline; text-underline-offset: 3px; }
.content pre { overflow-x: auto; border-radius: 12px; background: var(--code); color: #e5e7eb; padding: 16px; line-height: 1.6; border: 1px solid #1f2937; }
.content code { border-radius: 5px; background: #f3f4f6; color: #111827; padding: 2px 5px; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
.content pre code { background: transparent; padding: 0; color: inherit; }
.content table { width: 100%; border-collapse: collapse; margin: 20px 0; }
.content th, .content td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; }
.heading-anchor { text-decoration: none !important; color: inherit !important; }
.mdx-card-group { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 14px; margin: 22px 0; }
.mdx-card { position: relative; display: block; min-height: 206px; border: 1px solid #e5e7eb; border-radius: 14px; background: #fff; padding: 24px; text-decoration: none !important; box-shadow: 0 1px 2px rgba(17,24,39,.03); transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
.mdx-card-group[data-cols="1"] .mdx-card { min-height: 135px; }
.content > .mdx-card { min-height: 135px; padding: 22px 24px; }
.mdx-card[href]::after { content: ">"; position: absolute; right: 22px; top: 22px; color: #9ca3af; font-size: 14px; }
.mdx-card:hover { border-color: color-mix(in srgb, var(--primary) 38%, #d1d5db); box-shadow: 0 8px 24px rgba(17,24,39,.06); transform: translateY(-1px); }
.mdx-card-icon { display: block; width: 26px; height: 26px; margin-bottom: 22px; color: var(--primary-light); }
.content > .mdx-card .mdx-card-icon { margin-bottom: 20px; }
.mdx-card-icon svg { display: block; width: 100%; height: 100%; }
.mdx-card strong, .mdx-card div { display: block; }
.mdx-card strong { color: #111827; font-weight: 650; }
.mdx-card div { margin-top: 6px; color: #6b7280; font-size: 13.5px; line-height: 1.6; }
.mdx-card div p { margin: 0; }
.mdx-callout { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; border: 1px solid color-mix(in srgb, var(--primary) 22%, #e5e7eb); border-radius: 12px; background: color-mix(in srgb, var(--primary) 5%, white); padding: 14px 16px; margin: 20px 0; }
.mdx-callout::before { content: "i"; display: grid; place-items: center; width: 18px; height: 18px; margin-top: 2px; border-radius: 50%; background: var(--primary); color: white; font-size: 12px; font-weight: 700; font-family: ui-serif, Georgia, serif; }
.mdx-callout strong { color: var(--primary); font-size: 13px; }
.mdx-callout > strong { display: none; }
.mdx-callout div { min-width: 0; }
.mdx-callout p:first-child { margin-top: 0; }
.mdx-callout p:last-child { margin-bottom: 0; }
.mdx-accordion { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); padding: 12px 14px; margin: 12px 0; }
.mdx-accordion summary { cursor: pointer; font-weight: 650; }
.mdx-tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 20px 0; }
.mdx-tab { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 14px; }
.mdx-tab h3 { margin-top: 0; }
.mdx-code-group { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 10px; margin: 20px 0; }
.mdx-code-group pre { margin: 0; }
.mdx-code-group pre + pre { margin-top: 10px; }
.mdx-columns { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); gap: 16px; margin: 22px 0; }
.mdx-steps { counter-reset: steps; list-style: none; padding-left: 0; }
.mdx-steps li { position: relative; padding-left: 42px; padding-bottom: 18px; }
.mdx-steps li::before { counter-increment: steps; content: counter(steps); position: absolute; left: 0; top: 2px; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 999px; background: #fff; border: 1px solid var(--line); color: var(--primary); font-weight: 700; font-size: 13px; }
.mdx-steps li::after { content: ""; position: absolute; left: 12px; top: 32px; bottom: 0; width: 1px; background: var(--line); }
.mdx-steps li:last-child::after { display: none; }
.mdx-frame { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); padding: 10px; }
.mdx-update { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 16px; margin: 34px 0; }
.mdx-update::before { content: ""; position: absolute; left: 6px; top: 18px; bottom: -22px; width: 2px; background: var(--line); }
.mdx-update-marker { position: relative; z-index: 1; width: 14px; height: 14px; margin-top: 8px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 0 5px var(--surface-alt); }
.mdx-update h2 { margin-top: 0; }
.mdx-update-description { margin-top: -6px; color: var(--muted); font-weight: 650; }
.pager { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 56px; padding-top: 28px; border-top: 1px solid var(--line); }
.pager a { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 14px 16px; font-weight: 650; }
.pager a:last-child { text-align: right; }
.pager span { display: block; color: var(--muted); font-size: 12px; font-weight: 500; }
.toc { position: sticky; top: calc(var(--topbar-height) + 30px); height: fit-content; max-height: calc(100vh - var(--topbar-height) - 60px); overflow-y: auto; border-left: 1px solid var(--line); padding-left: 18px; color: #6b7280; font-size: 13px; }
.toc p { margin: 0 0 10px; color: #111827; font-weight: 650; }
.toc a { display: block; padding: 4px 0; color: #6b7280; line-height: 1.45; }
.toc a:hover { color: var(--primary); }
.toc .depth-3 { padding-left: 12px; }
.search-panel { position: fixed; inset: 0; background: rgba(13, 28, 24, .35); padding: 10vh 18px 18px; z-index: 10; }
.search-dialog { max-width: 720px; margin: 0 auto; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: 0 24px 70px rgba(13, 28, 24, .22); overflow: hidden; }
.search-box { display: grid; grid-template-columns: minmax(0, 1fr) 56px; border-bottom: 1px solid var(--line); }
.search-box input, .search-box button { height: 54px; border: 0; background: transparent; font: inherit; }
.search-box input { padding: 0 18px; outline: none; }
.search-box button { color: var(--muted); cursor: pointer; }
.search-results { max-height: min(520px, 62vh); overflow-y: auto; padding: 8px; }
.search-provider { padding: 8px 12px 4px; color: #6b7280; font-size: 12px; font-weight: 650; }
.search-result { display: block; border-radius: 7px; padding: 12px; }
.search-result:hover { background: var(--surface-alt); }
.search-result strong, .search-result span { display: block; }
.search-result span, .muted { color: var(--muted); }
.muted { padding: 12px; margin: 0; }
.chat-launcher { position: fixed; right: 22px; bottom: 22px; z-index: 9; height: 42px; border: 1px solid color-mix(in srgb, var(--primary) 25%, #d1d5db); border-radius: 999px; background: var(--primary); color: white; padding: 0 18px; font: inherit; font-weight: 650; box-shadow: 0 12px 30px rgba(17,24,39,.18); cursor: pointer; }
.chat-panel { position: fixed; right: 22px; bottom: 76px; z-index: 11; width: min(420px, calc(100vw - 32px)); }
.chat-dialog { border: 1px solid var(--line); border-radius: 16px; background: white; box-shadow: 0 24px 70px rgba(17,24,39,.22); overflow: hidden; }
.chat-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding: 14px 16px; }
.chat-header strong, .chat-header span { display: block; }
.chat-header span { color: var(--muted); font-size: 12px; }
.chat-header button { border: 0; background: transparent; color: var(--muted); font: inherit; cursor: pointer; }
.chat-messages { height: min(460px, 55vh); overflow-y: auto; padding: 14px; background: #fbfcfe; }
.chat-message { max-width: 88%; border-radius: 13px; padding: 10px 12px; margin: 0 0 10px; white-space: pre-wrap; }
.chat-message p { margin: 0; }
.chat-message.user { margin-left: auto; background: var(--primary); color: white; }
.chat-message.assistant { background: white; border: 1px solid var(--line); color: #374151; }
.chat-sources { display: grid; gap: 4px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.chat-sources span { color: var(--muted); font-size: 12px; font-weight: 650; }
.chat-sources a { color: var(--primary); font-size: 13px; }
.chat-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; border-top: 1px solid var(--line); padding: 12px; background: white; }
.chat-form textarea { min-height: 40px; max-height: 120px; resize: vertical; border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; font: inherit; outline: none; }
.chat-form textarea:focus { border-color: color-mix(in srgb, var(--primary) 45%, #d1d5db); }
.chat-form button { border: 0; border-radius: 10px; background: var(--primary); color: white; padding: 0 14px; font: inherit; font-weight: 650; cursor: pointer; }
@media (max-width: 1120px) {
  .topbar-inner { grid-template-columns: minmax(180px, var(--sidebar-width)) minmax(0, 1fr); }
  .top-actions { display: none; }
  .app { grid-template-columns: 244px minmax(0, 1fr); }
  .main { grid-template-columns: minmax(0, 760px); padding-left: 36px; padding-right: 0; }
  .toc { display: none; }
}
@media (max-width: 820px) {
  :root { --topbar-height: 120px; }
  .topbar { height: var(--topbar-height); position: static; }
  .topbar-inner { height: 64px; display: flex; justify-content: space-between; padding: 0 20px; }
  .brand-logo { height: 31px; max-width: 160px; }
  .mobile-icons { display: flex; align-items: center; gap: 18px; }
  .mobile-icons button { position: relative; width: 22px; height: 22px; border: 0; background: transparent; padding: 0; color: #4b5563; }
  .mobile-search::before { content: ""; position: absolute; left: 3px; top: 3px; width: 10px; height: 10px; border: 2px solid currentColor; border-radius: 50%; }
  .mobile-search::after { content: ""; position: absolute; left: 14px; top: 14px; width: 7px; height: 2px; background: currentColor; transform: rotate(45deg); transform-origin: left center; border-radius: 2px; }
  .mobile-menu::before, .mobile-menu::after, .mobile-menu span { content: ""; position: absolute; left: 9px; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
  .mobile-menu::before { top: 2px; }
  .mobile-menu span { top: 9px; }
  .mobile-menu::after { top: 16px; }
  .top-search, .top-tabs { display: none; }
  .mobile-crumb { height: 56px; display: flex; align-items: center; gap: 12px; border-top: 1px solid var(--line); padding: 0 20px; color: #6b7280; font-size: 14px; }
  .mobile-crumb strong { color: #111827; font-weight: 650; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mobile-menu-lines { position: relative; width: 18px; height: 14px; flex: 0 0 auto; }
  .mobile-menu-lines::before, .mobile-menu-lines::after { content: ""; position: absolute; left: 0; width: 14px; height: 2px; background: #6b7280; border-radius: 2px; }
  .mobile-menu-lines::before { top: 3px; }
  .mobile-menu-lines::after { top: 9px; }
  .app { display: block; padding: 0; }
  .sidebar { display: none; }
  .main { display: block; padding: 40px 20px 64px; }
  h1 { font-size: 25px; line-height: 1.28; }
  .description { font-size: 20px; }
  .content { margin-top: 36px; }
  .mdx-card-group, .mdx-tabs, .mdx-columns, .pager { grid-template-columns: 1fr; }
  .mdx-card { min-height: 174px; }
  .content > .mdx-card { min-height: 158px; }
  .pager a:last-child { text-align: left; }
  .mdx-callout { grid-template-columns: 1fr; gap: 4px; }
  .mdx-callout::before { display: none; }
  .chat-launcher { right: 16px; bottom: 16px; }
  .chat-panel { right: 16px; bottom: 68px; }
}`;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8"
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
