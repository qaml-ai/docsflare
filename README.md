# Docsflare

Docsflare is a CLI-driven documentation renderer for Cloudflare Workers. Point it at a Mintlify-style docs directory, and it builds a Worker that serves rendered Markdown/MDX pages, static assets, search, chat, sitemap, robots.txt, and llms.txt.

The intended workflow inside a docs content repo is:

```bash
docsflare dev
docsflare build
docsflare deploy
```

This repo includes starter content in `docs/` so the project can run immediately after install. In a real docs repo, Docsflare generates a temporary Worker project in `.docsflare/` and Wrangler deploys that generated Worker.

## Features

- `docsflare` CLI for init, dev, build, deploy, search sync, and doctor checks
- Cloudflare Workers runtime
- Markdown and MDX pages rendered at build time
- `docs.json` and `mint.json` navigation compatibility
- Common Mintlify-style MDX components such as cards, tabs, accordions, and callouts
- Static local search fallback for development
- Optional Cloudflare AI Search-backed `/api/search` and `/api/chat` endpoints
- Generated `sitemap.xml`, `robots.txt`, and `llms.txt`

## Prerequisites

- Node.js 20 or newer
- npm
- A Cloudflare account for deployment
- Wrangler authentication for deployment:

```bash
npx wrangler login
```

## Quick Start

Install dependencies:

```bash
npm install
```

Run the bundled example docs:

```bash
npm run dev
```

That script calls:

```bash
docsflare dev docs
```

Wrangler prints the local URL, usually `http://localhost:8787`.

Run project checks:

```bash
npm run doctor
npm run build
```

## CLI Commands

```bash
docsflare init [content-dir] [--force]
docsflare dev [content-dir]
docsflare build [content-dir]
docsflare deploy [content-dir] [--env production]
docsflare search sync --url https://example.com/docs
docsflare doctor [content-dir]
```

By default, Docsflare uses the current directory when it contains `docs.json` or `mint.json`. If the current directory is an app repo with a `docs/` subdirectory, it uses `docs/`. You can also pass a content directory explicitly.

You can pass it positionally:

```bash
docsflare dev ./docs
```

Or with a flag:

```bash
cd docs
docsflare dev
```

## Project Layout

```text
.
├── bin/docsflare.js           # CLI entrypoint
├── docs/                      # Example docs content
│   ├── docs.json              # Mintlify-style site config and navigation
│   ├── *.mdx                  # Documentation pages
│   └── logo.svg               # Static asset served by the Worker
├── scripts/
│   └── build-content.ts        # Converts docs config, MDX, and assets into generated content
├── src/
│   ├── content.ts             # Placeholder content used for typechecking
│   └── worker.ts              # Cloudflare Worker router and renderer copied into .docsflare
└── wrangler.jsonc             # Local example Worker config
```

`.docsflare/content.ts`, `.docsflare/worker.ts`, and `.docsflare/wrangler.jsonc` are produced from the docs content. Rebuild after changing docs pages, navigation, or static assets.

## Start A New Docs Site

Create starter content:

```bash
docsflare init docs
docsflare dev docs
```

If `docs/` already exists and you want to overwrite starter files:

```bash
docsflare init docs --force
```

## Use Existing Mintlify Content

Point Docsflare at any compatible docs directory:

```bash
docsflare doctor ../my-docs
docsflare dev ../my-docs
docsflare build ../my-docs
```

## Use In A Docs Repo

Install Docsflare and Wrangler in the docs repo:

```bash
npm install --save-dev github:qaml-ai/docsflare wrangler
```

Add scripts:

```json
{
  "scripts": {
    "dev": "docsflare dev",
    "build": "docsflare build",
    "deploy": "docsflare deploy",
    "search:sync": "docsflare search sync"
  }
}
```

Docsflare writes generated build output to `.docsflare/`. Keep that directory ignored.

The directory should contain:

- `docs.json` or `mint.json`
- `.mdx` or `.md` pages referenced by navigation
- images and other public assets referenced by your docs

Custom React imports from an existing Mintlify project may need to be rewritten or replaced because Docsflare renders MDX statically during the build.

## Optional Config

You can add `docsflare.config.json` in the current project or in the content directory to avoid repeating deployment settings. For machine-local deployment settings, use ignored `docsflare.config.local.json`; it has the same shape and overrides `docsflare.config.json`.

```json
{
  "basePath": "/docs",
  "searchSyncUrl": "https://example.com/docs"
}
```

CLI flags override config values.

`basePath` is optional. When set, Docsflare serves the same docs from both `/` and that mounted path, and generated links, canonical URLs, sitemap URLs, markdown output, search, and chat use the mounted path for requests under it.

## Writing Docs

Docsflare looks for `docs.json` first, then `mint.json`. Navigation entries should point to local `.md`, `.mdx`, or `index.mdx` pages.

Example:

```json
{
  "name": "Docsflare",
  "navigation": [
    {
      "group": "Getting Started",
      "pages": ["introduction", "quickstart"]
    }
  ]
}
```

Pages can use frontmatter:

```mdx
---
title: Quickstart
description: Run the local worker and deploy the generated docs site.
---

# Quickstart

Your content goes here.
```

Routes are derived from file paths unless a page sets `path` in frontmatter. For example, `guides/install.mdx` becomes `/guides/install`.

Supported built-in MDX components:

- `CardGroup`
- `Card`
- `Info`, `Note`, `Tip`, `Warning`, `Check`
- `Accordion`, `AccordionGroup`
- `Tabs`, `Tab`
- `Steps`, `Step`
- `Frame`
- `CodeGroup`
- `Columns`
- `Update`

## Search And Chat

Local development works without Cloudflare AI Search. When the `DOCS_SEARCH` binding is missing, `/api/search` uses an in-memory search over the generated pages and `/api/chat` returns relevant source pages instead of an AI-generated answer.

Production can use Cloudflare AI Search through the `DOCS_SEARCH` binding in the docs repo's `wrangler.jsonc`:

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

After deployment, the Worker can lazily sync AI Search through the `DOCS_SEARCH` binding:

```bash
curl -fsS -X POST https://example.com/docs/api/search/sync
```

Or from the CLI:

```bash
docsflare search sync --url https://example.com/docs
```

The endpoint is public and idempotent. It calculates a content hash for the generated docs, skips work when that hash has already synced, and otherwise updates AI Search through the Worker binding. Unchanged documents are skipped, changed documents are replaced, new documents are uploaded, and removed documents are deleted.

The CLI does not need a Cloudflare REST API token for search indexing. `docsflare search sync` only sends a `POST` request to the deployed Worker. You can pass either the docs root URL, such as `https://example.com/docs`, or the full sync endpoint URL.

For CI, pass the URL with `--url`, set `DOCSFLARE_SEARCH_SYNC_URL`, or set `searchSyncUrl` in `docsflare.config.json`.

## Deploy

Build and deploy to the production Wrangler environment:

```bash
docsflare deploy
```

By default, Docsflare serves pages from `/`. To mount the same docs at another path for a deployment, set `basePath` in `docsflare.config.json`:

```json
{
  "basePath": "/docs"
}
```

`basePath` controls how Docsflare strips and generates URLs inside the Worker. Cloudflare routes should live in `wrangler.jsonc`; for example, set `env.production.routes` to `["example.com/docs*"]` when deploying the Worker only under `/docs`.

For a docs repo deployed at `/docs`, use a Wrangler config like:

```json
{
  "name": "my-docs",
  "main": ".docsflare/worker.ts",
  "compatibility_date": "2026-03-27",
  "env": {
    "production": {
      "routes": [
        {
          "pattern": "example.com/docs*",
          "zone_name": "example.com"
        }
      ],
      "ai_search": [
        {
          "binding": "DOCS_SEARCH",
          "instance_name": "my-docs-search"
        }
      ]
    }
  }
}
```

If you changed docs content and use Cloudflare AI Search, send a `POST` request to `/api/search/sync` after deployment so the hosted search index matches the deployed pages.

## Troubleshooting

### Check a docs directory

Run:

```bash
docsflare doctor docs
```

The doctor command checks for a docs config, missing navigation pages, Markdown/MDX files, and MDX import/export statements that may need migration.

### MDX fails to render

Check for unsupported custom React imports or component syntax. Docsflare supports a set of built-in documentation components, but it does not bundle arbitrary page-level React components yet.

### Search works locally but not in production

Confirm that:

- `wrangler.jsonc` has the `DOCS_SEARCH` AI Search binding in the `production` environment
- the AI Search instance name matches `instance_name`
- `POST /api/search/sync` returns a successful response
- the deployed Worker is using the `production` environment

## Contributing

This repo is not fully prepared for public contributions yet. Before making it public, consider adding:

- a license file
- a contribution guide
- a code of conduct if you expect community contributions
- CI for `npm run build`
- issue and pull request templates

For now, keep changes focused and run this before opening a pull request:

```bash
npm run doctor
npm run build
```
