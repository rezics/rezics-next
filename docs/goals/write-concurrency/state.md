# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05) |
| --- | --- |
| Done | Research and inventory (`.temp/research/global-write-serialization-2026-10-05.md`). G-1164 merged (13a23c3d6, ee230fa9d; migration 1130): the producer log appends without a head row; consumers read `(epoch, xid, id)` below the snapshot horizon; the epoch is `recovery_fence.generation`, read FOR SHARE in the append so recovery waits for appenders. |
| Running | G-1162 Content position (Opus xhigh). G-1163 votes (Opus xhigh), attempt 2: graph events that ingest nothing keep the revision; GET page/since read without locks. G-1165 Realm joins/directory (Sol xhigh). G-1167 then G-1169 dispatch from a background loop when the 5-worker limit frees. G-1166 overlaps scoped-subjects' G-1173 on `semantic/admitted.ts`: sequence after it. |
| Next | Wave 2 briefed: G-1166 scope gates (after G-1165), G-1167 discovery/also-enjoyed fences (after G-1164), G-1168 ordered heads (after G-1164, G-1165). Wave 3: the guard (allowlisted singleton rows and constant lock keys) and an independent Opus review. Peers: keep feed group-vote leader resolution (feed-group-votes test); fence work runs discovery-refresh-retirement; heavy QA at REZICS_QA_SHARDS=1 while workers live. Main-wide regression passes scoped-subjects → showcase. |
| Regression | Takes main-wide regression when scoped-subjects closes (agreed with rezics-next-97; handover at `.temp/manager/mainwide-handover.md`). Showcase closed before its own acceptance run, so its former area has no owner and its failures are this Goal's to fix. The first full run checks: `tests/qa/integration/{showcase-art,zone-campaign-art,zone-presentation,zone-showcase-disclosure,media-rendition,media-delivery-cache}.test.ts`; `services/main/tests/{showcase-art,showcase-art-logo-limit,media-rendition,zone-*}.test.ts`; `apps/web/tests/showcase*.test.ts(x)`; showcase, showcase-editor, zone-showcase-editor and carousel stories; the g-849 and g-914 journeys after a reseed (the showcase step runs last). The acceptance review by eye stays with production readiness. |
| Usage | Claude week resets about 23:00 CST 2026-10-05; Opus for first-of-kind design, Sol for backend follow-through. |
