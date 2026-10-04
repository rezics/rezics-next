import { test } from 'bun:test';
import { communityCostDimension } from './g-1042-community-cost-support.ts';

test(
  'G1026: threads API profiles keep bounded hydration as historyDepth grows',
  () => communityCostDimension('historyDepth', 'threads'),
  470_000,
);
