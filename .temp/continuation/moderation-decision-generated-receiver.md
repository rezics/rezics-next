---
{
  "goal": "web",
  "manager": "web",
  "kind": "interface",
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "account",
    "deletion"
  ],
  "criticalPath": false,
  "after": [
    "a3c42ab6-5dc2-4e7d-89a5-4bab9df35a9a",
    "80fa0fd9-0262-4b01-a8d3-4afce09b8277"
  ],
  "waiting": [],
  "paths": [
    "apps/web/src/moderation/decision-read.ts",
    "apps/web/src/moderation/decision-read-model.ts",
    "apps/web/src/moderation/decision-page.tsx",
    "apps/web/src/moderation/appeal.ts",
    "apps/web/src/moderation/command-intent.ts",
    "apps/web/src/routes/moderation/decisions.$id.tsx",
    "apps/web/src/moderation/README.md",
    "apps/web/src/moderation/private-reader-lifetime.md",
    "apps/web/src/stories/moderation-decision.stories.tsx",
    "apps/web/src/stories/patterns/moderation-decision/**",
    "apps/web/tests/moderation-decision.test.ts",
    "apps/web/tests/moderation-decision-native-page.test.tsx",
    "apps/web/tests/decision-appeal-result-focus.test.tsx",
    "apps/web/tests/moderation-private-reader-lifetime.test.tsx",
    "apps/web/tests/moderation-case-reference-interface.test.tsx",
    "apps/web/tests/moderation-private-case-content-item.test.tsx",
    "apps/web/messages/*.json",
    "docs/goals/web.md"
  ],
  "estimate": {
    "lines": 900,
    "files": 18
  },
  "acceptance": {
    "command": [
      "bun",
      "apps/web/scripts/focused.ts",
      "--private-network",
      "--",
      "bun",
      "test",
      "tests/moderation-decision.test.ts",
      "tests/moderation-decision-native-page.test.tsx",
      "tests/decision-appeal-result-focus.test.tsx",
      "tests/moderation-private-reader-lifetime.test.tsx",
      "tests/moderation-case-reference-interface.test.tsx",
      "tests/moderation-private-case-content-item.test.tsx"
    ],
    "placement": "default",
    "failing": true,
    "tests": [
      "The generated composed response and actual producer examples render restored current context, concealed context or unavailable context independently from the readable decision receipt.",
      "The closed native permitted, unavailable and unsupported advice variants control appeal presentation; authorship, target readability and local time never grant authority, and native submission reauthorizes.",
      "The exact decision, statement, idempotency key and credentials survive uncertain submission for explicit retry; command acknowledgement and current readback remain distinct.",
      "Account/session/CSRF, locale, exposure, native source and route replacement retire reasons, context, destinations, advice, drafts and late callbacks; fresh recovery restores only a newly admitted page.",
      "One composed native decision response replaces target hydration; pending, upheld and reversed readback, exact same-intent retry, lost acknowledgement, keyboard return and replacement during an outstanding operation are covered within supplied text/context bounds and unrelated fixture history.",
      "Connected decision stories use actual producer examples and cover 390px/1280px light/dark, keyboard submit/retry/open/return, 44px controls and all eight locales through existing Storybook custody."
    ]
  }
}
---

# Receive native appeal advice and current target context

Content source now defines a single composed decision response with receipt fields, a closed `viewer.appeal` variant,
closed current `targetContext` variants, and final source provenance. The installed generated Web client still exposes
only the existing receipt fields, so this attempt kept a typed unavailable seam and a single selected decision read.
It did not add copied DTOs, widened casts, raw endpoint adapters or fabricated links/advice. The decision page can show
the retained receipt only when generated provenance is available; until then its production route remains unavailable.

After generated publication, consume the actual response and producer examples in the same reader. Render available,
concealed and unavailable current context separately while preserving the independent receipt and native operational
reasons. Use only current native Board/Thread destinations through existing localized route helpers. Permit the appeal
form only for current native permitted advice plus current browser command admission; explain unavailable and
unsupported advice in localized language. Preserve native write authorization, original intent/key/credentials on
uncertain retry, explicit departure and draft handling, independent command acknowledgement/readback, keyboard result
focus, and private-reader retirement across account, session/CSRF, locale, exposure, route, source and late callback
replacement. Add connected stories from producer examples and complete the named mounted tests and Storybook review.

Keep the cost contract in the moderation owner guide: one selected composed read plus session preparation; one
explicit appeal and supported readback; one-visit retention; no target hydration, queue scan, polling, persistent draft
or accumulated receipts. Preserve the producer's actual read-side string/byte limits and state clearly that consumer
variation does not prove constant nested native work; Content/controller owns that evidence.
