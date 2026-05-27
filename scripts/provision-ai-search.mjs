import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const instanceName = process.env.AI_SEARCH_INSTANCE || "docsflare-docs";
const namespace = process.env.AI_SEARCH_NAMESPACE || "default";
const searchDir = path.resolve(process.env.AI_SEARCH_DOCS_DIR || ".docsflare/search");
const accountId = process.env.DOCSFLARE_CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || "";
const apiToken = process.env.DOCSFLARE_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
const concurrency = positiveInteger(process.env.DOCSFLARE_SEARCH_CONCURRENCY, 6);

if (!accountId) {
  throw new Error("Missing Cloudflare account ID. Set DOCSFLARE_CLOUDFLARE_ACCOUNT_ID.");
}

if (!apiToken) {
  throw new Error("Missing Cloudflare API token. Set DOCSFLARE_CLOUDFLARE_API_TOKEN.");
}

const instancePath = `/accounts/${accountId}/ai-search/namespaces/${namespace}/instances/${instanceName}`;

await ensureInstance();

const localFiles = await listMarkdownFiles(searchDir);
if (localFiles.length === 0) {
  throw new Error(`Search directory ${searchDir} has no Markdown files.`);
}

const localByKey = new Map(localFiles.map((file) => [file.key, file]));
const remoteItems = await listRemoteItems();
const remoteByKey = new Map(remoteItems.map((item) => [item.key, item]));

const deleteJobs = remoteItems.filter((item) => !localByKey.has(item.key));
const compareJobs = localFiles.filter((file) => remoteByKey.has(file.key));
const uploadJobs = localFiles.filter((file) => !remoteByKey.has(file.key));
const changedUploads = [];
let skipped = 0;

await runConcurrent(deleteJobs, async (item) => {
  console.log(`Deleting removed AI Search item ${item.key}`);
  await deleteItem(item);
});

await runConcurrent(compareJobs, async (file) => {
  const item = remoteByKey.get(file.key);
  const remoteHash = await remoteItemHash(item);
  if (remoteHash === file.hash) {
    skipped += 1;
    return;
  }

  console.log(`Replacing changed AI Search item ${file.key}`);
  await deleteItem(item);
  changedUploads.push(file);
});

const filesToUpload = [...uploadJobs, ...changedUploads].sort((a, b) => a.key.localeCompare(b.key));
await runConcurrent(filesToUpload, async (file) => {
  console.log(`Uploading ${file.key}`);
  await uploadFile(file);
});

console.log(`Search sync complete for ${instanceName}: ${skipped} unchanged, ${filesToUpload.length} uploaded, ${deleteJobs.length} deleted.`);
console.log(JSON.stringify(await apiJson("GET", `${instancePath}/stats`), null, 2));

async function ensureInstance() {
  const existing = await apiRaw("GET", instancePath, {}, { allowError: true });
  if (existing.ok) {
    console.log(`AI Search instance ${instanceName} already exists.`);
    return;
  }

  console.log(`Creating AI Search instance ${instanceName} with built-in storage.`);
  await apiJson("POST", `/accounts/${accountId}/ai-search/namespaces/${namespace}/instances`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: instanceName,
      index_method: { vector: true, keyword: true },
      fusion_method: "rrf",
      chunk_size: 512,
      chunk_overlap: 30,
      max_num_results: 8,
      cache: true
    })
  });
}

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir).catch(() => {
    throw new Error(`Search directory ${dir} does not exist. Run docsflare search sync after building content.`);
  });

  const files = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const absolute = path.join(dir, entry);
    if (!(await stat(absolute)).isFile()) continue;
    const contents = await readFile(absolute);
    files.push({
      key: entry,
      absolute,
      hash: sha256(contents)
    });
  }
  return files;
}

async function listRemoteItems() {
  const items = [];
  const perPage = 50;
  for (let page = 1; ; page += 1) {
    const response = await apiJson("GET", `${instancePath}/items?page=${page}&per_page=${perPage}`);
    const result = Array.isArray(response.result) ? response.result : [];
    items.push(...result.filter((item) => typeof item?.id === "string" && typeof item?.key === "string"));

    const info = response.result_info;
    if (info?.total_pages && page >= info.total_pages) break;
    if (result.length < perPage) break;
  }
  return items;
}

async function remoteItemHash(item) {
  const response = await apiRaw("GET", `${instancePath}/items/${encodeURIComponent(item.id)}/download`, {}, { expectJson: false });
  if (!response.ok) return "";
  return sha256(Buffer.from(await response.arrayBuffer()));
}

async function deleteItem(item) {
  await apiJson("DELETE", `${instancePath}/items/${encodeURIComponent(item.id)}`);
}

async function uploadFile(file) {
  const form = new FormData();
  form.set("file", new Blob([await readFile(file.absolute)], { type: "text/markdown" }), file.key);
  await apiJson("POST", `${instancePath}/items`, { body: form });
}

async function apiJson(method, apiPath, init = {}) {
  const response = await apiRaw(method, apiPath, init);
  const body = await response.text();
  const json = parseJson(body);
  if (!response.ok || json?.success !== true) {
    throw new Error(apiError(method, apiPath, response.status, body));
  }
  return json;
}

async function apiRaw(method, apiPath, init = {}, options = {}) {
  const url = `https://api.cloudflare.com/client/v4${apiPath}`;
  let lastResponse;
  let lastBody = "";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(init.headers ?? {})
      }
    });

    if (response.ok) return response;

    lastResponse = response;
    lastBody = await response.text();
    const json = parseJson(lastBody);
    const code = json?.errors?.[0]?.code;
    if (attempt === 5 || (code && code !== 7017 && response.status < 500)) break;
    await sleep(attempt * 2000);
  }

  if ((options.expectJson === false || options.allowError) && lastResponse) {
    return new Response(lastBody, { status: lastResponse.status });
  }
  throw new Error(apiError(method, apiPath, lastResponse?.status ?? 0, lastBody));
}

async function runConcurrent(items, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function apiError(method, apiPath, status, body) {
  return `${method} ${apiPath} failed${status ? ` with ${status}` : ""}: ${body}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
