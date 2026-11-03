---
goal: web
manager: web
kind: interface
riskAreas:
  - authorization
  - disclosure
  - account
  - deletion
  - rights
criticalPath: false
after:
  - 97ee5f14-ddf2-419b-99ec-1a18f6e3e708
  - 52e026d8-af7f-4b6e-a375-0834907b2b66
waiting: []
paths:
  - apps/web/src/threads/own-drafts/**
  - apps/web/src/threads/composer*.tsx
  - apps/web/src/routes/drafts.tsx
  - apps/web/src/shell/navigation*
  - apps/web/src/stories/own-drafts.stories.tsx
  - apps/web/tests/own-drafts*.test.ts*
  - apps/web/tests/own-drafts-fixture.ts
  - apps/web/messages/*.json
  - docs/goals/web.md
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - tests/own-drafts-page.test.tsx
    - tests/own-drafts-resume.test.tsx
    - tests/own-drafts-commands.test.tsx
  placement: default
  tests:
    - "A signed-in person opens the localized private /drafts destination from existing account navigation using the installed generated list and exact selected-read methods; no-store data stays out of persistent browser state."
    - "The selected exact native post resumes in InlinePostEditor with its thread, post, revision, language, licence, Subjects and media intact; independently named browser-local writing requires an explicit body choice."
    - "Native-permitted save, publish and erase preserve exact uncertain intents for explicit retry, support known-conflict inspection, and distinguish command acknowledgement from supported current readback."
    - "Account, credential/CSRF epoch, locale, source, cursor and revision replacement synchronously retire composer context, command advice, retry material and delayed effects; retain distinct preparing, sparse, concealed, unavailable, denied and empty states."
    - "Connected phone/desktop light/dark stories cover ready, preparing, selected, conflict, uncertain command, erase review, denied and long-localized states, with keyboard focus and eight-locale copy. Keep one 20-row page and one native selected body without polling or refill."
  failing: true
estimate:
  lines: 1400
  files: 18
---

# Finish the private account-to-writing visit

Use the existing inventory and exact inspection in `apps/web/src/threads/own-drafts/` and its `OwnDraftReader`
contract. The retained consumer already replaces bounded pages, reads one body on explicit selection, aborts
retired reads, clears changed/concealed metadata and advice, and restores keyboard focus. Preserve those bounds
and the mounted 1/10/20-row scenarios while completing the writing journey.

Bind generated Content list and exact selected-read methods to a signed-in localized `/drafts` destination and
existing account navigation. Read the native wire/action contract in `services/kernel/src/content/README.md`,
section **Private acknowledged drafts**, before adapting it. The installed client declaration currently lacks
these methods; work against the documented `OwnDraftReader` seam while publication is unavailable, then bind
only generated typed methods. Native paths are advice validated against account/thread/post/revision, never
browser fetch destinations. Keep inventory, selected bodies, cursors and retry state in private component memory.

Offer deliberate resume in the existing InlinePostEditor. Preserve the exact selected writing context and all
native media. Show server-saved and browser-saved writing as independent sources, explain their provenance, and
require an explicit choice before either body enters the editor. Never overwrite either source silently.

Save, publish and erase must use only currently offered native actions. Keep exact uncertain command body,
revision precondition, action and idempotency key for explicit retry; editing cannot silently change an unresolved
intent. A known conflict permits inspection and deliberate adoption of the current native head. Review erasure
before submitting. Explain acknowledgement separately from supported readback of retained content, publication
or erasure; concealment and failed reads are not proof of erasure. Retire all writing and command material on the
same account, credential/CSRF, locale, source, cursor and revision boundaries as inspection.

Complete mounted route, composer, browser-choice, command, conflict and readback tests in the named suites.
Existing `own-drafts-commands.test.tsx` pins action-advice guards only; expand it with the actual command journey.
Keep unchanged inventory assertions. Complete eight-locale copy and the named connected phone/desktop light/dark
states. Content retains native history-growth acceptance.
