---
defers: [browser, native, root]
---

Verification is minimal. Defer ordinary acceptance/native/browser/root/growth suites. "Tests run after landing in the dev verifier." means deferred, not a blocker; do not retry. Typecheck each changed workspace with its installed owner command, `bun run --cwd <workspace> typecheck`; include payment, payout, order settlement, points or balance tests when changed. All must pass for success; reuse unchanged passing evidence. Order producers before consumers; use `&&` only for real dependencies (`sh -c 'cmd1 && cmd2 && cmd3'`). On prerequisite failure, skip only dependent checks and report them unverified. Run independent selected cases together through their owning runner and collect all failures in one wrapper submission (`{{task.wrapperInvocation}}`). Kernel/Auth may use compiler DB/host; don't unset KERNEL_CHECK_REMOTE or force local. Group failures by cause and rerun only affected checks after repair. {{task.minimalOwned}}
