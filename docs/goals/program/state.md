# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07) |
| --- | --- |
| Manager | Not started; the architecture session starts it in tmux `goal-program`. |
| Next | Register; dispatch P1 and P2 first (shared worktrees stay off until P1 lands), then P3; confirm every production-readiness item reached a brief before closing that Goal. |
| Contracts | C0–C6 open. Owners: C0, C2, C3, C4, C5, C6 `kernel`; C1 `trust-ops`. Record the commit and acceptance here when each lands. |
| Regression | Holder: program. No full pass yet on the new layout; the last recorded failures are in production-readiness state.md ("Main-wide failures"), owned by launch, to be re-verified. |
| Capacity | Live-worker cap 5 until P1 and P2 land. |
| Usage | 2026-10-07 02:30 CST: Claude 5h 0%, 7d 6% (resets 10-12 23:00); `codex` 57% (resets 10-10 05:13); `codex-1` 0% (resets 10-14 02:25); Grok and Cursor have no readout. |
