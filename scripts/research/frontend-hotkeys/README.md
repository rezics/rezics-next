# Isolated keyboard comparison

This is a research fixture, not a production entry point. It imports the current
editor, dialogs, menu, combobox, and native keyboard owners read-only. Benign
logs and UI state establish no API authority. The retained decision and evidence
limits are in [keyboard-comparison.json](../../../docs/goals/product-completion-20261019/keyboard-comparison.json).

Run from the worktree root with its existing pinned dependencies. Preparation
writes only `.temp/frontend-hotkeys/`. The trial manifest pins its entire runtime
closure; Yarn lifecycle scripts are disabled. Its two exact TanStack releases
are explicitly exempted from Yarn's age quarantine in the private sandbox.

```sh
task --taskfile scripts/research/frontend-hotkeys/Taskfile.yml prepare
yarn --cwd .temp/frontend-hotkeys/trial install --immutable
```

The first install can omit `--immutable` to create the private lock. No production
manifest, lockfile, route, or listener is changed. All experiments execute real
package code; they must not be substituted with mock adapters.

Use the worker protocol's recorded-job wrapper, with main's goalctl entry point,
for these long commands. A targeted owner check acquires host admission and runs
the four adapters sequentially on private random ports:

```sh
bun scripts/goal/goalctl.ts test scripts/research/frontend-hotkeys/comparison.test.ts
task --taskfile scripts/research/frontend-hotkeys/Taskfile.yml routes
```

The owner test verifies that observations were obtained. Observed product or
candidate failures remain in the JSON; it deliberately does not assert that
every candidate satisfies every acceptance case. A setup failure fails the check.

`routes -- --app web` or `routes -- --app accounts` repeats only that app and
preserves the other app's evidence with its original revision. Each build
obtains host CPU/memory admission. The runner copies the actual applications,
service configuration dependencies and generated imports under `.temp`, retains
the original production Vite/Vinext/Cloudflare/Tailwind flags, and appends the
same fixture in the copied root layout. It never deploys. Previews run on private
ports and the runner stops only its own process groups. External browser requests
are aborted. No shared service is started or restarted.

The comparable route baseline is the **corrected native adapter**, alongside the
same common editor/widgets and unchanged route. The imported as-is native result
is preserved separately. Its three global owners cannot be scaled with the
fixture's controls; its purported 50-action timing is an unchanged-load control,
not a 50-registration native measurement. The other three adapters register
3/48 globals plus two selected editor actions at logical workloads 5/50; the
editor's other built-in bindings remain constant for everyone.

The independent legacy listener deliberately ignores policy for the as-is
control. All proposed adapters require its explicit cooperation with the shared
guard and current binding. Its duplicate logs are a coexistence counterexample,
not proof of a duplicate live product command. The actual imported SidebarProvider
also toggles during editor bold and synthetic IME vectors without that listener.

Instrumented listener totals include React delegation and widget listeners.
Only document/window totals and post-unmount action probes establish teardown;
detached DOM targets in the raw listener list are not leaks. Ark requires an
explicit public `init`/`destroy` pairing to survive Strict Mode replay with the
component-owned store. No package internals are modified.

Each synthetic sample measures dispatch to the benign action log, with browser
timer resolution around 0.1 ms. Three batches of 120 samples are retained per
workload and adapter. These are not hardware input, paint, real OS IME, screen
reader, or user-success timings. Common-fixture development warnings and the
Web preview stream timeout are retained. Accounts route measurements include
all observed JS/CSS response bodies, per-response gzip level 9 and Brotli quality
11, SHA-256 hashes, and emitted client/server module maps including transitives.
Tarball size and the standalone fixture are never used as route-cost proof.

```sh
task --taskfile scripts/research/frontend-hotkeys/Taskfile.yml evidence
task --taskfile scripts/research/frontend-hotkeys/Taskfile.yml validate -- --captures
task docs:check
```

Captures live in `.temp/frontend-hotkeys/`; do not commit them. The report retains
essential samples, immutable revisions, hashes, sources, unavailable cases and
the next questions. Re-running the harness does not automatically refresh the
decision. Production adoption needs a separately assigned slice and owner
agreement, both route costs, real IME and accessibility evidence.
