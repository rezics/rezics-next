# Storybook review builds

The published review site combines two Storybooks into one entry point. The web Storybook is at `/`; it lists the
page stories. The UI Storybook is built once into `/ui/` and composed into the same sidebar through a relative ref.
During development, the ref uses the UI dev server at `http://localhost:6007`.

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
