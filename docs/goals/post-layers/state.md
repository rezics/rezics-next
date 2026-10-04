# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05 07:40 CST) |
| --- | --- |
| Done | P1: G-1079 merged (b2c8bc0cd…e9868d135) and closed. Chapters are `rv:Post`; no chapter Work is minted; 20 hide filters gone; startup migration converted all 66 dev chapters under the same IRIs; Fuseki pin c51f3cc510da on the dev stack. Hotfixes b076d078b (migration never blocks Main) and 40ef0d365 (worker name). |
| Running | G-1080 (Sonnet) surfaces and durable chapter addresses with a Post place read; G-1081 (Sol) author's notes, backend phase; wave QA for G-1079 (`--affected 58dee1a1a`, whole tiers, 2 shards) in `.temp/worktrees/post-layers-qa` pinned at e9868d135. |
| Waiting | G-1082 (Sol) identification as a Work: queued behind the 5-worker host limit by a retry loop. |
| Next | After G-1080 merges: reclaim G-1081 with the reader and Studio note files and resume it for phase two; place G-1082's "also a Work" link. Then P5 convergence (structure README, creation/composition docs, code comments still saying chapter Work, `chapter-work.ts` naming) and the browser journeys, including the four `wiki position` journeys in apps/web/tests/direction-9.e2e.ts. |
| Lessons | A legacy-data migration must be tested on fixtures written by the old command itself (the first fixture lacked the chapter Main head that real data had). A startup migration must never keep Main from listening. A new telemetry worker name belongs in `WorkerName`. |
| Coupling | addresses-discovery (rezics-next-1c) approved the effects.ts classifications on the condition, now tested, that chapter creation leaves the Book's head, Main Version, classifications and credits unchanged. scoped-subjects (rezics-next-97) frames chapters by occurrence; it owns Access 1080 (G-1079 used none). |
