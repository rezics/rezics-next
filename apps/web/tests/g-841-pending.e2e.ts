import { test } from '@playwright/test';

// The acceptance queries whose UI owner has not merged. Each is recorded here with that owner and is skipped,
// never passed: the API half of every one is pending too (`tests/qa/integration/g-840-catalogue.test.ts`
// lists the same owners). When an owner merges, replace its entry with a journey in a `g-841-*.e2e.ts` file.
const pending = [
  { query: 7, owner: 'G-920', clause: 'contradictory wiki facts coexist with continuity scope and spoiler boundaries',
    reason: 'published wiki Statements do not reach the entity page until G-920, and the entity page shows a Statement without its continuity or the position that reveals it' },
  { query: 12, owner: 'G-831', clause: 'event membership never merges Works',
    reason: 'event overlaps are writable, but a Work page lists only relations whose definition has a lexicon presentation, and none exists for an event overlap' },
] as const;

for (const item of pending) {
  test(`query ${item.query}: ${item.clause} (pending ${item.owner})`, () => {
    test.info().annotations.push({ type: 'pending', description: `${item.owner}: ${item.reason}` });
    test.skip(true, `Pending ${item.owner}: ${item.reason}`);
  });
}
