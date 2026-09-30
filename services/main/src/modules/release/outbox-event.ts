import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { readReleaseReceipt } from './command.ts';
import { readMetadataReceipt } from '../work/metadata-command.ts';
import { checkedEditionV2 } from '../work/metadata-schema.ts';
import { parseStoredRelease, releaseDigest, RELEASE_PROFILE, RELEASE_V2_PROFILE, RELEASE_V3_PROFILE, RELEASE_V2_COST } from './schema.ts';

export const outboxEventHandlers = [{
  kind: `${RV}WorkMetadataRevisedEvent`,
  action: 'work.edit',
  type: 'com.rezics.work.metadata-revised.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const admissionId = value('admissionId');
    if (!admissionId) throw new Error('Edition event has no admission');
    const receipt = await readMetadataReceipt({ fuseki }, admissionId);
    if (!receipt || receipt.outcome !== 'succeeded' || value('receipt') !== receipt.receipt
      || value('digest') !== receipt.requestDigest) throw new Error('Edition event differs from its receipt');
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?state WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.revision!)} rv:metadataState ?state ;
        rv:modelRevision <https://rezics.com/definition/work-metadata-details-v2> }
    } LIMIT 2`, 65536)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.state) throw new Error('Edition event revision is incomplete');
    const state = checkedEditionV2(JSON.parse(rows[0].state.value));
    if (state.id !== receipt.component) throw new Error('Edition event payload differs');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.work.metadata-revised.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt.receipt, action: 'work.edit', outcome: 'succeeded', admissionId,
          requestDigest: receipt.requestDigest, authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          work: receipt.work, component: receipt.component, revision: receipt.revision,
          contentLanguages: state.contentLanguages } } };
  },
}, {
  kind: `${RV}ReleaseChangedEvent`,
  action: 'work.edit',
  type: 'com.rezics.release.changed.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const admissionId = value('admissionId');
    const receiptId = value('receipt');
    if (!admissionId || !receiptId) throw new Error('Release event has no admission');
    const receipt = await readReleaseReceipt({ fuseki }, admissionId);
    const snapshot = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?snapshot WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receiptId)} rv:webSnapshot ?snapshot } } LIMIT 2`, 2048)).results?.bindings ?? [];
    const releaseReceipt = receipt && receipt.outcome === 'succeeded' ? receipt : null;
    if (!releaseReceipt && snapshot.length !== 1) throw new Error('Release event receipt is incomplete');
    if (releaseReceipt && (receiptId !== releaseReceipt.receipt || value('digest') !== releaseReceipt.requestDigest
      || value('scope') !== releaseReceipt.scope || value('authorityEpoch') !== releaseReceipt.authorityEpoch)) {
      throw new Error('Release event differs from its terminal receipt');
    }
    let coverage: { profile: 'release-v2'; works: string[];
      coverage: { realization: string; revision: string; completeness: string; portion?: string }[] } | undefined;
    if (releaseReceipt) {
      const states = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?state WHERE {
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(releaseReceipt.revision!)} a rv:ReleaseRevision ;
          rv:component ${iri(releaseReceipt.release!)} ; rv:releaseState ?state ; rv:modelRevision ?profile .
          VALUES ?profile { ${iri(RELEASE_PROFILE)} ${iri(RELEASE_V2_PROFILE)} ${iri(RELEASE_V3_PROFILE)} } }
      } LIMIT 2`, RELEASE_V2_COST.stateBytes * 2)).results?.bindings ?? [];
      if (states.length !== 1 || !states[0]?.state) throw new Error('Release event revision is incomplete');
      const record = parseStoredRelease(states[0].state.value, releaseReceipt.work!);
      if (record.id !== releaseReceipt.release || releaseDigest(record) !== releaseReceipt.requestDigest) {
        throw new Error('Release event state differs from its receipt');
      }
      if (record.profile !== 'release-v1') coverage = { profile: 'release-v2',
        works: [...new Set(record.resolvedCoverage.map(entry => entry.work))], coverage: record.coverage };
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.release.changed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receiptId, action: 'work.edit', outcome: 'succeeded', admissionId,
          requestDigest: value('digest')!, authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          ...(releaseReceipt ? { work: releaseReceipt.work, release: releaseReceipt.release,
            revision: releaseReceipt.revision } : {}),
          ...coverage,
          ...(snapshot[0]?.snapshot ? { snapshot: snapshot[0].snapshot.value } : {}) } } };
  },
}] satisfies OwnerOutboxEventHandler[];
