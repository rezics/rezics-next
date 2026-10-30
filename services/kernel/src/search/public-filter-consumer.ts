import type { PublicFilterConsumerOperationsFactory } from './public-filter-consumer-contract.ts';

/** PROVISIONAL producer adapter. The mechanics producer replaces this module on integration.
 * Implements only its agreed closed port; it never fabricates registration, ready output or ACK.
 */
export const createPublicFilterConsumerOperations: PublicFilterConsumerOperationsFactory = async () => {
  const unavailable = () => ({
    status: 'unavailable' as const,
    reason: 'dependency_unavailable' as const,
    cost: {
      inputKeys: 0,
      candidates: 0,
      accessPoints: 0,
      dependencyPoints: 0,
      engineSearches: 0,
      engineIteratorSteps: 0,
      outputSlots: 0,
      resultWrites: 0,
      frontierWrites: 0,
    },
  });
  return {
    async capture() {
      return unavailable();
    },
    async query() {
      return unavailable();
    },
    async repairStep() {
      return unavailable();
    },
    async readStatus() {
      return unavailable();
    },
    async closeObservation() {},
    async close() {},
  };
};
