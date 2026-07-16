# Docsflare

Docsflare is a portable, CLI-driven documentation renderer. Point it at a Mintlify-style docs directory and it builds a standard Fetch API application that serves rendered Markdown/MDX pages, static assets, search, chat, sitemap, robots.txt, and llms.txt.

Cloudflare Workers is the preferred and best-supported deployment target. The same generated application also includes a Node.js server adapter, and its exported request handler can be integrated with other Fetch-compatible edge runtimes.

The intended workflow inside a docs content repo is:

```bash
docsflare dev
docsflare build
docsflare deploy
```

This repo includes starter content in `docs/` so the project can run immediately after install. In a real docs repo, Docsflare generates portable runtime files in `.docsflare/`. Wrangler can deploy the Fetch handler directly, while other hosts can run or adapt the Node.js entrypoint.

## Features

- `docsflare` CLI for init, dev, build, deploy, start, and doctor checks
- Standard Fetch API request handler
- First-party Cloudflare Workers and Node.js runtime paths
- Markdown and MDX pages rendered at build time
- `docs.json` and `mint.json` navigation compatibility
- Common Mintlify-style MDX components such as cards, tabs, accordions, and callouts
- Configurable color modes, fonts, backgrounds, and automatically bundled custom CSS
- Static local search fallback for development
- Optional Cloudflare AI Search-backed `/api/search` and `/api/chat` endpoints
- Generated `sitemap.xml`, `robots.txt`, and `llms.txt`

## Prerequisites

- Node.js 20 or newer
- npm
- A Cloudflare account and Wrangler authentication only when deploying to Cloudflare:

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

Wrangler prints the local URL, usually `http://localhost:8787`. To use Node.js instead:

```bash
docsflare dev docs --platform node
```

The Node adapter listens on `HOST` and `PORT`, defaulting to `127.0.0.1:3000`.

Run project checks:

```bash
npm run doctor
npm run build
```

## CLI Commands

```bash
docsflare init [content-dir] [--force]
docsflare dev [content-dir]
docsflare start [content-dir]
docsflare build [content-dir]
docsflare deploy [content-dir] [--env production]
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
│   ├── custom.css             # Site-wide variables and component overrides
│   ├── *.mdx                  # Documentation pages
│   └── logo.svg               # Static asset served by the Worker
├── scripts/
│   └── build-content.ts        # Converts docs config, MDX, and assets into generated content
├── src/
│   ├── content.ts             # Placeholder content used for typechecking
│   ├── worker.ts              # Portable Fetch handler copied into .docsflare
│   └── node-server.ts         # Node.js adapter copied into .docsflare
└── wrangler.jsonc             # Local example Worker config
```

`.docsflare/content.ts`, `.docsflare/worker.ts`, `.docsflare/node-server.ts`, and `.docsflare/wrangler.jsonc` are produced from the docs content. Rebuild after changing docs pages, navigation, or static assets.

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

Install Docsflare in the docs repo. Add Wrangler when Cloudflare is your deployment target:

```bash
npm install --save-dev github:qaml-ai/docsflare
npm install --save-dev wrangler # Cloudflare only
```

Add scripts:

```json
{
  "scripts": {
    "dev": "docsflare dev",
    "build": "docsflare build",
    "deploy": "docsflare deploy"
  }
}
```

Docsflare writes generated build output to `.docsflare/`. Keep that directory ignored.

The directory should contain:

- `docs.json` or `mint.json`
- `custom.css` for optional site-wide customization (created by `docsflare init`)
- `.mdx` or `.md` pages referenced by navigation
- images and other public assets referenced by your docs

Custom React imports from an existing Mintlify project may need to be rewritten or replaced because Docsflare renders MDX statically during the build.

## Optional Config

You can add `docsflare.config.json` in the current project or in the content directory to avoid repeating deployment settings. For machine-local deployment settings, use ignored `docsflare.config.local.json`; it has the same shape and overrides `docsflare.config.json`.

```json
{
  "basePath": "/docs",
  "platform": "cloudflare",
  "cloudflare": {
    "aiSearch": {
      "instance": "my-docs"
    }
  }
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
description: Run the docs application locally and deploy the generated site.
---

# Quickstart

Your content goes here.
```

Routes are derived from file paths unless a page sets `path` in frontmatter. For example, `guides/install.mdx` becomes `/guides/install`.

Supported built-in MDX components:

- `CardGroup`, `Card`, `Columns`, `Column`
- `Info`, `Note`, `Tip`, `Warning`, `Check`, `Danger`, `Callout`
- `Accordion`, `AccordionGroup`
- `Expandable`
- `Tabs`, `Tab`
- `Steps`, `Step`
- `Frame`
- `CodeGroup`
- `Panel`, `Banner`, `Badge`, `Tooltip`
- `Icon`, `Color`
- `Tile`, `TileGroup`
- `ParamField`, `ResponseField`
- `RequestExample`, `ResponseExample`
- `Tree`, `TreeRoot`, `TreeFolder`, `TreeFile`
- `Prompt`, `View`, `Visibility`
- `Update`

Tabs and multi-example code groups include keyboard-accessible client-side switching. All tab content remains present in the generated HTML for indexing.

## Appearance And Custom CSS

The easiest customization path is the generated `custom.css` file. It loads automatically after Docsflare's built-in styles:

```css
:root {
  --docsflare-content-width: 760px;
  --docsflare-radius: 14px;
  --docsflare-font-body: Inter, ui-sans-serif, system-ui, sans-serif;
}
```

Use `colors`, `appearance`, `fonts`, and `background` in `docs.json` or `mint.json` for brand and browser settings:

```json
{
  "colors": {
    "primary": "#0f766e",
    "light": "#14b8a6",
    "dark": "#134e4a"
  },
  "appearance": {
    "default": "system",
    "strict": false
  }
}
```

Every `.css` file below the content directory is bundled automatically after Docsflare's styles. Use the documented `--docsflare-*` custom properties and `data-docsflare-component` hooks for durable overrides. See [Appearance and custom CSS](docs/customization.mdx) for the copy-paste workflow, font and background setup, stylesheet ordering, the stable CSS contract, and troubleshooting.

## Search And Chat

Every runtime works without an external search service: `/api/search` uses an in-memory index over the generated pages and `/api/chat` returns relevant source pages. Runtime adapters may supply a provider as `env.SEARCH`; Cloudflare uses the optional `env.AI_SEARCH` instance binding.

Create a Cloudflare AI Search website data source once:

```bash
npx wrangler ai-search create my-docs \
  --type web-crawler \
  --source docs.example.com \
  --hybrid-search \
  --cache \
  --custom-metadata title:text \
  --custom-metadata description:text
```

Then reference the instance:

```json
{
  "cloudflare": {
    "aiSearch": {
      "instance": "my-docs"
    }
  }
}
```

Cloudflare crawls the generated sitemap and runs scheduled synchronization jobs. The sitemap includes `<lastmod>` timestamps so changed pages can be refreshed efficiently. Docsflare does not expose an indexing endpoint or maintain synchronization state; use `wrangler ai-search stats` and `wrangler ai-search jobs` directly when needed.

For a complete bootstrap sequence, verification commands, project-owned Wrangler configuration, troubleshooting, and agent guardrails, see the [Cloudflare AI Search runbook](docs/cloudflare-search.mdx).

## Deployment targets

### Cloudflare Workers (preferred)

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
  "compatibility_date": "2026-07-16",
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
          "binding": "AI_SEARCH",
          "instance_name": "my-docs-search",
          "remote": true
        }
      ]
    }
  }
}
```

Generated Wrangler configurations also enable sampled Workers logs and traces. Project-owned Wrangler files remain untouched, so copy the binding and observability settings into them when needed.

### Node.js and other hosts

Build and run the generated Node.js adapter with:

```bash
docsflare build
docsflare start
```

Set `platform` to `node` in `docsflare.config.json` to make `docsflare dev` use Node by default. `docsflare start` always uses Node and honors the `HOST` and `PORT` environment variables.

For serverless or edge platforms that expose the Fetch API, import the generated `.docsflare/worker.ts` module. Its default export has a Workers-compatible `fetch` method, and its named `handleRequest` export accepts standard `Request` objects. Platform-specific packaging remains the responsibility of the host; the built-in `docsflare deploy` command intentionally remains Cloudflare-specific.

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

- `wrangler.jsonc` has the `AI_SEARCH` AI Search binding in the `production` environment
- the AI Search instance name matches `instance_name`
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
