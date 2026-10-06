# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07) |
| --- | --- |
| Manager | `rezics-next-fb` in tmux `goal-program`, registered 02:50 CST. Peers: kernel `rezics-next-7e`, trust-ops `rezics-next-9b`, launch `rezics-next-57`. |
| Running | P1 G-1213 (`codex` high), P2 G-1214 (`codex-1` high). P3 follows both (it needs `goalctl.ts` and `scripts/qa/test.ts`); P4 waits for P2 (`cli.ts`), P5 for the cap. |
| Next | Merge P1 and P2, raise the cap to 8 (2 per Goal), brief P3; route the baseline's failures; finish the production-readiness audit (`.temp/goal-program/pr-retire-audit.md`) and close that Goal. |
| Contracts | C0–C6 open. Owners: C0, C2, C3, C4, C5, C6 `kernel` (C0 = K1 G-1217, running); C1 `trust-ops` (first half = T1 G-1215, running). T5 (platform gates) lands only with the approved launch matrix and its `public` declarations in the same change, or every operation closes at once. |
| Regression | Holder: program. Baseline backend pass at `5d4ac1ea7` running from `.temp/regress/5d4ac1ea7b15` (runner `.temp/goal-program/regress-backend.sh`, results `.temp/goal-program/regress/5d4ac1ea7b15/summary.log`); browser tiers after it. The 10-06 pass (write-concurrency) had many failing chunks and fault/recovery failing; its inherited order-dependent files are P5's. |
| Capacity | Live-worker cap 6 (Taskfile default, 3bc5fc469) until P1 and P2 land: program 2, kernel 1, trust-ops 2, launch 1. Host 52 GiB available at 03:00. |
| Usage | 03:00 CST: Claude 5h 1%, 7d 6% (resets 10-12 23:00); `codex` 57% (resets 10-10 05:13); `codex-1` 1% (resets 10-14 02:25). |
