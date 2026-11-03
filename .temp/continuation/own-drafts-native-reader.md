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
  - 21282ce6-49f1-4021-b853-cfcf42a30766
  - 97ee5f14-ddf2-419b-99ec-1a18f6e3e708
  - 52e026d8-af7f-4b6e-a375-0834907b2b66
  - d2091aef-f4c1-41a3-b744-68326863ebbf
waiting: []
paths:
  - apps/web/src/threads/own-drafts/native-reader.ts
  - apps/web/src/threads/own-drafts/model.ts
  - apps/web/src/threads/own-drafts/page.tsx
  - apps/web/src/routes/drafts.tsx
  - apps/web/src/threads/own-drafts/actions.ts
  - apps/web/src/stories/own-drafts.stories.tsx
  - apps/web/tests/own-drafts-page.test.tsx
  - apps/web/tests/own-drafts-resume.test.tsx
  - apps/web/tests/own-drafts-commands.test.tsx
  - apps/web/messages/*.json
  - docs/goals/web.md
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - '--private-network'
    - '--'
    - bun
    - test
    - tests/own-drafts-page.test.tsx
    - tests/own-drafts-resume.test.tsx
    - tests/own-drafts-commands.test.tsx
  placement: default
  tests:
    - A signed-in person opens the localized private /drafts destination from existing account navigation using the installed generated list and exact selected-read methods; no-store data stays out of persistent browser state.
    - 'The selected exact native post resumes in InlinePostEditor with its thread, post, revision, language, licence, Subjects and media intact; independently named browser-local writing requires an explicit body choice.'
    - 'Native-permitted save, publish and erase preserve exact uncertain intents for explicit retry, support known-conflict inspection, and distinguish command acknowledgement from supported current readback.'
    - 'Account, credential/CSRF epoch, locale, source, cursor and revision replacement synchronously retire composer context, command advice, retry material and delayed effects; retain distinct preparing, sparse, concealed, unavailable, denied and empty states.'
    - 'Connected phone/desktop light/dark stories cover ready, preparing, selected, conflict, uncertain command, erase review, denied and long-localized states, with keyboard focus and eight-locale copy. Keep one 20-row page and one native selected body without polling or refill.'
  failing: true
estimate:
  lines: 380
  files: 13
---

The private account-to-writing route, browser-local source choice, composer commands, readback and visual stories are
connected. The installed `@rezics/client` declaration still does not expose the generated `own_drafts.list` and
`own_drafts.resume` methods, so `ownDraftNativeReader` intentionally returns unavailable. Bind the reader only after
those generated typed methods arrive. Keep native paths as validated advice, use its exact 20-row page and selected
body operations, and preserve preparing, concealed, unavailable, denied and same-cursor retry behavior. Do not add
browser fetches or hand-written generated client methods. Verify the delivered adapter with the acceptance command
above after integration.
