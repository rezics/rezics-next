import type { Pool } from 'pg';
import type { CommunityDeclaredEffects, CommunityPool } from '../contract/index.ts';
import { createCommunityAccountErasureEffect } from '../account-erasure.ts';
import { createMemberLocatorEffect } from '../member-locator.ts';
import { createPartyLocatorEffect } from '../party-locator.ts';
import { createRevisionLocatorEffect } from '../revision-locator.ts';
import { createSpaceDiscoveryEffect } from '../space-discovery.ts';

function asPool(pool: CommunityPool): Pool {
  return pool as Pool;
}

/** Declared Community effects. The worker register consumes this; tests may install the same list. */
export const communityDeclaredEffects: CommunityDeclaredEffects = (operands) => {
  const pool = asPool(operands.pool);
  return Object.freeze([
    createRevisionLocatorEffect(pool),
    createSpaceDiscoveryEffect(pool),
    createMemberLocatorEffect(pool),
    createPartyLocatorEffect(pool, operands.clock),
    createCommunityAccountErasureEffect({ client: operands.client as never }),
  ]);
};
