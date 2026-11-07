/** Construct member planning, durable preparation and prepared reads from the same supplied capabilities. */

import type { MembersPreparationApplicationAdapters } from '../contract/members-preparation.ts';

export function createMembersPreparationApplication<
  Native,
  Reservation,
  PreparationDependencies,
  PlanDependencies,
  ReaderDependencies,
  Preparation,
  Plan,
  Reader,
>(
  adapters: MembersPreparationApplicationAdapters<
    Native,
    Reservation,
    PreparationDependencies,
    PlanDependencies,
    ReaderDependencies,
    Preparation,
    Plan,
    Reader
  >,
) {
  return Object.freeze({
    native: adapters.native,
    reservation: adapters.reservation,
    createPreparation(dependencies: PreparationDependencies): Preparation {
      return adapters.createPreparation(dependencies, adapters.native, adapters.reservation);
    },
    createPlan(dependencies: PlanDependencies): Plan {
      return adapters.createPlan(dependencies, adapters.native, adapters.reservation);
    },
    createReader(dependencies: ReaderDependencies): Reader {
      return adapters.createReader(dependencies, adapters.native, adapters.reservation);
    },
  });
}
