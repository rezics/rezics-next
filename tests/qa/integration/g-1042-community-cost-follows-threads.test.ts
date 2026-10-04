import { test } from 'bun:test';
import { communityCostDimension } from './g-1042-community-cost-support.ts';

test(
  'G1026: threads API profiles keep bounded hydration as follows grows',
  () => communityCostDimension('follows', 'threads'),
  470_000,
);
