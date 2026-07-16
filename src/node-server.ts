import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleRequest, type RuntimeContext } from "./worker";

const port = numberFromEnv(process.env.PORT, 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const pendingTasks = new Set<Promise<unknown>>();

const context: RuntimeContext = {
  waitUntil(promise) {
    pendingTasks.add(promise);
    void promise
      .catch((error) => console.error("Docsflare background task failed", error))
      .finally(() => pendingTasks.delete(promise));
  }
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await toRequest(incoming);
    const response = await handleRequest(request, {}, context);
    await sendResponse(response, outgoing);
  } catch (error) {
    console.error("Docsflare request failed", error);
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Internal server error");
  }
});

server.listen(port, hostname, () => {
  console.log(`Docsflare listening on http://${hostname}:${port}`);
});

server.on("error", (error) => {
  console.error("Docsflare server failed", error);
  process.exitCode = 1;
});

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? `${hostname}:${port}`;
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }

  const method = incoming.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(incoming);
  return new Request(url, { method, headers, body });
}

async function readBody(incoming: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of incoming) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  outgoing.writeHead(response.status, headers);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
