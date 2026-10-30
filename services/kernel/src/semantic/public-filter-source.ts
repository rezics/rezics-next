import type { CommandTransaction } from '../command/command.ts';
import type {
  PrivacyReduction,
  PrivacyReductionLogEntry,
  PrivacyReductionLogRequest,
  PrivacyReductionObservationRequest,
  PrivacyReductionObservation,
  PublicFilterProjectionMeaning,
  PublicFilterProjectionRequest,
  PublicFilterSource,
  PublicFilterSourceFactory,
  RecordPrivacyReduction as RecordPrivacyReductionType,
} from './public-filter-source-contract.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { JoinedPopulationRequest, PublicFilterNativeSource } from './public-filter-source-binding.ts';
import type { PublicFilterConsumerContext, PublicCanonicalCaptureInput } from '../search/public-filter-consumer-contract.ts';
import { createPublicFilterSourceBinding } from './public-filter-source-binding.ts';

type SourceConfiguration = Parameters<PublicFilterSourceFactory>[0];
const origins = new WeakMap<PublicFilterSource, SourceConfiguration>();

/** Internal constructor routing only. The binding independently validates persisted owner rows. */
export function publicFilterSourceOrigin(source: PublicFilterSource): SourceConfiguration | undefined {
  return origins.get(source);
}

const cost = () => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});

/**
 * Provisional producer boundary. Native projection and reduction storage has not landed here yet,
 * so every read remains explicitly unready and no empty population or zero head is asserted.
 */
export const publicFilterSource: PublicFilterSourceFactory = (config) => {
  if (!config.pool || typeof config.pool.connect !== 'function' || typeof config.pool.query !== 'function')
    throw new TypeError('A native pool is required');
  if (!(config.routeKey instanceof Uint8Array) || config.routeKey.byteLength < 32)
    throw new TypeError('Route key must contain at least 32 bytes');
  if (!config.access || typeof config.access.authorize !== 'function' || typeof config.access.authenticate !== 'function')
    throw new TypeError('A native Access instance is required');
  const unavailable = { status: 'unready' as const, reason: 'metadata_missing' as const, cost: cost() };
  const source: PublicFilterNativeSource = {
    async resolvePublicFilterDefinition(
      request: Readonly<{ meaning: PublicFilterProjectionMeaning; capture: PublicCanonicalCaptureInput }>,
      context: PublicFilterConsumerContext,
    ) {
      const native = origins.get(source)!;
      const result = await createPublicFilterSourceBinding(native.pool, native.routeKey, native.access)
        .resolve({ source, ...request }, context);
      if (result.status === 'resolved') return { status: 'bound', definition: result.definition, cost: result.cost };
      return {
        status: result.status,
        reason: result.reason === 'deadline' ? 'deadline' : 'source_pending',
        cost: result.cost,
      };
    },
    async readPublicFilterProjectionPage(_request: PublicFilterProjectionRequest) {
      return unavailable;
    },
    async readPrivacyReductionHeads(
      _request: PrivacyReductionObservationRequest | JoinedPopulationRequest,
      _context?: PublicFilterConsumerContext,
    ): Promise<PrivacyReductionObservation> {
      return unavailable;
    },
    async readPrivacyReductionPage(_request: PrivacyReductionLogRequest) {
      return unavailable;
    },
  };
  origins.set(source, Object.freeze({ ...config, routeKey: new Uint8Array(config.routeKey) }));
  return Object.freeze(source);
};

/** Native transaction integration will replace this fail-closed adapter. */
export const recordPrivacyReduction: RecordPrivacyReductionType = async (
  _tx: CommandTransaction,
  _reduction: PrivacyReduction,
): Promise<PrivacyReductionLogEntry> => {
  throw new AccessUnavailableError('overloaded');
};
