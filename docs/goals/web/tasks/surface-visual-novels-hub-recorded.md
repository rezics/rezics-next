---
title: Visual novels Work hub shown from recorded answers
kind: surface
rows: [visual-novels/work-hub-and-edition-choice]
engine: grok
effort: high
cases: []
paths: [apps/web/features/work-page/read.ts, apps/web/features/work-page/editions.tsx, apps/web/features/work-page/your-edition.tsx, apps/web/features/tracking/api.ts, apps/web/features/work-page/visual-novels-hub-recorded-page*, apps/web/features/work-page/visual-novels-hub-recorded.stories.tsx]
tests: [apps/web/features/work-page/visual-novels-hub-recorded-page.test.ts, apps/web/features/work-page/visual-novels-hub-recorded.stories.tsx]
refs: []
operations: []
migrations: []
shared: []
depends: []
land: auto
---

## Outcome

A visitor compares the recorded Work and exact releases; a signed-in reader selects only their own recorded edition preference.

Page: `/[locale]/w/[ref] (Visual novels)`.

Production readers and adapters: readWorkHeader, readReleases and readEditionPreference in features/work-page/read.ts; mainTrackingApi in features/tracking/api.ts. Read the actual route and these readers first. Extract only the smallest page/reader seam into `apps/web/features/work-page/visual-novels-hub-recorded-page.tsx` (or .ts) when necessary; production and stories must call the same mapping. Reuse existing components. An additional production file needs a claim correction before editing.

The program names these rows as proved and records them in G-2189 through G-2198. Before dispatch the manager reads their six-persona matrices under `scripts/qa/cases/outcomes/`. Use the unchanged row records listed below, the replay in `features/stories/recorded-fetch.ts`, the web typed client and the named production readers. Follow G-2169's recorded catalogue pattern without waiting for its landing.

Stories show loading by holding a recorded request unanswered, then populated, empty and refusal only where a recorded answer proves each state. Name each sample's persona and assert visible recorded title, identity, state, continuation or refusal through roles/text. Do not hand-author response bodies or models, edit records, weaken assertions, mock readers, or invent an empty state. Preserve acting Person, opaque continuations, compare-and-set revisions and stable command keys. Pending needs a recorded HTTP 202 for that operation.

If a request, supporting read or admitted state lacks a record, hand off partial with method, path, query/body and persona for the outcome owner. If a typed reader cannot consume an answer, show the exact discrepancy. API gaps go to api by mail with no client workaround. Retain credit/rights and existing eight UI locales; inspect phone and desktop.

Do not build: API/schema changes, answer records, a replay or command engine, a parallel reader, unrelated rows, page redesign, existing-story migration, screenshot baselines or browser journeys.

## Decision — 2026-10-13 mail:1dd26204 retry

Write this page now, keep `depends: []`, and release only when every following file passes `git cat-file -e main:<path>` immediately before dispatch:

- apps/web/features/stories/recorded-fetch.ts
- tests/qa/fixtures/outcomes/visual-novels/work-hub-and-edition-choice.json

Absent on main at this decision:

- apps/web/features/stories/recorded-fetch.ts
- tests/qa/fixtures/outcomes/visual-novels/work-hub-and-edition-choice.json

This complete draft needs a reserved task ID: bounded `task goal -- new` attempts timed out on the ledger lock. Reserve its ID and rename this file before admission. The replay is absent, so no surface worker starts in this event. Apply the later program ruling already recorded in G-2204: hold the committed brief until G-2217's file gate is on main, then add these paths as `needs:` and queue; if all files land first, dispatch by hand after reading the matrices. The current queue has no file gate and would start an empty-dependency brief. Program has the admission question with this brief family and G-2222's path (mail key `web-mail-1dd26204-retry-admission`). No state checkpoint is written.

## Mechanisms

none

## Checks

`task goal -- check`: surface contract/record applicability, web types, lint, named mapping unit and recorded stories, repository guards. The mapping unit exercises an unchanged recorded populated answer and refusal; no assertion may be loosened to pass. Inspect each story PNG once on phone and desktop, report visible evidence and each gate's run/slot-wait seconds. Do not run a full Storybook suite or per-row browser journey.
