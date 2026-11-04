---
goal: web
manager: web
kind: interface
paths:
  - apps/web/src/features/feed/home-public-owner/**
  - apps/web/src/features/feed/action-bar.tsx
  - apps/web/src/features/pages/home-feed.tsx
  - apps/web/src/features/pages/home-feed-read.ts
  - apps/web/src/kernel/**
  - apps/web/src/stories/home-public-owner*.stories.tsx
  - apps/web/tests/home-public-owner*.test.ts*
  - apps/web/messages/*.json
riskAreas:
  - authorization
  - disclosure
  - rights
  - account
  - deletion
criticalPath: false
waiting: []
after:
  - 64a47e7f-c100-487d-bce0-8fac0194fba7
estimate:
  lines: 1200
  files: 10
acceptance:
  tests:
    - 'Home explains admitted curator/public presentation and carried Realm identity/purpose, distinguishing missing, withheld, unavailable and admitted empty context through native bounded summaries.'
    - 'An admitted signed-in viewer follows or removes the exact Collection/Space edge using existing writers and native current state; unresolved writes, unavailable disclosure, credential replacement and feed replacement cannot expose stale private actions or target a replacement owner.'
---

# Complete native public-owner understanding and follow actions in Home

The current Home cards already use canonical Collection/Space destinations and render their supplied descriptions,
empty or unavailable description state, and missing curator/carrier state. Resume the remaining outcome when the
producer releases its generated native FeedPage contract for bounded admitted public context and authenticated
own-follow state with directional create/remove admission for the exact returned Collection/Space IDs.

Use that generated contract directly. Keep the anonymous/cache-safe public feed separate from the authenticated
viewer projection, bound to no more than 20 exact owners. Use Library FollowControl, existing writers and recovery.
An own removal must remain independently admitted when target disclosure is concealed. Unknown writes retain their
original idempotency key and stay unresolved until deliberate native readback or retry. Replace and retire private
callbacks on pagination, filter/source/locale/page/credential changes; returning to an old selection must not
authorize its old completions. Do not fabricate feed membership, alter server order, combine Subject/private Entry
state, or change native score composition. Keep Home history restoration as the navigation owner.

Add focused tests for admitted public context, concealed removable own edge, uncertain writes, same-cursor recovery,
and owner/credential replacement. Use the mounted Home controls and exact history return. Preserve locales,
keyboard/focus behavior, phone390/desktop1280 and both themes. Follow the current controller validation policy.
