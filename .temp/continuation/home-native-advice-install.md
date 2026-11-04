---
goal: content
manager: content
kind: claim
paths:
  - apps/web/src/features/feed/home-feed-reaction.ts
  - apps/web/src/features/feed/action-bar.tsx
  - apps/web/tests/home-native-reactions*.test.*
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
waiting: []
after:
  - eef7e8ee-7762-427f-bbaf-05b0f1c26b3b
estimate:
  lines: 150
  files: 3
criticalPath: false
acceptance:
  tests:
    - 'On the official installed native FeedPage, Home receives current allowed kinds and allowed=[] denial independently of selected kind/counts; signed-out advice forwards the exact original return.'
    - 'Home retains the existing native/Subject baseline and original command retry/discard through equal replacement, fetching, remount and A/B/A; controller runs frozen mounted acceptance.'
---

Enable Home reactions after the existing serial publisher installs `summary.reactionAdvice` in the official client declarations. Use the installed field type and compile-checked installation flag; do not edit generated client files or publish a second client. Add focused mounted tests using actual typed FeedItems for both thread and post targets. Readers must see current allowed kinds and denial independently of selected kind and counts, and signed-out advice must preserve the exact original return. Preserve the prepared recovery owner, original command retry/discard, page refresh ownership, Home providers and slots, review/reply/revision context, occurrence keys, and current input/frontier. The controller runs frozen mounted acceptance.
