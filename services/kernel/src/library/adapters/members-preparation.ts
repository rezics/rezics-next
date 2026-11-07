/** Install the supplied native owner-filter implementation and reservation capability in one application. */

import { createMembersPreparationApplication } from '../application/index.ts';
import type { LibraryDomain } from '../contract/index.ts';
import {
  createMembersPreparationNative,
  createMembersPreparationReader,
  checkMembersPreparationCompletionNative,
  readPreparationOwnerFenceNative,
  type MembersPreparation,
  type PreparedMembersReadOperation,
} from '../members-preparation.ts';
import {
  createOwnerFilterPlan,
  type OwnerFilterNativeOperations,
  type OwnerFilterPlan,
  type OwnerFilterPlanDependencies,
  type OwnerFilterReservation,
} from '../owner-filter-plan.ts';
import {
  bindNativeOwnerFilterRead,
  nativeOwnerFilterBinding,
  nativeOwnerFilterPagePlan,
  releaseNativeOwnerFilterRead,
  revalidateOwnerFilterDisclosure,
  sameOwnerFilterSource,
  withNativeOwnerFilterSource,
} from '../owner-filter-native-binding.ts';
import {
  evaluateNativeOwnerFilterCandidate,
  readNativeOwnerFilterClosure,
  retainNativeOwnerFilterPopulation,
} from '../owner-filter-native-closure.ts';
import type { LibraryMembersPreparationRuntime, MembersPreparationStoreDependencies } from '../domain.ts';
import type { PreparedMembersReadDependencies } from '../members-preparation.ts';

type Capabilities = Pick<
  LibraryDomain,
  'authorization' | 'identityDisclosure' | 'searchPreparation' | 'memberPreparation'
>;

function nativeOwnerFilter(): OwnerFilterNativeOperations {
  const native: OwnerFilterNativeOperations = {
    bind: bindNativeOwnerFilterRead,
    async readClosure(binding, source, subjectId, work, deferDisclosure = false) {
      return withNativeOwnerFilterSource(binding, work, () =>
        readNativeOwnerFilterClosure(binding, source, subjectId, work, deferDisclosure),
      );
    },
    evaluate: evaluateNativeOwnerFilterCandidate,
    release: releaseNativeOwnerFilterRead,
    binding: nativeOwnerFilterBinding,
    pagePlan: nativeOwnerFilterPagePlan,
    withSource: withNativeOwnerFilterSource,
    sameSource: sameOwnerFilterSource,
    revalidateDisclosure: revalidateOwnerFilterDisclosure,
    retainPopulation: retainNativeOwnerFilterPopulation,
  };
  return Object.freeze(native);
}

/** Each caller supplies its current Pool/Access/work client; no registry is consulted by the app. */
export function createMembersPreparationAdapter(capabilities: Capabilities): LibraryMembersPreparationRuntime {
  const native = nativeOwnerFilter();
  const reservation: OwnerFilterReservation = Object.freeze({
    reserve(dependencies, actor, collectionId, definitions, options) {
      return createMembersPreparationNative({
        ...dependencies,
        capabilities,
        ownerFilter: native,
      }).reserve(actor, collectionId, definitions, options);
    },
  });
  const application = createMembersPreparationApplication<
    OwnerFilterNativeOperations,
    OwnerFilterReservation,
    MembersPreparationStoreDependencies,
    OwnerFilterPlanDependencies,
    undefined,
    MembersPreparation,
    OwnerFilterPlan,
    PreparedMembersReadOperation
  >({
    native,
    reservation,
    createPreparation(dependencies, implementation, reserve) {
      const preparation = createMembersPreparationNative({
        ...dependencies,
        capabilities,
        ownerFilter: implementation,
      });
      return {
        ...preparation,
        reserve: (actor, collectionId, definitions, options) =>
          reserve.reserve(dependencies, actor, collectionId, definitions, options),
      };
    },
    createPlan(dependencies, implementation, reserve) {
      return createOwnerFilterPlan(dependencies, implementation, reserve);
    },
    createReader(_dependencies, implementation) {
      return createMembersPreparationReader(capabilities, implementation);
    },
  });
  const reader = application.createReader(undefined);
  return Object.freeze({
    native: application.native,
    reservation: application.reservation,
    createPreparation(dependencies: MembersPreparationStoreDependencies) {
      return application.createPreparation(dependencies);
    },
    createPlan(dependencies) {
      return application.createPlan(dependencies);
    },
    readPreparedMembers: (dependencies: PreparedMembersReadDependencies, input, options) =>
      reader(dependencies, input, options),
    checkCompletion: checkMembersPreparationCompletionNative,
    readOwnerFence: (tx, locator, definition) =>
      readPreparationOwnerFenceNative(tx, locator, definition, capabilities),
  });
}
