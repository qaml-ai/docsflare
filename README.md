# Docsflare

A Mintlify-style documentation renderer for Cloudflare Workers.

## Goals

- Cloudflare Workers runtime
- MDX and Markdown pages
- `docs.json` / `mint.json` navigation compatibility
- Cloudflare AI Search-backed search endpoint

## Commands

```bash
npm install
npm run dev
npm run test:fixture
npm run provision:ai-search
npm run deploy
```

`npm run build:content` reads your Mintlify-style config and generates `src/generated/content.ts`.

## Moving an existing Mintlify project

Copy the Mintlify project files into this repository root. Keep `docs.json` or `mint.json` and your existing `.mdx` files. The renderer understands common navigation shapes and built-in Mintlify-style MDX components. Custom React imports may need small adjustments because pages are rendered statically during the build.

You can also build from an external Mintlify project without copying it:

```bash
DOCSFLARE_CONTENT_DIR=~/docs npm run build
```

`npm run test:fixture` does the same thing for `~/docs`, or for `DOCSFLARE_FIXTURE_DIR` if you point it at another project.

## Cloudflare AI Search

The Worker includes an `/api/search` endpoint that calls `env.DOCS_SEARCH.search()` using the current Cloudflare AI Search `ai_search` binding. Local `npm run dev` intentionally has no AI Search binding, so it falls back to static in-memory search until a Cloudflare instance exists.

Provision the Cloudflare AI Search instance and upload the generated Markdown search documents:

```bash
npm run provision:ai-search
```

The provisioning script uses `cf context show` for the account ID and uses `CLOUDFLARE_API_TOKEN` or the local `cf auth login` token. It creates a built-in-storage AI Search instance named `docsflare-docs`, so no R2 bucket is required.

Production deploys use the `production` Wrangler environment. The binding is configured in `wrangler.jsonc`:

```json
{
  "env": {
    "production": {
      "ai_search": [
        {
          "binding": "DOCS_SEARCH",
          "instance_name": "docsflare-docs"
        }
      ]
    }
  }
}
```

The generated files in `.docsflare/search` are uploaded through the AI Search Items API and indexed by Cloudflare.

## Dynamic Workers

The current Worker is a single-site build. Cloudflare Dynamic Workers are a good fit for the hosted platform version where Docsflare needs to create sites dynamically: a loader Worker can use a `worker_loaders` binding, call `env.LOADER.get(siteVersionId, callback)`, and return per-site `WorkerCode` generated from imported Mintlify projects.

The recommended hosted shape is to keep tenant Workers locked down with `globalOutbound: null`, store larger assets in R2, use KV as an asset manifest/cache when useful, and pass only controlled service bindings into each generated Worker. The local self-hosted path does not need that extra layer.
