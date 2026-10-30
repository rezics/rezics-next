import type { PublicFilterSourceFactory } from './public-filter-source-contract.ts';
import type { PublicFilterNativeSource } from './public-filter-source-binding.ts';

/** PROVISIONAL producer adapter: replace with the Semantic native binding on integration.
 * No population, identity, permission, cut or coverage is inferred from an ordinary SubjectSource.
 */
export const publicFilterSource = ((_config) => {
  const cost = {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
  return {
    async resolvePublicFilterDefinition() {
      return { status: 'unavailable', reason: 'source_pending', cost };
    },
    async readPublicFilterProjectionPage() {
      return { status: 'unavailable', reason: 'dependency_unavailable', cost };
    },
    async readPrivacyReductionHeads() {
      return { status: 'unavailable', reason: 'dependency_unavailable', cost };
    },
    async readPrivacyReductionPage() {
      return { status: 'unavailable', reason: 'dependency_unavailable', cost };
    },
  } satisfies PublicFilterNativeSource;
}) satisfies PublicFilterSourceFactory;
