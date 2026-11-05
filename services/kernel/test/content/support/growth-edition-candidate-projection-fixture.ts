import { DBOS } from '@dbos-inc/dbos-sdk';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import { threadTarget } from '../../../src/content/commands.ts';
import { effectWorkflowId } from '../../../src/events/effects.ts';
import type { Envelope } from '../../../src/events/log.ts';
import { testRouteKey } from '../../support/test-kernel.ts';
import { mediaRealmDownloadFixture } from '../media-realm-download-fixture.ts';
import { composeNativeCollectionRuntime, createMediaObjectStore } from '../media-native-collection-fixture.ts';

export const EDITION_CREATED = 'com.rezics.content.edition.created.v1';
export const CREATOR_INDEXED = 'com.rezics.content.edition.creator-indexed.v1';
export const CREATOR_EFFECT = 'content_creator_edition';
export const MAX_EDITION_ENVELOPE_SLOTS = 1000;

export type EditionSourceSlot = Readonly<{
  editionId: string;
  creatorAccountId: string;
  sourceRoute: number;
  sourcePartition: number;
  epoch: number;
  position: bigint;
  eventSeq: number;
  eventCount: number;
  eventId: string;
  eventType: string;
  subject: string;
  data: unknown;
  transactionId: string;
  principalKind: string;
  principalId: string;
  clientId: string | null;
  threadId: string;
  postId: string;
  revisionId: string;
  bodySha256: string;
}>;

export type NativeEffectSource = Readonly<{
  sourcePartition: number;
  epoch: number;
  position: bigint;
  eventSeq: number;
}>;

export async function growthEditionCandidateProjectionFixture() {
  const native = await mediaRealmDownloadFixture();
  const store = createMediaObjectStore();
  let runtime: Awaited<ReturnType<typeof composeNativeCollectionRuntime>> | undefined;
  try {
    const creator = native.outsider;
    const creatorRoute = routeOf(creator.accountId);
    if (creatorRoute === null) throw new Error('Native creator has no route');
    await native.grant(creator.accountId, native.publicRealm.realmId, ['realm:read', 'realm:participate']);
    await native.grant(creator.accountId, native.publicRealm.boardId, ['board:read', 'thread:create']);

    const scheme = (
      await native.checked('POST', '/v1/subjects', {
        type: 'skos:ConceptScheme',
        labels: { en: 'Growth edition candidate scheme' },
      })
    ).subject as { id: string };
    const concept = (
      await native.checked('POST', '/v1/subjects', {
        type: 'skos:Concept',
        labels: { en: 'Growth edition candidate source' },
        statements: {
          'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
        },
      })
    ).subject as { id: string };

    const routeKey = testRouteKey();
    const boardRoute = routeOf(native.publicRealm.boardId);
    if (boardRoute === null) throw new Error('Native source board has no route');
    let threadRequestId = randomUUID();
    let target = threadTarget(routeKey, creator.accountId, threadRequestId);
    for (let attempt = 0; attempt < 100 && (target.route === creatorRoute || target.route === boardRoute); attempt++) {
      threadRequestId = randomUUID();
      target = threadTarget(routeKey, creator.accountId, threadRequestId);
    }
    if (target.route === creatorRoute || target.route === boardRoute)
      throw new Error('Could not separate the source, board, and creator homes');
    const body = fromPlainText('A fixed authored edition body for projection growth.');
    const created = (
      await native.checked(
        'POST',
        '/v1/threads',
        {
          title: 'Growth edition source',
          body,
          licence: 'CC0-1.0',
          subjectIds: [concept.id],
          boardId: native.publicRealm.boardId,
          visibility: 'published',
        },
        201,
        { bearer: creator.bearer, key: threadRequestId },
      )
    ).thread as {
      id: string;
      firstPost: { id: string; revisionId: string; sha256: string };
    };
    const sourceRoute = routeOf(created.id);
    if (sourceRoute === null || sourceRoute !== target.route)
      throw new Error('Native source thread did not use its selected source home');
    const sourcePartition = partitionOf(sourceRoute);
    const creatorPartition = partitionOf(creatorRoute);
    if (sourcePartition === creatorPartition) throw new Error('Native source and creator share one partition');

    if (DBOS.isInitialized()) await DBOS.shutdown({ deregister: true });
    runtime = await composeNativeCollectionRuntime({
      databaseUrl: native.db.url,
      routeKey,
      partitions: [sourcePartition, creatorPartition],
      store,
      clock: () => new Date('2030-01-01T00:00:00.000Z'),
      pool: native.mutationPool,
    });

    async function sourceSlot(editionId: string): Promise<EditionSourceSlot> {
      const result = await native.db.admin.query<{
        route: number;
        creator_account_id: string;
        partition_no: number;
        epoch: number;
        position: string;
        event_seq: number;
        event_count: number;
        event_id: string;
        event_type: string;
        subject: string;
        data: unknown;
        transaction_id: string;
        principal_kind: string;
        principal_id: string;
        client_id: string | null;
        thread_id: string;
        post_id: string;
        revision_id: string;
        body_sha256: string;
      }>(
        `SELECT e.route,e.creator_account_id,w.partition_no,w.epoch,w.position::text,
                o.event_seq,o.event_count,o.id AS event_id,o.type AS event_type,o.subject,o.data,
                w.transaction_id,w.principal_kind,w.principal_id,w.client_id,
                e.thread_id,e.post_id,e.revision_id,encode(e.body_sha256,'hex') AS body_sha256
           FROM content.edition e
           JOIN editorial.write_basis w
             ON w.partition_no=$1 AND w.transaction_id=e.recorded_transaction_id
           JOIN core.outbox o
             ON o.partition_no=w.partition_no AND o.epoch=w.epoch AND o.position=w.position
            AND o.type=$4 AND o.subject=e.edition_id::text
          WHERE e.route=$2 AND e.edition_id=$3`,
        [sourcePartition, sourceRoute, editionId, EDITION_CREATED],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Native edition ${editionId} has no exact committed source slot`);
      if (
        row.partition_no !== sourcePartition ||
        row.principal_kind !== 'account' ||
        row.principal_id !== creator.accountId
      )
        throw new Error(`Native edition ${editionId} has an unexpected original account write basis`);
      if (
        row.thread_id !== created.id ||
        row.post_id !== created.firstPost.id ||
        row.revision_id !== created.firstPost.revisionId
      )
        throw new Error(`Native edition ${editionId} moved from its fixed source ancestry`);
      if (row.body_sha256 !== created.firstPost.sha256)
        throw new Error(`Native edition ${editionId} changed its fixed source body`);
      if (row.event_count < 1 || row.event_count > MAX_EDITION_ENVELOPE_SLOTS)
        throw new Error(`Native edition ${editionId} exceeded the bounded source envelope`);
      return {
        editionId,
        creatorAccountId: row.creator_account_id,
        sourceRoute: row.route,
        sourcePartition: row.partition_no,
        epoch: row.epoch,
        position: BigInt(row.position),
        eventSeq: row.event_seq,
        eventCount: row.event_count,
        eventId: row.event_id,
        eventType: row.event_type,
        subject: row.subject,
        data: row.data,
        transactionId: row.transaction_id,
        principalKind: row.principal_kind,
        principalId: row.principal_id,
        clientId: row.client_id,
        threadId: row.thread_id,
        postId: row.post_id,
        revisionId: row.revision_id,
        bodySha256: row.body_sha256,
      };
    }

    async function createEdition(key = randomUUID()): Promise<EditionSourceSlot> {
      const value = await native.checked(
        'POST',
        '/v1/contentEditions',
        {
          postId: created.firstPost.id,
          revisionId: created.firstPost.revisionId,
          targetSubjectId: concept.id,
        },
        201,
        { bearer: creator.bearer, key },
      );
      const editionId = (value as { editionId?: unknown }).editionId;
      if (typeof editionId !== 'string') throw new Error('Native edition command omitted its edition identity');
      const slot = await sourceSlot(editionId);
      if (
        slot.eventType !== EDITION_CREATED ||
        slot.subject !== editionId ||
        slot.data === null ||
        typeof slot.data !== 'object' ||
        (slot.data as Record<string, unknown>).editionId !== editionId ||
        (slot.data as Record<string, unknown>).editionRevision !== '1'
      )
        throw new Error(`Native edition ${editionId} source event does not match its immutable edition`);
      return slot;
    }

    async function candidateCount(editionId: string): Promise<number> {
      const result = await native.db.admin.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM content.creator_edition WHERE route=$1 AND creator_account_id=$2 AND edition_id=$3',
        [creatorRoute, creator.accountId, editionId],
      );
      return Number(result.rows[0]!.count);
    }

    async function creatorIndexedEventCount(editionId: string): Promise<number> {
      const result = await native.db.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM core.outbox
          WHERE partition_no=$1 AND type=$2 AND subject=$3`,
        [creatorPartition, CREATOR_INDEXED, editionId],
      );
      return Number(result.rows[0]!.count);
    }

    async function waitForRegisteredEffect(slot: NativeEffectSource, name: string): Promise<void> {
      const envelope: Envelope = {
        partition: slot.sourcePartition,
        epoch: slot.epoch,
        position: slot.position,
        events: [],
      };
      const id = effectWorkflowId(envelope, slot.eventSeq, name);
      await runtime!.client.retrieveWorkflow(id).getResult();
      const workflow = await runtime!.client.getWorkflow(id);
      if (workflow?.status !== 'SUCCESS') throw new Error(`Registered ${name} workflow did not succeed`);
    }

    async function waitForEffect(slot: EditionSourceSlot): Promise<void> {
      await waitForRegisteredEffect(slot, CREATOR_EFFECT);
    }

    async function threadCreationEvent(): Promise<NativeEffectSource> {
      const result = await native.db.admin.query<{
        partition_no: number;
        epoch: number;
        position: string;
        event_seq: number;
      }>(
        `SELECT partition_no,epoch,position::text,event_seq FROM core.outbox
          WHERE partition_no=$1 AND type='com.rezics.content.thread.created.v1' AND subject=$2
          ORDER BY position DESC,event_seq DESC LIMIT 1`,
        [sourcePartition, created.id],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Native source thread has no committed thread-created event');
      return {
        sourcePartition: row.partition_no,
        epoch: row.epoch,
        position: BigInt(row.position),
        eventSeq: row.event_seq,
      };
    }

    async function relayEdition(slot: EditionSourceSlot): Promise<void> {
      await runtime!.relayThrough(slot.sourcePartition, slot.position);
      await waitForEffect(slot);
    }

    async function relayCurrent(partition: number): Promise<void> {
      const result = await native.db.admin.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no=$1',
        [partition],
      );
      const position = result.rows[0]?.position;
      if (position === undefined) throw new Error(`Native partition ${partition} is absent`);
      await runtime!.relayThrough(partition, BigInt(position));
    }

    let closing: Promise<void> | undefined;
    return {
      native,
      runtime,
      creator,
      creatorRoute,
      creatorPartition,
      source: {
        route: sourceRoute,
        partition: sourcePartition,
        threadId: created.id,
        postId: created.firstPost.id,
        revisionId: created.firstPost.revisionId,
        sha256: created.firstPost.sha256,
        targetSubjectId: concept.id,
        body,
      },
      createEdition,
      sourceSlot,
      candidateCount,
      creatorIndexedEventCount,
      waitForEffect,
      waitForRegisteredEffect,
      threadCreationEvent,
      relayEdition,
      relayCurrent,
      close() {
        return (closing ??= (async () => {
          try {
            await runtime!.close();
          } finally {
            try {
              await native.close();
            } finally {
              store.close();
            }
          }
        })());
      },
    };
  } catch (error) {
    try {
      await runtime?.close();
    } finally {
      try {
        await native.close();
      } finally {
        store.close();
      }
    }
    throw error;
  }
}

export type GrowthEditionCandidateProjectionFixture = Awaited<
  ReturnType<typeof growthEditionCandidateProjectionFixture>
>;
