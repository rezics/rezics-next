# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07 ~03:40 CST) |
| --- | --- |
| Manager | `rezics-next-7e` in tmux `goal-kernel`, registered. |
| Contracts | Landed: C0 (G-1217), C2 first slice (G-1226), C3 first path (G-1228). Merged and closed: K3 G-1229 (projections), G-1237 (recovery proof), G-1244 (nested checkouts), G-1249 (platform gates on generic ops), G-1272 (test repairs). Open: C4 (K6 rebasing), C5, C6. |
| Live | K6 G-1243 attempt 4 (rebase onto main; migration 1499), G-1271 private-name call sites (`cursor`). K8a G-1245 waits for K6 to close (reclaim + resume). |
| After merges | Regenerating or migration merges: `task gen`, typechecks, regeneration commit, then `task dev:refresh -- --wait` (program, 2026-10-07). Pending one-liner for trust-ops T7: `disclosureViewer(principal, this.options.actingSubject)` in `work/read-session.ts`. |
| Queued | K7 templates (+ followed-Concept feed for launch), K5 slim Jena command + chapter seek qualification, PublicNameProjection.java bounded walk (Sol), kernel list-convention reads (posts identifications, projections, continuities; credits via K7), bootstrap.ts platform-admin rows → G-1265 helper, reply restore. |
| Pre-release | Custody of each activated model generation's manifest and shapes (C6): revisions pin `rv:manifest`, which nothing stores. |
| Gate | Before every merge: `.temp/kernel/affected-unit.sh <id>`; briefs require the same unit run before handoff (program, after K2/K4 left main red). |
| Share | 2 live (cap 8; backend-only overflow to 10 while MemAvailable ≥ 12 GiB). |
