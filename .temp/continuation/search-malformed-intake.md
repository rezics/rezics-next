# Continuation: malformed Search intake

Goal: search  
Manager: search

## Delivered

- Added pure bounded URL intake and per-operand correction in the existing `web-search` owner, wired it before Search loaders and result hooks, and kept executable dependencies unavailable for invalid requests.
- Added localized recovery messages, route journeys and pure intake cases. Recorded the visit-limit and restart choice in `docs/goals/search.md` and sent the owner decision through Goal inbox.
- No new module or manifest entry was needed: `search.tsx` remains the public entry for the existing `web-search` module.

## Resume verification

- The latest focused invocation could not take a shared Web check slot and returned before tests ran: `remote-check: connection to c failed during slot take before a result`; custody reconciliation still reports `occupied` with physical terminality and cleanup unknown. Do not start a duplicate while that custody is unresolved.
- After custody is clear, run `bun apps/web/scripts/focused.ts --private-network -- bun test tests/search-input-recovery.test.tsx tests/search-input-route.test.tsx`. The last executed suite had one final correction journey assertion where recovery was still present; the committed test now awaits TanStack `onResolved` before checking that transition.
- The required Web typecheck reached the compiler once and reported edited-file errors in the route dependency shape, a missing `searchLoaderDeps` import and widened server-input types. Those were fixed and committed. The next run stopped before compilation with `root typecheck infrastructure failure: compiler database setup could not be proven: spawnSync docker ETIMEDOUT` (exit 75). Rerun `bun run --cwd apps/web typecheck` after infrastructure recovers; the earlier pass also reported unrelated workspace errors.
- `bun scripts/architecture.ts --changed` exited 1 with `Baseline can shrink by 241 entries` and existing module-boundary violations. The output contained no Search intake or route paths; revisit only if the landing graph reports new findings.
- Browser, root and broader acceptance checks remain deferred to integration under the attempt policy.
