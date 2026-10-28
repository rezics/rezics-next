# Review Storybook

The review site combines the web page catalogue and the UI component catalogue. The web manager composes the UI
catalogue from a relative `./ui` reference in production; each build keeps the UI build at `storybook-static/ui/`.
During development, the web Storybook reads the UI development server at `http://localhost:6007`.

Run `bun run storybook:build` from `apps/web` to generate routes and Paraglide output, build both catalogues, compose
them, and write `build.json`. The metadata records the full source commit, pinned Storybook version, and UTC build
time. The manager title displays the short commit and timestamp. The output is ignored by Git.

Run `bun run storybook:deploy` to build and smoke-test the exact static output, upload a new Worker version, then
route `storybook.rezics.com` to that version. A successful upload prints that version's own `workers.dev` preview
URL as a permanent review link. Previous versions remain available through their preview links. Use
`bun run storybook:deploy --dry-run` to build and smoke-test, then run Wrangler's upload dry run without publishing
a version or changing domain routing. Both commands use the machine's Wrangler login; neither needs a project secret.

The smoke test opens a web page, a composed `packages/ui` story, a Japanese dark-theme page story, and a page with a
recorded cover at the static output's local origin. It checks browser errors and loaded images before deployment.
Stories use recorded or fake responses and do not connect to a running kernel.

## Cost: static review publication

- Touches: the web and UI Storybook outputs, their indexes, web fixture media and build metadata.
- Bound: build each catalogue once per commit and reuse both outputs for smoke and upload; each publication uploads one
  Worker version.
- Growth check: report the current combined output bytes and build time with each implementation landing; smoke always
  opens four stories regardless of catalogue size.
