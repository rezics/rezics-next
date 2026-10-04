import { test } from 'bun:test';
import { communityCostDimension } from './g-1042-community-cost-support.ts';

test(
  'G1026: surfaces API profiles keep bounded hydration as memberships grows',
  () => communityCostDimension('memberships', 'surfaces'),
  470_000,
);
