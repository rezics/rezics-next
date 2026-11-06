# Storybook review builds

The published review site combines two Storybooks into one entry point. The web Storybook is at `/`; it lists the
page stories. The UI Storybook is built once into `/ui/` and composed into the same sidebar through a relative ref.
During development, the ref uses the UI dev server at `http://localhost:6007`.
Set `STORYBOOK_UI_URL` to the own-worktree UI origin when using isolated ports; Web's local source remains available
when the composed catalogue is offline.
Page-only acceptance sets `STORYBOOK_DISABLE_COMPONENT_REF=1`; it exercises the Web page catalogue without requiring
the separately served Components Storybook. Ordinary local review keeps the composed reference enabled.

For an isolated worktree dev server, its local `/mcp` connection and component manifest, follow
[Agent access](../../../docs/development/storybook.md#agent-access). The web preview supplies missing connected-story
query context while preserving page and per-story providers. Both catalogues use the alpha's React docgen manifest
generator with deferred prop extraction for selected components. Server startup, index readiness and manifest readiness are
separate stages; select canonical component/story IDs through the installed MCP documentation tools.

The recursive story globs include nested owner modules. Keep each page or pattern's behavior states together under
its supplied canonical folder and IDs, including `Patterns/Collection Editor`. Required states remain discoverable
even when a folder contains more than eight. Review the same IDs with the `phone390` and `desktop1280` viewport
globals, locale and theme; see the [catalogue rules](../../../docs/development/storybook.md).

## Build and review locally

From the repository root, run:

```sh
bun run --cwd apps/web storybook:build
```

The build generates web fixtures and route output, then builds both catalogues with the real CSS and generated
Paraglide output. It uses recorded or fake responses only. The accessibility probe remains excluded. The output is
`apps/web/storybook-static/`; `build.json` records the full commit SHA, Storybook version and UTC build time. The
manager title displays the short commit and build time. The build reports its total bytes and elapsed time.

The deployment command builds once, smoke-tests that same directory locally, and uploads only after both steps pass:

```sh
bun run --cwd apps/web storybook:deploy
```

The smoke test opens a page deep link, a composed UI story, a Japanese dark-theme page and a page with its recorded
cover image. It checks for browser errors and failed story images. A failed build or smoke test leaves the deployed
version unchanged. Before Wrangler runs, deployment removes any leftover `apps/web/.cloudflare/output` directory.

## Version links and routing

Each publish creates a new Worker version with `wrangler versions upload`. Wrangler prints that version's permanent
`workers.dev` preview URL; use it as the immutable review link. The deploy script then assigns 100 percent of
traffic to that version, applies the `storybook.rezics.com` custom domain with `wrangler triggers deploy`, and checks
that `https://storybook.rezics.com/build.json` reports the deployed commit. Static assets are served at the origin
root, so absolute `/media/` fixture paths work on the version preview URL too.

To validate the local build and Wrangler config without publishing or changing the domain, run:

```sh
bun run --cwd apps/web storybook:deploy --dry-run
```

This runs Wrangler's local `deploy --dry-run` validation and prints that no version or domain changes will be made.

## Publishing after dev advances

The holder of the Cloudflare credentials publishes from a clean checkout of the current dev head. Check the review
site against that checkout with:

```sh
bun run --cwd apps/web storybook:deploy --status
```

Exit 3 means the review site is stale; run `storybook:deploy` to publish. Exit 0 means it is current. Exit 2 means
the live build could not be read; check the domain before deploying. Run this check after each dev advance that changes
`apps/web` or `packages/ui`, and at least once a day while work lands. `--force` republishes the same commit, for
example after a Wrangler config change.
