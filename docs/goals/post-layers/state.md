# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05 11:00 CST) |
| --- | --- |
| Done | P1 G-1079 (chapters are `rv:Post`, migration, 66 dev chapters converted). P2 G-1080 (post-read-v2 placements, search chapter link) and G-1104 (old chapter IDs and aliases answer HTTP 301; verified live in en and zh-Hant). P3 G-1081 (author's notes, `content-shape-v2`, reader and Studio). P4 G-1082 (identification as a Book through native publication; no new store or visibility rule). |
| Running | G-1112 (Sol): chapter Post search hits honour their Book's disclosure (main-wide regression g-542-endpoints, bisected to b2c8bc0cd). Browser acceptance of author notes on the shared stack. |
| Waiting | G-1107 convergence (depends on G-1081 closing): reader 'also a Work' link, Manage chapter wording, dead `partOf` paths, names and docs. Direction-9 `wiki position` journeys after scoped-subjects' G-1103 makes their fixture idempotent. |
| Next | Close G-1081 after its browser run; dispatch G-1107; merge G-1112 and tell rezics-next-97; rerun wiki-position journeys; then fold the Goal's decisions (already in work-and-release.md) and close the Goal. Gap for production-readiness: no general Work retirement command, so undoing an identification leaves the Work. |
| Lessons | Merging a profile or migration needs the full shared-stack refresh (image, dev:prepare, dataset:bootstrap-model, Main/relay restart). Sol over-designed G-1082 (global visibility rule, SQL journal); review cut it to 12 files. Keep combined live workers ≤5 after the 08:47 OOM. |
| Earlier lessons | A legacy-data migration must be tested on fixtures written by the old command itself (the first fixture lacked the chapter Main head that real data had). A startup migration must never keep Main from listening. A new telemetry worker name belongs in `WorkerName`. |
| Coupling | addresses-discovery (rezics-next-1c) approved the effects.ts classifications on the condition, now tested, that chapter creation leaves the Book's head, Main Version, classifications and credits unchanged. scoped-subjects (rezics-next-97) frames chapters by occurrence; it owns Access 1080 (G-1079 used none). |
