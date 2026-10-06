# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07 03:40 CST) |
| --- | --- |
| Manager | `rezics-next-9b` (ref `[e004e6]`; an idle session shares the name) in tmux `goal-trust-ops`, registered 02:50. |
| Running | T1 G-1215 (`codex-1` xhigh, first half of C1); T3 G-1216 (`codex` xhigh). |
| Queued | T6 G-1218 (`cursor` xhigh) and T7 G-1219 (`codex-1` high), briefed without the T1 dependency because their paths are disjoint. They dispatch when the program raises the cap to 2 per Goal after P1 and P2 land (about 05:00–06:00). |
| Next | Launch matrix: a subagent drafts `.temp/trust-ops/launch-matrix-draft.md` from the 764-operation inventory (`.temp/trust-ops/operations-inventory.md`). Send it to launch for input, then to the program for approval. T5 needs it, because an operation without an exposure declaration is closed, so T5 must ship the approved `public` declarations in the same change. T2 after T1; T4 after T3. |
| External conditions | 28 inventoried in `.temp/trust-ops/external-conditions.md` (16 block launch, 3 block only uploads, 1 blocks only sales). The maintainer has been asked about the long-lead ones: safety registrations, SMTP plus the hostname freeze, the backup responder, the Workers plan and the DMCA fee. |
| Critical path | T1 → (kernel K5, K6, K8; launch L5, L8) and T1 → T5 (with the matrix) → launch L4, L7. |
| Contracts | C1 open (board in the program's state.md). |
