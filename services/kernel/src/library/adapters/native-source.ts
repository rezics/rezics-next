/** Native Source capture adapter. Uses the existing Collection Source factory on the live pool. */

import type { Pool } from 'pg';
import type { Access, Actor } from '../../request/access.ts';
import type { SourceCaptureCapability } from '../contract/index.ts';
import { createCollectionSource, createOrdinaryCollectionPageSource } from '../collection-source.ts';
import type { LibraryActor } from '../contract/index.ts';

export function createNativeSourceCaptureAdapter(dependencies: {
  pool: Pool;
  access: Access;
  ordinaryPage?: boolean;
}): SourceCaptureCapability {
  const source = dependencies.ordinaryPage
    ? createOrdinaryCollectionPageSource(dependencies)
    : createCollectionSource(dependencies);
  return {
    prepare(input) {
      return source.prepare({
        actor: input.actor as Actor,
        collectionId: input.collectionId,
        deadline: input.deadline,
        at: input.at as Parameters<typeof source.prepare>[0]['at'],
        allowance: input.allowance,
      });
    },
  };
}

export type { LibraryActor };
