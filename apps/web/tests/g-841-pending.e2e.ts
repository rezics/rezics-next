import { test } from '@playwright/test';

// The acceptance queries whose UI owner has not merged. Each is recorded here with that owner and is skipped,
// never passed: the API half of every one is pending too (`tests/qa/integration/g-840-catalogue.test.ts`
// lists the same owners). When an owner merges, replace its entry with a journey in a `g-841-*.e2e.ts` file.
const pending = [
  { query: 5, owner: 'G-652', clause: 'edition, story, translation, manga and anime reviews filter separately, every aggregate states its scope',
    reason: 'the Work page has no review list, and Main takes no review grain' },
  { query: 7, owner: 'G-847', clause: 'contradictory wiki facts coexist with continuity scope and spoiler boundaries',
    reason: 'statements cannot record continuity or a spoiler boundary, and no page shows them' },
  { query: 12, owner: 'G-831', clause: 'event membership never merges Works', reason: 'event-overlap relations are not writable' },
  { query: 12, owner: 'G-655', clause: 'contributors keep one identity across Zones', reason: 'Zone reads reject a contributor identity' },
] as const;

for (const item of pending) {
  test(`query ${item.query}: ${item.clause} (pending ${item.owner})`, () => {
    test.info().annotations.push({ type: 'pending', description: `${item.owner}: ${item.reason}` });
    test.skip(true, `Pending ${item.owner}: ${item.reason}`);
  });
}
