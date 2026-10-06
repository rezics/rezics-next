# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07) |
| --- | --- |
| Manager | `rezics-next-fb` in tmux `goal-program`, registered 02:50 CST. Peers: kernel `rezics-next-7e`, trust-ops `rezics-next-9b`, launch `rezics-next-57`. |
| Running | P3 G-1223 (`codex-1` xhigh), P5 G-1224 (`grok` high). P4 G-1227 briefed, dispatches when P5 exits (program holds 2). Merged: P1 G-1213 330a98792 (shared worktrees safe, names Goal-scoped), P2 G-1214 (QA leases, restore clean-up, front-end affected checks). |
| Next | Dispatch P4 after P5; finish the baseline and route its failures by owner in one batch per Goal; record C0 and C1 when K1 and T1 land. |
| Contracts | C0–C6 open. Owners: C0, C2, C3, C4, C5, C6 `kernel` (C0 = K1 G-1217, running); C1 `trust-ops` (first half = T1 G-1215, running). T5 (platform gates) lands only with the approved launch matrix and its `public` declarations in the same change, or every operation closes at once. |
| Regression | Holder: program. Baseline at `5d4ac1ea7` running from `.temp/regress/5d4ac1ea7b15` (runner `.temp/goal-program/regress-backend.sh`, results `.temp/goal-program/regress/5d4ac1ea7b15/summary.log`): unit green after 473c9ad43 (SQL guard exemptions; PKG06 needed Docker), model green, integration under way (chunk 2: work-stats and realm-reads query budgets 6 > 5). Docker Desktop was down at start (restarted 02:55); the shared stack needed `task search:rebuild` before `task dev` started again. |
| Retired | production-readiness closed fd8e5f1cd after every item reached an owner (audit `.temp/goal-program/pr-retire-audit.md`; kernel fb24e7d26, trust-ops ee23dac76 and 54cc2c55b, launch 63502eba9). |
| Capacity | Live-worker cap 8 (Taskfile default) since P1 and P2 landed: 2 per Goal. Docker VM at its 24 GiB ceiling; host 22 GiB available with six workers and the shared stack. Raise to 12 after 12-20 waves without a new OOM. |
| Usage | 03:00 CST: Claude 5h 1%, 7d 6% (resets 10-12 23:00); `codex` 57% (resets 10-10 05:13); `codex-1` 1% (resets 10-14 02:25). |
