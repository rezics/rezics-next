/** Library process composition. Binds native SQL and foreign Access/Search/Semantic/Content adapters. */

import type { Access } from '../request/access.ts';
import type { Pool } from 'pg';
import { createIdentityNativeApplication, createLibraryApplications } from '../library/application/index.ts';
import {
  createAuthorizationAdapter,
  createContentPublicationAdapter,
  createIdentityDisclosureAdapter,
  createIdentityNativeCatalog,
  createNativeSourceCaptureAdapter,
  createSearchPreparationAdapter,
} from '../library/adapters/index.ts';
import { bindLibraryDomain, peekLibraryDomain } from '../library/domain-binding.ts';
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
      stamp: { epoch: 0 },
      basis: { digest: '', identity: { digest: '' }, query: null, profilePins: [], projection: null },
    },
  };
}

export function composeLibraryDomain(options: LibraryComposeOptions = {}): LibraryDomain {
  const identityNative =
    options.capabilities?.identityNative ?? createIdentityNativeApplication(createIdentityNativeCatalog());
  const sourceCapture =
    options.sourceCapture ??
    options.capabilities?.sourceCapture ??
    (options.pool && options.access
      ? createNativeSourceCaptureAdapter({
          pool: options.pool,
          access: options.access,
          ordinaryPage: options.ordinaryPage,
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
  const capabilities: LibraryCapabilities & { search?: unknown; access?: unknown; routeKey?: Uint8Array } = {
    authorization: options.capabilities?.authorization ?? createAuthorizationAdapter(options.access),
    identityDisclosure: options.capabilities?.identityDisclosure ?? createIdentityDisclosureAdapter(),
    searchPreparation: options.capabilities?.searchPreparation ?? createSearchPreparationAdapter(options.search),
    contentPublication: options.capabilities?.contentPublication ?? createContentPublicationAdapter(),
    identityNative,
    sourceCapture,
    accountAdmission:
      options.capabilities?.accountAdmission ?? sumAdmission([admissionTerm('composition', { statements: 1 })]),
    search: options.search,
    access: options.access,
    routeKey: options.routeKey,
  };
  return bindLibraryDomain(createLibraryApplications(capabilities));
}

export { peekLibraryDomain, bindLibraryDomain };
