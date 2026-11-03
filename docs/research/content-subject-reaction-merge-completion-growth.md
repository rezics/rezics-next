# Native subject reaction merge completion growth

This acceptance binds exact-boundary completion and checkpoint retry to the registered Content operation. It complements
the frozen `subject-reaction-merge.test.ts` page measurement, which seeds rows directly and stops after one incomplete
page.

## Operation binding

- Setup creates ordinary accounts through native Auth, authenticates them through the production Access factory, and
  creates visible subjects through Semantic `createSubject`. It installs test grants in the existing Access store.
- Selection runs 100 real `setReaction` commands on one source subject and 10 survivor `love` commands for the same
  actors. The registered `content_reaction_count` effect projects those commands before completion is measured.
- Completion merges through Semantic `mergeSubjects`, resumes the registered Content `effectsRelay`, and awaits the
  event-derived `content.subjectReactionMerge` workflow and its registered reaction projection work. One scenario
  chains source → intermediate → final before the relay resumes, so the worker must resolve the final survivor. Ten
  existing survivor slots retain `love`; 90 source `like` slots move. The exact 100 source actors require a 100-row
  page and a terminal empty check; the chained intermediate then has one empty page. Each measured operation also
  submits one ungranted native reaction and requires the ordinary Access denial without creating a slot.
- Replay injects one driver-boundary error on the real second page query. The registered DBOS page step retries from
  its saved first-page cursor. The retry remains in the growth observer's process and captures the production runner
  and relay SQL. It must produce three page-query attempts (full page, failed empty check, successful empty check),
  exactly 190 ordinary reaction events, no source slots, 100 final slots, and final public counts of 90 likes and 10
  loves. The failure is test-only and does not alter product retry policy.

Replay decision: use a one-shot failure on the actual registered page step so native DBOS retries the persisted cursor
inside the measured process and its runner SQL remains in the shared growth capture.

## Independent populations and bounds

Each report varies one unrelated population at 256, 1024, and 4096 while keeping each selected source page at exactly
100 actors and all command, page, and relay limits fixed:

| Axis | Seeded population |
| --- | --- |
| Subjects | `semantic.subject` rows on unrelated routed subjects |
| Actors | `content.reaction` and `content.subject_reactor` rows for unrelated actors on a separate subject |
| History | Retained `subject.merge` and `content.reaction.set` receipts in the source command partition |

The Content Cost contract bounds each selected page to at most 100 actor commands, constant statements and rows at a
fixed page size, and logarithmic block growth. These measurements claim bounded page completion and checkpoint retry;
they do not claim that an unbounded merge has constant total work.

## Execution record

- Source base: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`.
- Acceptance command: `bun run --cwd services/kernel check test/content/growth-subject-reaction-merge-completion.test.ts`.
- Fixtures: native Content/Auth/Access composition, registered production Content runtime, the shared growth observer,
  and private seeded pressure populations. Existing merge page and functional tests remain unchanged.
- Reached assertions: authored for the exact terminal empty check, chained final-survivor resolution, survivor-slot
  preference, ordinary event/count convergence, checkpoint retry without repeated source movement, and native cost
  capture at all three scales.
- Scale observations: 256, 1024, and 4096 are the asserted seed sizes for each independent axis. Runtime observations
  were not captured in this source attempt because the controller launch defers acceptance until integration; no
  acceptance pass is claimed here.
- Execution limits: acceptance, native, browser, root, worker, and remote checks are deferred by the current launch
  context. The changed kernel workspace will be type-checked before delivery.
