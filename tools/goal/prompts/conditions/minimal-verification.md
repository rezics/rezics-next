---
defers: [browser, native, root]
---

Verification is minimal. Acceptance, native, browser and root checks run after integration; you need not run them. Run a focused check yourself only when you cannot finish the outcome without seeing it, for example a page you changed. Before finishing, type-check each workspace you changed (`bun run --cwd <workspace> typecheck`, or `bun scripts/typecheck.ts`) and fix every error; services/kernel and services/auth may use the compiler database or a check host: do not force `env -u KERNEL_CHECK_REMOTE` or local placement. {{task.minimalOwned}}Then commit and return success (blocker null, `"checks":[]`), naming what you completed and the deferred acceptance, which is neither a blocker nor a reason to wait; return waiting only for a still-running check UUID this attempt started.
