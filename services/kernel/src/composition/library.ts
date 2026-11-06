/** Library process composition. Binds native SQL and foreign Access/Search/Semantic/Content adapters. */

import type { Access } from '../request/access.ts';
import type { Pool } from 'pg';
import { createLibraryApplications } from '../library/application/index.ts';
import {
  createAuthorizationAdapter,
  createContentPublicationAdapter,
  createIdentityDisclosureAdapter,
  createNativeIdentityBoundsAdapter,
  createNativeSourceCaptureAdapter,
  createSearchPreparationAdapter,
} from '../library/adapters/index.ts';
import {
  bindLibraryDomain,
  peekLibraryDomain,
  requireLibraryDomain,
  unbindLibraryDomain,
} from '../library/domain-binding.ts';
import {
  preparedSource,
  type LibraryCapabilities,
  type LibraryDomain,
  type PreparedCollectionSource,
} from '../library/contract/index.ts';
import { admissionTerm, sumAdmission } from '../library/core/index.ts';

export type LibraryComposeOptions = Readonly<{
  pool?: Pool;
  access?: Access;
  search?: unknown;
  routeKey?: Uint8Array;
  ordinaryPage?: boolean;
  sourceCapture?: LibraryCapabilities['sourceCapture'];
  capabilities?: Partial<LibraryCapabilities>;
}>;

function stubSource(): PreparedCollectionSource {
  return {
    [preparedSource]: true,
    observation: {
      collectionId: '',
      route: 0,
      incarnation: '',
      revision: 0,
      authority: { kind: 'curated' },
      stamp: { partition: 0, epoch: 0, position: 0n },
      basis: { digest: '', identity: { digest: '' }, query: null, profilePins: [], projection: null },
    },
  };
}

export function composeLibraryDomain(options: LibraryComposeOptions = {}): LibraryDomain {
  const identityNative = options.capabilities?.identityNative ?? createNativeIdentityBoundsAdapter();
  const sourceCapture =
    options.sourceCapture ??
    options.capabilities?.sourceCapture ??
    (options.pool && options.access
      ? createNativeSourceCaptureAdapter({
          pool: options.pool,
          access: options.access,
          ...(options.ordinaryPage !== undefined ? { ordinaryPage: options.ordinaryPage } : {}),
        })
      : {
          async prepare(input) {
            return {
              source: stubSource(),
              work: {
                reservationId: input.allowance.reservationId,
                used: {
                  candidateKeys: 0,
                  nativeRows: 0,
                  identityMetadataRows: 0,
                  emptySeeks: 0,
                  nativePoints: 0,
                  witnessKeys: 0,
                  statements: 0,
                  bytes: 0,
                },
              },
            };
          },
        });
  const extras: { search?: unknown; access?: unknown; routeKey?: Uint8Array } = {};
  if (options.search !== undefined) extras.search = options.search;
  if (options.access !== undefined) extras.access = options.access;
  if (options.routeKey !== undefined) extras.routeKey = options.routeKey;
  const capabilities: LibraryCapabilities & { search?: unknown; access?: unknown; routeKey?: Uint8Array } = {
    authorization: options.capabilities?.authorization ?? createAuthorizationAdapter(options.access),
    identityDisclosure: options.capabilities?.identityDisclosure ?? createIdentityDisclosureAdapter(options.pool),
    searchPreparation: options.capabilities?.searchPreparation ?? createSearchPreparationAdapter(options.search),
    contentPublication: options.capabilities?.contentPublication ?? createContentPublicationAdapter(),
    identityNative,
    sourceCapture,
    accountAdmission:
      options.capabilities?.accountAdmission ?? sumAdmission([admissionTerm('composition', { statements: 1 })]),
    ...extras,
  };
  return bindLibraryDomain(createLibraryApplications(capabilities));
}

export { peekLibraryDomain, bindLibraryDomain, requireLibraryDomain, unbindLibraryDomain };
