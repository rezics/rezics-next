/** Native Source capture adapter. Uses the existing Collection Source factory on the live pool. */

import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { Access, Actor } from '../../request/access.ts';
import type { SourceCaptureCapability } from '../contract/index.ts';
import { createCollectionSource, createOrdinaryCollectionPageSource } from '../collection-source.ts';
import type { LibraryActor } from '../contract/index.ts';

export function createNativeSourceCaptureAdapter(dependencies: {
  pool: Pool;
  access: Access;
  ordinaryPage?: boolean;
}): SourceCaptureCapability {
  const full = createCollectionSource(dependencies);
  const ordinary = createOrdinaryCollectionPageSource(dependencies);
  return {
    prepare(input) {
      const at = input.at;
      if (at === undefined) throw new TypeError('Collection Source prepare requires authoritative time');
      const source = input.source ?? ((input.ordinaryPage ?? dependencies.ordinaryPage) ? ordinary : full);
      return source.prepare({
        actor: input.actor as Actor,
        collectionId: input.collectionId,
        deadline: input.deadline,
        at: at as AuthoritativeTime,
        allowance: input.allowance,
      });
    },
  };
}

export type { LibraryActor };
