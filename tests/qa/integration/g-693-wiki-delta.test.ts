import { test } from 'bun:test';
import { wikiDeltaJourney } from './g-693-wiki-journey.ts';

test(
  'G-693: chapter deltas preserve omission, reviewed retraction/revert, pins and rights across history/export',
  wikiDeltaJourney,
  180_000,
);
