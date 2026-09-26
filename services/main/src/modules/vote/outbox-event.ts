import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import type { OwnerCloudEvent, OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { receiptFamilies } from './receipt-family.ts';

type Action = keyof typeof receiptFamilies;
type EventSpec = { kind: string; action: Action; type: string; revisionType?: string;
  componentType?: string; closed?: boolean; cancelled?: boolean };

const specs: readonly EventSpec[] = [
  { kind: 'PollPreparedEvent', action: 'governance.poll.administer',
    type: 'com.rezics.vote.poll-prepared.v1', revisionType: 'ElectorateSnapshot', componentType: 'Poll' },
  { kind: 'HolderCharterChangedEvent', action: 'governance.seat.manage',
    type: 'com.rezics.vote.holder-charter-changed.v1', revisionType: 'HolderCharterRevision',
    componentType: 'VotingCharter' },
  { kind: 'AllocationActivatedEvent', action: 'governance.seat.manage',
    type: 'com.rezics.vote.allocation-activated.v1', revisionType: 'AllocationActivation' },
  { kind: 'PollOpenedEvent', action: 'governance.poll.administer',
    type: 'com.rezics.vote.poll-opened.v1', revisionType: 'PollOpening', componentType: 'Poll' },
  { kind: 'PollClosedEvent', action: 'governance.poll.administer',
    type: 'com.rezics.vote.poll-closed.v1', componentType: 'Poll', closed: true },
  { kind: 'PollFinalizedEvent', action: 'governance.poll.administer',
    type: 'com.rezics.vote.poll-finalized.v1', revisionType: 'PollResolution', componentType: 'Poll' },
  { kind: 'BallotChangedEvent', action: 'governance.ballot.operate',
    type: 'com.rezics.vote.ballot-changed.v1', revisionType: 'BallotRevision', componentType: 'Ballot' },
  { kind: 'MandateApprovalRecordedEvent', action: 'governance.ballot.operate',
    type: 'com.rezics.vote.mandate-approval-recorded.v1', revisionType: 'MandateApproval' },
  { kind: 'VotePollCancelledEvent', action: 'governance.poll.administer',
    type: 'com.rezics.vote.poll-cancelled.v1', cancelled: true },
  { kind: 'VoteSeatCancelledEvent', action: 'governance.seat.manage',
    type: 'com.rezics.vote.seat-cancelled.v1', cancelled: true },
  { kind: 'VoteBallotCancelledEvent', action: 'governance.ballot.operate',
    type: 'com.rezics.vote.ballot-cancelled.v1', cancelled: true },
  { kind: 'VoteInvalidationCancelledEvent', action: 'governance.ballot.invalidate',
    type: 'com.rezics.vote.invalidation-cancelled.v1', cancelled: true },
];

function invalid(): never { throw new Error('vote outbox event differs from its terminal receipt or domain fact'); }

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = specs.map(spec => ({
  kind: `${RV}${spec.kind}`, action: spec.action, type: spec.type,
  async read({ fuseki, batch, eventId, value, ordinal }): Promise<OwnerCloudEvent> {
    const admissionId = value('admissionId'), receipt = value('receipt');
    const outcome = value('outcome');
    const reason = value('reason');
    if (!admissionId || !receipt || !value('digest') || !value('authorityEpoch') || !value('scope')
      || receipt !== `urn:rezics:receipt:${hash(`${admissionId}\0${receiptFamilies[spec.action]}`)}`
      || outcome !== `${RV}${spec.cancelled ? 'Cancelled' : 'Succeeded'}`) invalid();
    let component: string | undefined;
    let revision: string | undefined;
    let operation: string | undefined;
    if (spec.cancelled) {
      const suffix = hash(`${receipt}\0${reason === `${RV}StaleHead` ? 'stale-head'
        : reason === `${RV}VoteRejected` ? 'rejected' : 'cancel'}`);
      if (eventId !== `urn:rezics:event:${suffix}`
        || batch.batchId !== `urn:rezics:outbox:${suffix}` || value('operation')) invalid();
    } else {
      const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?component ?revision ?operation
        ?eventOperation ?eventComponent ?revisionType ?componentType ?closedAt WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:voteComponent ?component ;
          rv:voteRevision ?revision ; rv:operation ?operation . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} rv:operation ?eventOperation ;
          rv:voteComponent ?eventComponent . }
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision a ?revisionType } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?component a ?componentType } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?component rv:closedAt ?closedAt } }
      }`);
      const rows = result.results?.bindings ?? [];
      const first = rows[0];
      component = first?.component?.value;
      revision = first?.revision?.value;
      operation = first?.operation?.value;
      if (!component || !revision || !operation || !rows.length
        || rows.some(row => row.component?.value !== component || row.revision?.value !== revision
          || row.operation?.value !== operation || row.eventOperation?.value !== operation
          || row.eventComponent?.value !== component)
        || (spec.revisionType && !rows.some(row => row.revisionType?.value === `${RV}${spec.revisionType}`))
        || (spec.componentType && !rows.some(row => row.componentType?.value === `${RV}${spec.componentType}`))
        || (spec.closed && !rows.some(row => !!row.closedAt?.value))
        || value('operation') !== operation || value('eventOperation') !== operation
        || eventId !== `urn:rezics:event:${hash(operation)}`
        || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`) invalid();
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: spec.type, datacontenttype: 'application/json',
      data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
        dataEpoch: batch.dataEpoch, sequence: batch.sequence }, routingEpoch: batch.routingEpoch,
      ordinal, receipt: { id: receipt, action: spec.action,
        outcome: spec.cancelled ? 'cancelled' : 'succeeded', admissionId,
        requestDigest: value('digest')!, authorityEpoch: value('authorityEpoch')!,
        scope: value('scope')!, ...(operation ? { operation, component, revision } : {}),
        ...(reason ? { reason } : {}) } } };
  },
}));
