# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07 ~03:40 CST) |
| --- | --- |
| Manager | `rezics-next-7e` in tmux `goal-kernel`, registered. |
| Contracts | Landed: C0 (G-1217, e75dda7b4), C2 first slice (G-1226, 7adef77bc + fac97ab59), C3 first path (G-1228, d27907918/bf6503e96/02542960b). Open: C4, C5, C6. |
| Live | K3 G-1229 attempt 2 (now claims CommandService.java), K6 G-1243 (C4 + Context platform gate), K8a G-1245 attempt 2 (wire membership normalization into dev:refresh). |
| After merges | Regenerating or migration merges: `task gen`, typechecks, regeneration commit, then `task dev:refresh -- --wait` (program, 2026-10-07). Pending one-liner for trust-ops T7: `disclosureViewer(principal, this.options.actingSubject)` in `work/read-session.ts`. |
| Queued | G-1249 platform gates on generic ops (T5 on main), G-1244 nested pool checkouts. Next briefs: K7 templates (+ followed-Concept feed for launch), K5 slim Jena command + chapter seek qualification, K8b Discover re-measure; reply restore after recovery proof. |
| Pre-release | Custody of each activated model generation's manifest and shapes (C6): revisions pin `rv:manifest`, which nothing stores. |
| Gate | Before every merge: `.temp/kernel/affected-unit.sh <id>`; briefs require the same unit run before handoff (program, after K2/K4 left main red). |
| Share | 2 live (cap 8; backend-only overflow to 10 while MemAvailable ≥ 12 GiB). |
