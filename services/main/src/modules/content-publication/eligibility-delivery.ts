import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ContentCore, EligibilityDeliveryBatch, EligibilityDeliveryPage,
  EligibilityDeliverySourceEvent } from '../../../../content/src/core.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import { verifiedRetainedRelayRange, type RetainedRelayBatch } from '../outbox/relay.ts';
import { ContentEligibilityStateUnavailable,
  readRetainedContentEligibilitySource } from './eligibility-state.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

const SEARCH_ELIGIBLE = 'com.rezics.content.search-eligible.v1';
const SOURCE = 'https://rezics.com/services/main';
const DECIMAL = /^(0|[1-9][0-9]*)$/;

interface RetainedContentEligibilityEnvelope {
  specversion: string;
  id: string;
  source: string;
  type: string;
  datacontenttype: string;
  data: {
    batchId: string;
    sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
    routingEpoch: string;
    ordinal: number;
    relayPosition?: { streamScope: string; dataEpoch: string; sequence: string };
    receipt: Record<string, unknown>;
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value), 'utf8').digest('hex');
}

function envelope(event: unknown, batch: RetainedRelayBatch,
  graphDataEpoch: string): RetainedContentEligibilityEnvelope {
  if (!event || typeof event !== 'object') throw new ContentEligibilityStateUnavailable('retained Main event is malformed');
  const value = event as Partial<RetainedContentEligibilityEnvelope>;
  const data = value.data;
  if (value.specversion !== '1.0' || value.source !== SOURCE || value.datacontenttype !== 'application/json'
    || typeof value.id !== 'string' || !value.id || !data || typeof data !== 'object'
    || data.batchId !== batch.batchId || data.routingEpoch !== batch.routingEpoch
    || !Number.isSafeInteger(data.ordinal) || data.ordinal < 0
    || data.sourcePosition?.datasetId !== 'product'
    || !DECIMAL.test(data.sourcePosition?.sequence ?? '')
    || data.sourcePosition?.dataEpoch !== graphDataEpoch
    || data.relayPosition?.streamScope !== MAIN_RELAY_STREAM_SCOPE
    || data.relayPosition?.dataEpoch !== graphDataEpoch
    || data.relayPosition?.sequence !== batch.sequence
    || !data.receipt || typeof data.receipt !== 'object') {
    throw new ContentEligibilityStateUnavailable('retained Main event differs from its verified batch position');
  }
  return value as RetainedContentEligibilityEnvelope;
}

function sourceEvent(event: RetainedContentEligibilityEnvelope):
  | Omit<EligibilityDeliverySourceEvent, 'publication'> | undefined {
  if (event.type !== SEARCH_ELIGIBLE) return undefined;
  const receipt = event.data.receipt;
  if (typeof receipt.id !== 'string' || receipt.action !== 'content.search-eligibility'
    || receipt.outcome !== 'succeeded' || typeof receipt.requestDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)
    || typeof receipt.resource !== 'string' || typeof receipt.variant !== 'string'
    || typeof receipt.publicationDecision !== 'string' || typeof receipt.eligibilityDecision !== 'string'
    || receipt.disclosure !== 'public') {
    throw new ContentEligibilityStateUnavailable('retained Public eligibility event has an incomplete receipt');
  }
  return {
    id: event.id,
    type: SEARCH_ELIGIBLE,
    ordinal: event.data.ordinal,
    sourcePosition: { dataEpoch: event.data.sourcePosition.dataEpoch,
      sequence: event.data.sourcePosition.sequence },
    receipt: { id: receipt.id, action: 'content.search-eligibility', outcome: 'succeeded',
      requestDigest: receipt.requestDigest, resource: receipt.resource, variant: receipt.variant,
      publicationDecision: receipt.publicationDecision, eligibilityDecision: receipt.eligibilityDecision,
      disclosure: 'public' },
  };
}

function checkedBatch(batch: RetainedRelayBatch, graphDataEpoch: string): { header: Omit<EligibilityDeliveryBatch, 'events'>;
  eligible: Array<{ event: Omit<EligibilityDeliverySourceEvent, 'publication'>; envelope: RetainedContentEligibilityEnvelope }> } {
  if (batch.streamScope !== MAIN_RELAY_STREAM_SCOPE || !DECIMAL.test(batch.sequence)
    || !batch.batchId || !batch.routingEpoch || !Array.isArray(batch.events) || batch.events.length === 0) {
    throw new ContentEligibilityStateUnavailable('retained Main batch is incomplete');
  }
  const events = batch.events.map(value => envelope(value, batch, graphDataEpoch));
  if (events.some((event, ordinal) => event.data.ordinal !== ordinal)) {
    throw new ContentEligibilityStateUnavailable('retained Main batch event order is incomplete');
  }
  return { header: { sequence: batch.sequence, id: batch.batchId,
    digest: digest({ streamScope: batch.streamScope, sequence: batch.sequence,
      batchId: batch.batchId, routingEpoch: batch.routingEpoch, events }) },
  eligible: events.flatMap(value => {
    const source = sourceEvent(value);
    return source ? [{ event: source, envelope: value }] : [];
  }) };
}

/** Copy one verified retained Main page into Content's atomic delivery cursor. */
export async function deliverRetainedContentEligibilityOnce(env: WorkActivationEnvironment,
  content: ContentCore, relayPool: Pool, consumer: string, throughSequence?: string): Promise<{
    graphDataEpoch: string; contentDataEpoch: string; sequence: string; batchCount: number;
  } | null> {
  const progress = await content.readEligibilityDeliveryProgress(MAIN_RELAY_STREAM_SCOPE, env.lineage.dataEpoch);
  if (throughSequence !== undefined) {
    if (!DECIMAL.test(throughSequence) || BigInt(progress.sequence) > BigInt(throughSequence)) {
      throw new ContentEligibilityStateUnavailable('Content delivery cursor exceeds frozen Main frontier');
    }
    if (progress.sequence === throughSequence) return null;
  }
  const retained = await verifiedRetainedRelayRange(relayPool, consumer, progress.sequence, 100);
  if (retained.coverage.streamScope !== MAIN_RELAY_STREAM_SCOPE
    || retained.coverage.consumer !== consumer || retained.coverage.dataEpoch !== env.lineage.dataEpoch
    || BigInt(retained.coverage.sequence) < BigInt(progress.sequence)) {
    throw new ContentEligibilityStateUnavailable('retained Main coverage differs from Content delivery cursor');
  }
  if (!retained.batches.length) return null;

  const owner = await content.ownerPosition();
  if (owner.dataEpoch !== progress.contentDataEpoch) {
    throw new ContentEligibilityStateUnavailable('Content owner epoch changed during Main delivery');
  }
  const batches: EligibilityDeliveryBatch[] = [];
  let selectedEvents = 0;
  for (const batch of retained.batches) {
    if (throughSequence !== undefined && BigInt(batch.sequence) > BigInt(throughSequence)) break;
    const checked = checkedBatch(batch, env.lineage.dataEpoch);
    if (selectedEvents + checked.eligible.length > 100) break;
    const events: EligibilityDeliverySourceEvent[] = [];
    for (const candidate of checked.eligible) {
      const proof = await readRetainedContentEligibilitySource(env,
        { dataEpoch: owner.dataEpoch, sequence: owner.sequence }, {
          eligibilityDecision: String(candidate.event.receipt.eligibilityDecision),
          publicationDecision: String(candidate.event.receipt.publicationDecision),
          variant: String(candidate.event.receipt.variant), resource: String(candidate.event.receipt.resource),
          receiptId: String(candidate.event.receipt.id), requestDigest: String(candidate.event.receipt.requestDigest),
          graphDataEpoch: candidate.event.sourcePosition.dataEpoch,
          graphSequence: candidate.event.sourcePosition.sequence,
        });
      events.push({ ...candidate.event, publication: {
        preparationId: proof.publication.preparationId, revisionId: proof.revisionId } });
      selectedEvents++;
    }
    batches.push({ ...checked.header, events });
  }
  if (!batches.length) {
    throw new ContentEligibilityStateUnavailable('first retained Main batch exceeds Content delivery event bound');
  }

  const page: EligibilityDeliveryPage = { expected: progress, batches };
  const delivered = await content.ingestEligibilityDeliveryPage(page);
  return { graphDataEpoch: delivered.progress.graphDataEpoch,
    contentDataEpoch: delivered.progress.contentDataEpoch,
    sequence: delivered.progress.sequence, batchCount: batches.length };
}
