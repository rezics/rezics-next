# Session media checks awaiting other owners' closures

goal: web
manager: web

This branch's transport source is committed. Remaining checks fail for reasons owned by other outcomes and must rerun
after those closures land.

Owned by other outcomes (not repaired here):
- Library 348e68dd-f2e1-453c-999a-998dae6c163f: native source/type closure in `services/kernel/src/library`. It
  blocks kernel typecheck, emit-client, Auth typecheck and web Client closure.
- Zones 6c61d74e-e5bf-4e4b-95d8-c6fe801977d9: kernel zones typing errors reported by web typecheck.
- Auth e2ca8446-c51f-43ec-aa84-3ac8c66d0f2e: Auth typecheck until Library exports land; original full native
  acceptance remains owed.
- Vite startup / Performance snapshot: `bun run dev` inside `tests/media-reserve.test.ts` did not start on the
  check host (`dev server did not start: $ bun scripts/storybook-dev.ts --app`). Site-walk reservation tests stay
  with that startup outcome.

Rerun on the commit that contains these closures:
1. `bun run --cwd services/kernel typecheck`, then `bun run --cwd services/kernel typecheck --emit-client`.
2. `bun run --cwd services/auth typecheck`.
3. `bun run --cwd apps/web typecheck` after the Client closure is reconciled.
4. Focused Web landing set including `tests/media-reserve.test.ts` once `bun run dev` starts.

Do not change the assertions of those checks to pass them.
