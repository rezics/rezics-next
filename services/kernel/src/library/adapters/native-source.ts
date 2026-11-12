/** Native Source capture adapter. Uses the existing Collection Source factory on the live pool. */

import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { Access, Actor } from '../../request/access.ts';
import type { SourceCaptureCapability } from '../contract/index.ts';
import { createCollectionSource, createOrdinaryCollectionPageSource } from '../collection-source.ts';
import type { LibraryActor } from '../contract/index.ts';
import { ProblemError } from '../../http/problem-error.ts';

export function createNativeSourceCaptureAdapter(dependencies: {
  pool: Pool;
  access: Access;
  ordinaryPage?: boolean;
}): SourceCaptureCapability {
  const full = createCollectionSource(dependencies);
  const ordinary = createOrdinaryCollectionPageSource(dependencies);
  return {
    async prepare(input) {
      const at = input.at;
      if (at === undefined) throw new TypeError('Collection Source prepare requires authoritative time');
      if (input.logical && !input.source)
        throw new ProblemError('dependency_unavailable', {
          detail: 'Logical built-ins require the caller’s registered Collection Source.',
        });
      const source = input.source ?? ((input.ordinaryPage ?? dependencies.ordinaryPage) ? ordinary : full);
      const prepared = await source.prepare({
        actor: input.actor as Actor,
        collectionId: input.collectionId,
        deadline: input.deadline,
        at: at as AuthoritativeTime,
        allowance: input.allowance,
        ...(input.logical !== undefined ? { logical: input.logical } : {}),
      });
      const actorAccountId = input.actor.kind === 'account' ? input.actor.accountId : undefined;
      if (
        input.logical &&
        (actorAccountId === undefined ||
          prepared.source.observation.collectionId !== input.collectionId ||
          prepared.source.observation.authority.kind !== 'private_builtin' ||
          prepared.source.observation.authority.curatorAccountId !== actorAccountId)
      )
        throw new ProblemError('dependency_unavailable', {
          detail: 'The caller’s Collection Source has no current owner-bound logical built-in observation.',
        });
      return prepared;
    },
  };
}

export type { LibraryActor };
