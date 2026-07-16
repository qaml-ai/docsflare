# Repository agent instructions

## Cloudflare AI Search

The canonical setup and operations runbook is `docs/cloudflare-search.mdx`. Read it before changing search code, Cloudflare configuration, or external AI Search resources.

Architecture invariants:

- Docsflare renders the website; Cloudflare's managed website crawler owns indexing and synchronization.
- Local and non-Cloudflare deployments use the generated static search fallback.
- The only Cloudflare search binding name is `AI_SEARCH`.
- Do not add an indexing endpoint, document upload loop, synchronization token, indexing state, R2 bucket, or direct Vectorize integration.
- Inspect Wrangler authentication and existing instances before resource creation. Never delete or replace an AI Search instance without explicit user approval.
- Project-owned Wrangler files take precedence over `.docsflare/wrangler.jsonc`; bindings must be present at both the top level and in `env.production` when both development and production need AI Search.

## Appearance and custom CSS

The canonical appearance contract is `docs/customization.mdx`. Read it before changing appearance configuration, CSS discovery, design tokens, or renderer markup.

Architecture invariants:

- Keep `colors`, `appearance`, `fonts`, and `background` compatible with Mintlify's documented config shape.
- Maintain one high-quality built-in layout rather than adding named theme presets.
- Automatically include every `.css` file under the content directory in deterministic path order, after built-in styles.
- Keep spacing, radii, and component overrides in the stable `--docsflare-*` and `data-docsflare-component` CSS contract instead of adding more JSON configuration.
- Preserve base-path behavior for local font, background, and CSS asset URLs.
- Test both light and dark modes, strict appearance mode, custom CSS precedence, and a non-root base path after renderer changes.
