/** Identity/disclosure adapter. Semantic implements Library's original/terminal port at composition. */

import { durableInitiatorCommitment } from '../../access/index.ts';
import { readIdentityMappings, readRelease } from '../../semantic/identity-adapters/index.ts';
import type { IdentityDisclosureCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';

export function createIdentityDisclosureAdapter(): IdentityDisclosureCapability {
  return {
    readRelease(source, digest, options) {
      return readRelease(source as Parameters<typeof readRelease>[0], digest, options);
    },
    async readOriginalTerminal(input) {
      if (input.actor.kind !== 'account') return { original: input.subjectId, terminal: input.subjectId };
      try {
        const mappings = await readIdentityMappings({
          accountId: input.actor.accountId,
          originals: [input.subjectId],
          deadline: input.deadline,
        } as Parameters<typeof readIdentityMappings>[0]);
        const mapped = Array.isArray(mappings) ? mappings[0] : undefined;
        const terminal =
          mapped && typeof mapped === 'object' && 'terminal' in mapped
            ? String((mapped as { terminal?: string }).terminal ?? input.subjectId)
            : input.subjectId;
        return { original: input.subjectId, terminal };
      } catch {
        return { original: input.subjectId, terminal: input.subjectId };
      }
    },
    initiatorCommitment(original) {
      return durableInitiatorCommitment(original as Parameters<typeof durableInitiatorCommitment>[0]);
    },
  };
}

export type { LibraryActor };
