/** Identity/disclosure adapter. Semantic implements Library's original/terminal port at composition. */

import type { Pool } from 'pg';
import { durableInitiatorCommitment } from '../../access/index.ts';
import { readIdentityMappings, readRelease } from '../../semantic/identity-adapters/index.ts';
import type { IdentityDisclosureCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';

export function createIdentityDisclosureAdapter(pool?: Pool): IdentityDisclosureCapability {
  return {
    readRelease(source, digest, options) {
      return readRelease(source as Parameters<typeof readRelease>[0], digest, options);
    },
    async readOriginalTerminal(input) {
      if (input.actor.kind !== 'account' || !pool) return { original: input.subjectId, terminal: input.subjectId };
      const mappings = await readIdentityMappings(pool, [input.subjectId]);
      const mapped = mappings[0];
      if (mapped?.state === 'mapped') return { original: mapped.original, terminal: mapped.terminal };
      return { original: input.subjectId, terminal: input.subjectId };
    },
    initiatorCommitment(original) {
      return durableInitiatorCommitment(original as Parameters<typeof durableInitiatorCommitment>[0]);
    },
  };
}

export type { LibraryActor };
