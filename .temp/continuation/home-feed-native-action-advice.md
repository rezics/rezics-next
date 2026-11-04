---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "apps/web/src/features/feed/home-feed-reaction.ts",
    "apps/web/src/features/feed/action-bar.tsx",
    "apps/web/src/features/feed/home-card-journey/**",
    "apps/web/tests/home-native-reactions.test.tsx",
    "apps/web/tests/home-subject-reactions.test.tsx",
    "apps/web/src/stories/home-card-journey.stories.tsx",
    "apps/web/messages/*.json"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "waiting": [],
  "after": [],
  "estimate": {
    "lines": 900,
    "files": 7
  },
  "criticalPath": false,
  "acceptance": {
    "tests": [
      "home-native-reactions.test.tsx: installed Content action advice gates signed-in Thread/Post controls and set/change/clear use the shared engine with frozen uncertain retry.",
      "home-subject-reactions.test.tsx: retain Subject action denial/unavailability, sign-in return, set/change/clear and current-session retirement.",
      "Keep the shared successful-session-incarnation controller baseline unchanged."
    ],
    "failing": true
  }
}
---

Finish signed-in Home reactions after Content publishes the per-item native Thread/Post action advice through the retained official client publication. Bind advice to the exact current target, viewer slot, page watermark and source incarnation. Keep disclosed totals and selection visible while action advice is denied, empty or unavailable; offer controls only for the native allowed set. Use the shared reaction engine for set, change, clear, verification, uncertain-result recovery with the frozen original intent, deliberate retry and current-page refresh.

Complete the localized Home card journey in the actual public and prepared signed-in routes. Preserve review citation and exact immediate-parent context, mixed-row order and duplicate occurrences, safe sign-in destinations, currentness retirement and keyboard position. Add the focused journey story and exercise narrow and wide layouts, light and dark themes, en, zh-Hant and ja with long real names. Use seeded native identities for the final walkthrough; prepared stories are not native acceptance evidence.
