import { test } from 'bun:test';
import { communityCostDimension } from './g-1042-community-cost-support.ts';

test(
  'G1026: surfaces API profiles keep bounded hydration as realmSize grows',
  () => communityCostDimension('realmSize', 'surfaces'),
  470_000,
);
