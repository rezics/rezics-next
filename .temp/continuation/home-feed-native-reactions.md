---
goal: web
manager: web
kind: interface
riskAreas: []
criticalPath: false
after:
  - 76757ffe-9b2f-493d-8b9c-0290b81c6c6f
  - 6fa7a5bd-6202-44d7-9266-c0a6ac3ded99
waiting: []
paths:
  - apps/web/src/features/pages/home-feed.tsx
  - apps/web/src/features/pages/home-feed-read.ts
  - apps/web/src/features/feed/home-feed-item.tsx
  - apps/web/src/features/feed/home-reaction-admission.ts
  - apps/web/src/features/feed/home-reaction-currentness.tsx
  - apps/web/src/features/feed/README.md
  - apps/web/messages/en.json
  - apps/web/messages/zh-Hant.json
  - apps/web/messages/zh-Hans.json
  - apps/web/messages/ja.json
  - apps/web/messages/ko.json
  - apps/web/messages/de.json
  - apps/web/messages/fr.json
  - apps/web/messages/es.json
  - apps/web/src/stories/home-native-reactions.stories.tsx
  - apps/web/tests/home-native-reactions.test.tsx
  - apps/web/tests/thread-reactions-lifetime.test.tsx
  - packages/client/src/kernel/content/
acceptance:
  command:
    - bun
    - apps/web/scripts/focused.ts
    - "--private-network"
    - "--"
    - bun
    - test
    - tests/home-native-reactions.test.tsx
    - tests/board-feed-interface.test.tsx
    - tests/feed-action-bar.test.tsx
    - tests/thread-reactions-lifetime.test.tsx
    - tests/board-community.test.ts
    - tests/board-about-family.test.tsx
    - tests/board-feed-copy-link.test.tsx
    - tests/historical-reader-compatibility.test.tsx
    - tests/post-history-recovery.test.ts
    - tests/18-revision-history-reading.test.tsx
  placement: default
  tests:
    - "The installed generated Content summary supplies the exact reaction target, positive counts, viewer slot and page freshness to the existing FeedActionBar/ThreadReactions owner; thread target identity is never inferred from summary.id."
    - "Select, switch, clear, refusal rollback, unknown retry/readback and fresh-page reconciliation use the existing command engine and retire old page, viewer, session, selection, target and source observations."
    - "Missing projection remains unavailable; known empty counts remain zero; anonymous viewer omission differs from signed-in null. No hidden or mute capability is fabricated."
    - "Projection is O(N) for the already bounded page at 1/10/20 rows and duplicate targets, with no mount reaction reads, no per-row feed requests, bounded controllers and the native 20-row/160-candidate/one-mixed-round boundary unchanged."
    - "Prepared Board replyCount proves receiving and exact inspection only; actual native delivery is claimed only when its installed schema supplies the field. Exact reaction/reply operands, signed score, zero versus unavailable and reply destination remain mounted and accessible."
    - "Connected phone390/desktop1280 light/dark stories cover five initial pins, continuation without duplicates, exact compact counts, missing counts, anonymous/current viewer states, refusal, unknown recovery, target mismatch and stale/revoked observations."
    - "The historical-reader, post-history-recovery and 18-revision suites preserve returned-revision source, reader/session/cursor behavior and the README section placement. Rendered and native claims require their own evidence."
  failing: true
estimate:
  lines: 2250
  files: 18
---

# Remaining outcome

Publish the Kernel-owned optional `reactionTarget`, `reactions`, `viewerReaction` and page `reactionsAsOf` fields through the normal generated-client flow before binding Home to them. The current generated Web client still omits those fields. This attempt's client generation could not complete: the direct Kernel client command had no database URL, while the placement-aware `typecheck --emit-client` ended with existing repository type errors and did not return its generated output. Do not edit generated declarations by hand or add a browser cast/parallel reaction DTO.

After publication, complete the supplied Home behavior using the generated fields verbatim and the existing reaction engine. Keep absent projections unavailable, preserve known zero counts and anonymous versus signed-in viewer states, retire stale observations, and add the mounted tests, stories and locale copy described above. Preserve the existing shared-bar reply-count inspection without claiming native delivery from its prepared fixture. Run the frozen acceptance after integration.
