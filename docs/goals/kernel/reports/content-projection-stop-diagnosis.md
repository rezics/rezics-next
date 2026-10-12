# Content projection stop diagnosis

At `b452c5a6`, the initial public-rights publication exposes a product eligibility-proof defect: the API writer and proof reader hash identical fields in different property orders. The fixture also omits producer execution, but running those producers does not repair this receipt. No owner code changed.

## Stop condition and retained evidence

`relayContentProjectionOnce` returns `null`, which the helper interprets as false. The observed branch is [relay.ts](../../../../services/main/src/modules/content-publication/relay.ts):524: scanning has reached the owner head, no event remains, and every pending retry failed, leaving `retried` null. The anchor-closed branch at :494 is **not** taken.

The active publication first throws from `graphPublication` at relay.ts:163–167: “Content eligibility owner proof is unresolved: eligibility decision or succeeded owner receipt is unproven”. The catch at :535 retains a deferred event (:537–539); retries retain it at :502–507. [eligibility-state.ts](../../../../services/main/src/modules/content-publication/eligibility-state.ts):172 reports unresolved because `parseEligibilityProof` fails its final digest predicate (:572–574). Instrumentation reached that predicate, proving all preceding checks passed. No durable-delivery lookup was reached.

QA `20261012t005615-6e26c7` retained these observations:

| Evidence | Value |
| --- | --- |
| Public search anchor | Open before and after the stop |
| Content epoch | `c09e19ca-d2e1-444b-a911-1ec33ab3432a` for owner, completed and scanned cursors |
| Owner / scanned / completed | `12 / 12 / 11` |
| Pending event | `f14936c8-9c44-4c25-bb6f-ea9a1576ebfc`, sequence 12, `content.publication.active` |
| Exact revision | `14a2ed6a-da17-45c2-912c-1b1fe51326c4` |
| Eligibility receipt | `urn:rezics:receipt:fb10be60933971b5549cc31ade3851040e5e8f20b4561b0fe90c2945724600c7` |
| Retained digest = API-order digest | `0cfd677bc63568c0c4ee12f7a8023099493baa9c33e7ddc8d3156e2071496582` |
| Reader-order digest | `66d59f8b08fe71013dd0294f8aa272dc1c1a2828aafbc7a721b622c47cc44514` |

The evidence is in `.artifacts/qa/20261012t005615-6e26c7/content-projection-diagnosis.json`, including native proof rows, source identities, both digest candidates and refusals.

## Product defect and fixture gap

[eligibility.ts](../../../../services/main/src/modules/content-publication/eligibility.ts):88–90 hashes `JSON.stringify({ family, ...input })`, preserving insertion order. [routes/content.ts](../../../../services/main/src/routes/content.ts):53–58,342–343 puts `disclosure` before `rightsBasis`; the reader reconstructs `rightsBasis` before `disclosure` (eligibility-state.ts:494–502). Its additional v1 profile candidate also fails. A read-only counterfactual added only the API-order candidate in a temporary parser copy: the same untouched native row then parsed successfully; a corrupted digest still failed. This proves the predicate cause, not successful end-to-end projection after a product repair.

[safetyFixture](../../../../tests/qa/integration/g-744-support.ts):48–52 uses [startMediaStack](../../../../tests/qa/integration/media-support.ts):116–134, which composes the owners without starting their background producers. The referenced helper (:247–256) runs only Content projection. Using the existing [contentRebuildDelivery](../../../../services/main/src/modules/content-publication/rebuild-preflight.ts):30–47 advanced the custody-aware Main relay to graph sequence 19, but Content eligibility delivery then rejected the same proof at eligibility-state.ts:607. Therefore omitted producer execution is an additional fixture gap, not the first refusal. The exact native image was available for this proof; neither missing capture capability, wrong epoch, missing anchor, nor source gap explains it.

Production has the same persistent failure: [composition.ts](../../../../services/main/src/composition.ts):624–628 invokes retained eligibility delivery before projection, and both consume the defective reader. Rebuild preflight also requires that delivery before freezing its cut (rebuild-preflight.ts:147–168). This is a serialization-contract defect shared by eligibility inventory, delivery, body projection and rebuild.

## Smallest correct repair and limits

Kernel/Main Content publication owns the immediate fix in eligibility-state.ts:489–503 (unclaimed when checked): accept the exact API-produced serialization **alongside** existing retained forms, preserving every other proof predicate. Cover v1 and v2; the latter appends `profile` after `assessmentId` in the route (:360–365). Reordering the existing candidate breaks older direct-owner receipts. Changing only the writer leaves retained receipts unreadable and changes exact admission/replay digests (eligibility.ts:253–267).

Then G-1868's `tests/qa/integration/rights-public-restriction.test.ts` helper should drain the existing custody Main relay and eligibility delivery before projection after each publication. Reuse `contentRebuildDelivery`; do not introduce a rebuild identity or bypass the anchor. Follow-up acceptance needs API and direct-owner retained receipts for both profiles, tampered-proof refusal, delivery/rebuild recovery, and the full public-rights proof.

The probe reproduced the initial pre-restriction writes and an **unmoderated** replacement. The latter stopped with owner/scanned 15, completed 11, and pending events 12 and 15. It did not reproduce the full moderation/counter-notice flow, historical cursor snapshots, v2 runtime behavior, or public phrase-search success. The supplied historical log records the initial failure only; the later replacement diagnostic is gated by the already-false initial readiness flag, so that log does not establish a second historical stop.

## Checks

`bun scripts/goal/goalctl.ts test tests/qa/integration/content-projection-diagnosis.test.ts`: final run `20261012t005615-6e26c7` **PASS**, one test, 11.05 seconds. Earlier attempts: `20261012t002844-5ed674` **FAIL** during startup (missing pinned image; zero test execution); `20261012t004911-ab2fe2`, `20261012t005117-e697d1` and `20261012t005357-bb1af8` **FAIL** on diagnostic hypothesis assertions, refined before the passing proof. The cold native image build took about 16 minutes; it was prerequisite build work, not fixture preparation. Temporary instrumentation and the registration wrapper are excluded from the commit.

`task docs:check`: **FAIL**, solely because this new report is unreachable from `docs/README.md`; its 13 checker tests passed. The manager must add the incoming navigation link outside this report-only claim. The brief explicitly excludes `state.md` edits.
