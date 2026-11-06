/** Owner-query use case. Search preparation and Source capture arrive as Library capabilities. */

import type { SearchPreparationCapability, SourceCaptureCapability } from '../contract/index.ts';
import type { OwnerQueryInput, OwnerQueryOpen } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';

export function createOwnerQueryApplication(capabilities: {
  sourceCapture: SourceCaptureCapability;
  searchPreparation: SearchPreparationCapability;
  search?: unknown;
  access?: unknown;
  routeKey?: Uint8Array;
}) {
  return {
    async open(input: OwnerQueryInput): Promise<OwnerQueryOpen> {
      const prepared = await capabilities.sourceCapture.prepare({
        actor: input.actor,
        collectionId: input.collectionId,
        deadline: input.deadline,
        at: input.at,
        allowance: input.work.remaining(),
        ...(input.logical !== undefined ? { logical: input.logical } : {}),
        ordinaryPage: input.work.plan !== undefined,
      });
      input.work.native(prepared.work);
      return {
        source: prepared.source,
        observation: prepared.source.observation,
        work: input.work.receipt(),
        close() {},
        async originals(subjectId: string) {
          return [subjectId];
        },
        async filter(filter: unknown, releaseDigest: string) {
          if (!capabilities.search || !capabilities.routeKey)
            throw new TypeError('The registered Search preparation is not configured.');
          const preparedScope = await capabilities.searchPreparation.prepareScope({
            search: capabilities.search,
            access: capabilities.access,
            actor: input.actor,
            routeKey: capabilities.routeKey,
            nativeT: input.at,
            deadline: input.deadline,
            filter,
            releaseDigest,
            identity: prepared.source.observation.incarnation,
            allowance: input.work.remaining(),
          });
          input.work.native(preparedScope.work);
          return preparedScope;
        },
      };
    },
  };
}

export type OwnerQueryApplication = ReturnType<typeof createOwnerQueryApplication>;
export type { LibraryActor };
