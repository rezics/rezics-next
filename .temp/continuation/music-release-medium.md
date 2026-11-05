---
goal: semantic
manager: semantic
kind: interface
paths:
  - apps/web/src/features/catalogue/music-release-reader/**
  - apps/web/tests/music-release-reader.test.ts
  - apps/web/tests/music-release-visit.test.tsx
  - apps/web/src/stories/music-release-visit.stories.tsx
  - apps/web/messages/**
  - docs/subject-pages.md
riskAreas: [authorization, disclosure, rights, deletion, account]
criticalPath: false
after: []
waiting: []
acceptance:
  command:
    [
      bun,
      scripts/worker-check.ts,
      --local,
      --,
      bun,
      test,
      apps/web/tests/music-release-reader-view.test.tsx,
      apps/web/tests/music-release-reader.test.ts,
      apps/web/tests/music-release-visit.test.tsx,
    ]
  placement: default
  tests:
    - "Choose and read two actual MusicMediums through their released release-membership and inspect each medium's recording/disc order."
  failing: true
estimate: { lines: 720, files: 7 }
---

Finish the part of the album-edition visit that requires actual MusicMedium identities. The retained Definition currently
publishes `schema:MusicRelease`, `schema:MusicRecording` and `schema:track`, but it does not publish `rezics:MusicMedium`
or a release-to-medium membership relation. Wait for the import owner to publish that exact descriptor and relation;
then use them to select two real media, read their native recording order and disc/side qualifiers, and retry one medium
without losing the other disclosed window. Keep this reader's fresh native reads, bounded Previous/return addresses,
whole-association disclosure gate and existing correction/inspection entries. Do not invent a medium Type, relation,
mapping or fixture authority.
