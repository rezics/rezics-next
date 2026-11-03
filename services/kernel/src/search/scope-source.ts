import {
  admitFilter,
  FilterError,
  parseFilter,
  positiveFilter,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { isDeepStrictEqual } from 'node:util';
import { systemClock, type KernelClock } from '../clock.ts';
import type { CollectionSourceObservation, WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { NativeSourceIdentity } from '../library/native-source-custody.ts';
import { admitCollectionMemberQuery } from '../library/owner-filter.ts';
import { bindOwnerFilterRead } from '../library/owner-filter-plan.ts';
import { withOwnerFilterNativeRead } from '../library/owner-filter-native-binding.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import { readRelease } from '../semantic/definitions.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import { createPublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import {
  createSearchScopeOrder,
  sameScopeObservation,
  type SearchScopeOrder,
  type SearchScopeCollection,
  type SearchScopeOrdinalPrefix,
} from './service-scope-order.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import {
  createScopePreparationStore,
  type ScopeCaptureDefinition,
  type ScopeCaptureFrontier,
} from './scope-preparation-store.ts';
import { createScopePreparation, readPreparedScopeObservation } from './scope-preparation.ts';
import { createOrderedScopePreparation, readOrderedScopeRows } from './scope-preparation-ordered.ts';
import { createScopeOrderedNative } from './scope-ordered-native.ts';
import { checkHits } from './disclosure/check.ts';
import type { PublicFilterSourceDefinition } from '../semantic/public-filter-source-binding.ts';
import { ScopeWork, scopeAllowance, zeroScopeWork, evaluateScopeSubjects } from './scope-execution.ts';
import { compileCurrentOwnerFilter, type CurrentOwnerFilterPlan } from './current-filter-plan.ts';
import { discoveryIndexUuid, subjectGenerations, subjectIndexName } from './indices.ts';
import { searchSubjectHits } from './query.ts';
import { ProblemError } from '../http/problem.ts';
import type { LeafOptions, LeafProgress, LeafWork } from '../semantic/scope-leaf-evidence.ts';
import { packScopeLeafProgress, type ScopeLeafPosition } from './scope-progress.ts';
import { compileFilter } from './filter.ts';
import type { OpenSearch, SearchRequestWork } from './opensearch.ts';
import { isOrdinalKey } from '../library/ordinal.ts';
import { routeOf } from '../route/route.ts';
import type { SearchHit } from './query.ts';
import { readSearchScopeRelease } from './scope-release.ts';
import { createRealmScopeSource, type PreparedRealmScope, type RealmSubjectCapabilities } from './realm-scope.ts';
import type { RealmSubjectSource } from '../content/realm-subject-source.ts';
import { subjectPartition, type IndexedSubject, type RelationFacetMatch, type SubjectSource } from './source.ts';
import {
  readCollectionKindPreparationWorkDefinition,
  readScopeWorkDefinition,
} from './scope-work-context.ts';
