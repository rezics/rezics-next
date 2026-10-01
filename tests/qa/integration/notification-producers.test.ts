import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { notificationProducerSubjectReader } from '../../../services/main/src/modules/notification-producers/subjects.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { cloneQaOwnerDatabases, FakeDeliveryProvider } from '../support/fake-delivery.ts';

const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('G-297: Access and relay producers replay once per recipient, respect preferences and hide revoked targets', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) throw new Error('Use the QA integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'relay']);
  const access = new Pool({ connectionString: databases.urls.access, max: 8 });
  const relay = new Pool({ connectionString: databases.urls.relay, max: 2 });
  try {
    const actorId = randomUUID();
    const recipientId = randomUUID();
    const mutedId = randomUUID();
    const actor = agent();
    const member = agent();
    const realm = agent();
    await access.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES
      ($1,'test','actor'),($2,'test','recipient'),($3,'test','muted')`, [actorId, recipientId, mutedId]);
    await access.query(`INSERT INTO access.authority_subject (id,kind) VALUES
      ($1,'agent'),($2,'agent')`, [actor, member]);
    for (const principal of [actorId, recipientId, mutedId]) {
      await access.query(`INSERT INTO access.representation
        (id,principal_id,subject_id,action,valid_until) VALUES
        ($1,$2,$3,'submission.submit',clock_timestamp()+interval '1 day')`,
      [randomUUID(), principal, member]);
    }
    await access.query(`INSERT INTO access.notification_preference
      (principal_id,purpose,topic,channel,state,revision)
      VALUES ($1,'governance','realm-role-change','inbox','disabled',1)`, [mutedId]);
    await access.query(`INSERT INTO access.notification_preference
      (principal_id,purpose,topic,channel,state,revision)
      VALUES ($1,'social','reply','inbox','disabled',1)`, [mutedId]);
    await access.query(`INSERT INTO access.notification_preference
      (principal_id,purpose,topic,channel,state,revision)
      VALUES ($1,'governance','submission-decision','inbox','disabled',1)`, [mutedId]);
    await access.query(`INSERT INTO access.notification_preference
      (principal_id,purpose,topic,channel,state,revision)
      VALUES ($1,'governance','realm-membership-change','inbox','disabled',1)`, [mutedId]);
    const receipt = randomUUID();
    await access.query(`INSERT INTO access.realm_admin_receipt
      (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
      VALUES ($1,$2,$3,$4,$5,$6,'realm.roles.manage','Role changed',$7)`,
    [receipt, realm, actorId, actor, `role-${receipt}`, 'a'.repeat(64),
      { impact: { changes: [{ member, gained: ['realm.roles.manage'], lost: [] }] } }]);

    const store = new NotificationStore(access);
    let failOnce = true;
    const sink = { enqueue: async (event: Parameters<NotificationStore['enqueue']>[0]) => {
      if (failOnce) { failOnce = false; throw new Error('simulated Access write failure'); }
      return store.enqueue(event);
    } };
    const fakeContent = { query: async () => ({ rows: [{ author: member }] }) } as unknown as Pool;
    const syntaxGraph = new FusekiClient(Bun.env.FUSEKI_URL);
    const fakeGraph = { query: async (sparql: string, budget: number) => {
      await syntaxGraph.query(sparql, budget);
      return { results: { bindings: [{ author: { type: 'uri', value: member } }] } };
    } } as unknown as FusekiClient;
    const sourceAccess = { connect: () => access.connect(),
      query: (statement: string, params: unknown[]) => statement.includes('FROM access.admission WHERE id = $1')
        ? Promise.resolve({ rows: [{ principal_id: actorId }] }) : access.query(statement, params) } as unknown as Pool;
    const producer = new NotificationProducer(sourceAccess, relay, fakeContent, fakeGraph, sink, 'test-relay');
    await expect(producer.runAccessOnce()).rejects.toThrow('simulated Access write failure');
    expect((await access.query<{ position: string }>(`SELECT position::text
      FROM access.notification_producer_cursor WHERE consumer = 'notification-producer-v1'`)).rows[0]?.position).toBeUndefined();
    expect(await producer.runAccessOnce()).toBe(1);
    const items = await access.query<{ principal_id: string; source_event: string }>(`
      SELECT principal_id, source_event FROM access.notification_item ORDER BY principal_id`);
    expect(items.rows).toEqual([{ principal_id: recipientId, source_event: `realm:${receipt}` }]);
    await access.query(`UPDATE access.notification_producer_cursor SET position = 0
      WHERE consumer = 'notification-producer-v1'`);
    expect(await producer.runAccessOnce()).toBe(1);
    expect((await access.query(`SELECT 1 FROM access.notification_item`)).rowCount).toBe(1);

    const roleId = randomUUID();
    await access.query(`INSERT INTO access.realm_admin_revision (realm) VALUES ($1)`, [realm]);
    await access.query(`INSERT INTO access.realm_admin_role (realm,id,name,permissions)
      VALUES ($1,$2,'Editor',ARRAY[]::text[])`, [realm, roleId]);
    await access.query(`INSERT INTO access.realm_admin_assignment (realm,role_id,member,valid_until)
      VALUES ($1,$2,$3,clock_timestamp()+interval '1 day')`, [realm, roleId, member]);
    const renamed = randomUUID();
    const client = await access.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE access.realm_admin_role SET name = 'Copy editor'
        WHERE realm = $1 AND id = $2`, [realm, roleId]);
      await client.query(`INSERT INTO access.realm_admin_receipt
        (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
        VALUES ($1,$2,$3,$4,$5,$6,'realm.roles.manage','Role renamed',$7)`,
      [renamed, realm, actorId, actor, `role-${renamed}`, 'b'.repeat(64),
        { impact: { changes: [] } }]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    expect((await access.query<{ member: string }>(`SELECT member FROM access.notification_realm_effect
      WHERE receipt_id = $1`, [renamed])).rows).toEqual([{ member }]);
    expect(await producer.runAccessOnce()).toBe(1);
    expect((await access.query(`SELECT 1 FROM access.notification_item WHERE source_event = $1`,
      [`realm:${renamed}`])).rowCount).toBe(1);

    const reader = notificationProducerSubjectReader(access, fakeContent,
      { fuseki: fakeGraph } as WorkActivationEnvironment);
    expect((await reader.resolve({ principalId: recipientId, owner: 'access', ref: receipt,
      revision: null, disclosureBasis: 'realm-role-change-v1', realm })).status).toBe('available');
    expect((await reader.resolve({ principalId: recipientId, owner: 'access', ref: renamed,
      revision: null, disclosureBasis: 'realm-role-change-v1', realm })).status).toBe('available');
    const membership = randomUUID();
    await access.query(`INSERT INTO access.realm_admin_receipt
      (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
      VALUES ($1,$2,$3,$4,$5,$6,'realm.members.manage','Member changed',$7)`,
    [membership, realm, actorId, actor, `member-${membership}`, '4'.repeat(64), { member }]);
    expect(await producer.runAccessOnce()).toBe(1);
    expect((await access.query(`SELECT 1 FROM access.notification_item WHERE source_event = $1`,
      [`realm:${membership}`])).rowCount).toBe(1);
    const bounded = randomUUID();
    await access.query(`INSERT INTO access.realm_admin_receipt
      (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
      VALUES ($1,$2,$3,$4,$5,$6,'realm.members.manage','Member changed',$7)`,
    [bounded, realm, actorId, actor, `member-${bounded}`, '5'.repeat(64), { member }]);
    const beforeBound = (await access.query<{ position: string }>(`SELECT position::text FROM
      access.notification_producer_cursor WHERE consumer = 'notification-producer-v1'`)).rows[0]!.position;
    const tooMany = { connect: () => access.connect(), query: (statement: string, params: unknown[]) =>
      statement.includes('SELECT DISTINCT p.id FROM access.representation r')
        ? Promise.resolve({ rows: Array.from({ length: 257 }, () => ({ id: randomUUID() })) })
        : access.query(statement, params) } as unknown as Pool;
    await expect(new NotificationProducer(tooMany, null, fakeContent, fakeGraph, sink, null)
      .runAccessOnce()).rejects.toThrow('notification recipient bound exceeded');
    expect((await access.query<{ position: string }>(`SELECT position::text FROM
      access.notification_producer_cursor WHERE consumer = 'notification-producer-v1'`)).rows[0]?.position).toBe(beforeBound);
    expect(await producer.runAccessOnce()).toBe(1);

    // A retained, validated graph envelope is consumed only after its batch checkpoint.
    await relay.query(`INSERT INTO relay.checkpoint (consumer,data_epoch,sequence)
      VALUES ('test-relay','epoch-1',1)`);
    await relay.query(`INSERT INTO relay.delivered_batch
      (data_epoch,sequence,batch_id,routing_epoch,event_count)
      VALUES ('epoch-1',1,'batch-1','route-1',1)`);
    const reply = agent();
    const parent = agent();
    const graphEvent = `urn:rezics:event:${randomUUID()}`;
    await relay.query(`INSERT INTO relay.delivered_event
      (source,event_id,data_epoch,sequence,envelope) VALUES ($1,$2,'epoch-1',1,$3)`,
    ['https://rezics.com/services/main', graphEvent, { id: graphEvent,
      type: 'com.rezics.realm.reply-placed.v1', data: { ordinal: 0, receipt: {
        realm, reply, rootTarget: agent(), rootRevision: agent(), author: actor,
        parentReply: parent, contentRevision: `urn:rezics:content:revision:${randomUUID()}`,
        admissionId: randomUUID() } } }]);
    expect(await producer.runRelayOnce()).toBe(1);
    expect((await access.query<{ principal_id: string }>(`SELECT principal_id FROM access.notification_item
      WHERE source_event = $1`, [graphEvent])).rows).toEqual([{ principal_id: recipientId }]);
    await relay.query(`UPDATE relay.notification_producer_cursor SET sequence = 0
      WHERE consumer = 'notification-producer-v1'`);
    expect(await producer.runRelayOnce()).toBe(1);
    expect((await access.query(`SELECT 1 FROM access.notification_item WHERE source_event = $1`,
      [graphEvent])).rowCount).toBe(1);
    await relay.query(`UPDATE relay.checkpoint SET data_epoch = 'epoch-2', sequence = 0
      WHERE consumer = 'test-relay'`);
    expect(await producer.runRelayOnce()).toBe(0);
    expect((await relay.query<{ data_epoch: string; sequence: string }>(`
      SELECT data_epoch, sequence::text FROM relay.notification_producer_cursor
      WHERE consumer = 'notification-producer-v1'`)).rows[0]).toEqual({ data_epoch: 'epoch-2', sequence: '0' });
    const replyRevision = randomUUID();
    const root = agent();
    const rootRevision = agent();
    const placementId = agent();
    const reviewId = randomUUID();
    const preparationId = randomUUID();
    const realmSpace = agent();
    let publicRoot = true;
    let privateRealm = false;
    let reviewApproved = true;
    const readerGraph = { query: async (sparql: string, budget: number) => {
      await syntaxGraph.query(sparql, budget);
      if (sparql.includes(' ASK ')) return { boolean: publicRoot };
      if (sparql.includes('SELECT ?epoch ?sequence WHERE'))
          return {
            results: {
              bindings: [
                {
                  epoch: { value: 'test' },
                  sequence: { value: '0' },
                },
              ],
            },
          };
        if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r ?type'))
          return {
            results: {
              bindings: [
                {
                  epoch: { value: 'test' },
                  sequence: { value: '0' },
                  r: { value: root },
                  type: { value: 'work' },
                  work: { value: root },
                  head: { value: rootRevision },
                  public: { value: String(publicRoot) },
                  label: { value: 'Reply root', 'xml:lang': 'en' },
                },
              ],
            },
          };
        if (sparql.includes('SELECT ?epoch ?sequence ?r ?revision ?type'))
          return {
            results: {
              bindings: [
                {
                  epoch: { value: 'test' },
                  sequence: { value: '0' },
                  r: { value: root },
                  revision: { value: rootRevision },
                  type: { value: 'https://schema.org/CreativeWork' },
                },
              ],
            },
          };
        if (sparql.includes('SELECT ?root WHERE'))
          return { results: { bindings: publicRoot ? [{ root: { value: rootRevision } }] : [] } };
        if (sparql.includes('SELECT ?space ?realmRevision')) return { results: { bindings: [{
        space: { value: realmSpace }, disclosure: { value: `https://rezics.com/vocab/${privateRealm ? 'Private' : 'Public'}` },
        ...(privateRealm ? { visibility: { value: 'private' } } : {}),
      }] } };
      return { results: { bindings: [{ placement: { value: placementId },
        revision: { value: `urn:rezics:content:revision:${replyRevision}` },
        review: { value: `urn:rezics:realm-review:${reviewId}` },
        root: { value: root },
                rootRevision: { value: rootRevision }, author: { value: actor }, preparation: { value: preparationId } }] } };
    } } as unknown as FusekiClient;
    const readerContent = { query: async (sql: string) => ({ rowCount: sql.includes('SELECT 1 FROM content.reply p')
      ? Number(reviewApproved) : 1, rows: sql.includes('SELECT origin_realm')
      ? [{ origin_realm: null }] : sql.includes('SELECT 1 FROM content.reply p') ? [{}]
        : [{ reply, author: actor, rootTarget: root, rootRevision,
          revisionId: replyRevision, body: 'A visible reply' }] }) } as unknown as Pool;
    const replyReader = notificationProducerSubjectReader(access, readerContent,
      { fuseki: readerGraph, lineage: { dataEpoch: 'test', routingEpoch: 'test' } } as WorkActivationEnvironment);
    const replyInput = { principalId: recipientId, owner: 'graph', ref: reply,
      revision: `urn:rezics:content:revision:${replyRevision}`,
      disclosureBasis: 'realm-reply-v1', realm };
    expect((await replyReader.resolve(replyInput)).status).toBe('available');
    publicRoot = false;
    expect((await replyReader.resolve(replyInput)).status).toBe('undisclosed');
    publicRoot = true;

    // The public root's author receives an item, but a private Realm must hide the discussion.
    store.registerReadSubjectReader('realm-reply-v1', replyReader);
    await store.registerEndpoint({ issuer: 'test', subject: 'recipient' }, { channel: 'email',
      deviceId: null, address: null, addressDigest: 'a'.repeat(64), lockScreenDisclosure: false });
    await store.registerEndpoint({ issuer: 'test', subject: 'recipient' }, { channel: 'push',
      deviceId: 'phone', address: 'push-fixture', addressDigest: 'b'.repeat(64), lockScreenDisclosure: false });
    const provider = new FakeDeliveryProvider();
    const dispatcher = new NotificationDispatcher(access, provider, { resolve: async () => ({ status: 'undisclosed' }) });
    dispatcher.registerSubjectReader('realm-reply-v1', replyReader);
    const replyEvent = (sourceEvent: string) => ({ sourceOwner: 'graph' as const, sourceEvent,
      purpose: 'social' as const, topic: 'reply', subject: { owner: 'graph' as const, ref: reply,
        revision: replyInput.revision }, disclosureBasis: 'realm-reply-v1', recipients: [recipientId],
      display: { kind: 'reply' as const, actorAgent: actor, realm, groupKey: root } });
    const principal = { issuer: 'test', subject: 'recipient' };
    const publicItem = (await store.enqueue(replyEvent(`reply-public-${randomUUID()}`)))[0]!;
    expect((await store.readStream(principal, null)).items.find(item => item.id === publicItem.itemId)?.display?.target.excerpt)
      .toBe('A visible reply');
    expect((await store.unreadCount(principal)).count).toBe(1);
    expect((await dispatcher.runOnce()).delivered).toBe(2);
    expect([...provider.accepted.values()].every(value => value.payload.excerpt === 'A visible reply')).toBe(true);

    privateRealm = true;
    expect((await replyReader.resolve(replyInput)).status).toBe('undisclosed');
    expect((await store.readStream(principal, null)).items.find(item => item.id === publicItem.itemId)?.subject)
      .toBeNull();
    expect((await store.unreadCount(principal)).count).toBe(0);
    const outsideItem = (await store.enqueue(replyEvent(`reply-outside-${randomUUID()}`)))[0]!;
    const sentBefore = provider.calls.send;
    expect((await dispatcher.runOnce()).cancelled).toBe(2);
    expect(provider.calls.send).toBe(sentBefore);
    expect((await access.query<{ state: string }>(`SELECT state FROM access.notification_delivery
      WHERE item_id = $1`, [outsideItem.itemId])).rows.map(row => row.state)).toEqual(['cancelled', 'cancelled']);

    await access.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [realm]);
    await access.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('realm',$1,1,'terms-1')`, [realm]);
    await access.query(`INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'terms-1','notification-fixture')`,
    [randomUUID(), realm, member]);
    expect((await replyReader.resolve(replyInput)).status).toBe('available');
    const privateSubject = await replyReader.resolve(replyInput);
    expect(privateSubject.status).toBe('available');
    if (privateSubject.status !== 'available') throw new Error('member reply was not disclosed');
    expect(privateSubject.subject.private).toBe(true);
    const memberItem = (await store.enqueue(replyEvent(`reply-member-${randomUUID()}`)))[0]!;
    expect((await store.unreadCount(principal)).count).toBe(3);
    expect((await dispatcher.runOnce()).delivered).toBe(2);
    const memberDeliveries = (await access.query<{ id: string; channel: string }>(`
      SELECT id, channel FROM access.notification_delivery WHERE item_id = $1`, [memberItem.itemId])).rows;
    expect(provider.accepted.get(memberDeliveries.find(item => item.channel === 'email')!.id)?.payload.excerpt)
      .toBe('A visible reply');
    expect(provider.accepted.get(memberDeliveries.find(item => item.channel === 'push')!.id)?.payload)
      .toEqual({ notice: 'new-activity' });

    reviewApproved = false;
    expect((await replyReader.resolve(replyInput)).status).toBe('undisclosed');
    expect((await store.unreadCount(principal)).count).toBe(0);
    reviewApproved = true;
    await access.query(`UPDATE access.membership SET state = 'left', generation = generation + 1,
      terms_revision = NULL, consent_reference = NULL WHERE kind = 'realm' AND owner_subject = $1`, [realm]);
    expect((await replyReader.resolve(replyInput)).status).toBe('undisclosed');
    expect((await store.unreadCount(principal)).count).toBe(0);
    await access.query(`UPDATE access.membership SET state = 'joined', generation = generation + 1,
      terms_revision = 'terms-1', consent_reference = 'notification-rejoin'
      WHERE kind = 'realm' AND owner_subject = $1`, [realm]);
    expect((await replyReader.resolve(replyInput)).status).toBe('available');
    await access.query(`UPDATE access.representation SET active = false WHERE principal_id = $1`, [recipientId]);
    expect((await replyReader.resolve(replyInput)).status).toBe('undisclosed');
    expect((await store.unreadCount(principal)).count).toBe(0);
    await access.query(`UPDATE access.representation SET active = true WHERE principal_id = $1`, [recipientId]);

    const work = agent();
    const scope = `review:decide:${realm}`;
    await access.query(`INSERT INTO access.scope_gate (id) VALUES ($1)`, [scope]);
    const admissionId = randomUUID();
    await access.query(`INSERT INTO access.admission
      (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,
       authority_epoch,expires_at,state)
      VALUES ($1,$2,$3,$4,'review.decide',$5,$6,0,clock_timestamp()+interval '1 day','registered')`,
    [admissionId, actorId, actor, scope, `decision-${admissionId}`, 'c'.repeat(64)]);
    const submissionId = randomUUID();
    await access.query(`INSERT INTO access.realm_submission
      (id,realm,kind,work,main_version,contribution,publication_decision,selected_draft,
       submitting_agent,state,revision)
      VALUES ($1,$2,'contribution',$3,$4,$5,$6,$7,$8,'pending',$9)`,
    [submissionId, realm, work, agent(), agent(), agent(), agent(), member, randomUUID()]);
    const decisionRevision = randomUUID();
    await access.query(`UPDATE access.realm_submission SET state = 'rejected', revision = $2,
      generation = generation + 1, decision_operation = $3, reviewer = $4,
      public_reason = 'Needs revision' WHERE id = $1`,
    [submissionId, decisionRevision, admissionId, actor]);
    expect(await producer.runAccessOnce()).toBe(1);
    expect((await access.query<{ principal_id: string }>(`SELECT principal_id FROM access.notification_item
      WHERE source_event = $1`, [`submission:${decisionRevision}`])).rows).toEqual([{ principal_id: recipientId }]);
    expect((await reader.resolve({ principalId: recipientId, owner: 'access', ref: submissionId,
      revision: decisionRevision, disclosureBasis: 'submission-decision-v1', realm })).status).toBe('available');

    const caseId = randomUUID();
    const moderationId = randomUUID();
    const reportId = randomUUID();
    const authorityScope = `governance:realm:${realm}`;
    await access.query(`INSERT INTO access.scope_gate (id) VALUES ($1)`, [authorityScope]);
    await access.query(`INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,
       target_component,disclosure) VALUES
      ($1,'content_report','realm',$2,$3,'content',$4,'body','parties')`,
    [caseId, authorityScope, realm, work]);
    await access.query(`INSERT INTO access.governance_report
      (id,case_id,principal_id,acting_subject,principal_epoch,idempotency_key,
       request_digest,reason_code,evidence_count,evidence_digest)
      VALUES ($1,$2,$3,$4,0,$5,$6,'inaccurate',1,$7)`,
    [reportId, caseId, mutedId, member, `report-${reportId}`, 'd'.repeat(64), 'e'.repeat(64)]);
    await access.query(`INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,
       authority_kind,authority_scope_id,authority_epoch,authority_proof_digest,
       idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure)
      VALUES ($1,'content_moderation','restrict',$2,$3,1,$4,$5,'realm',$6,0,$7,$8,$9,$10,$11,$12,$13,'parties')`,
    [moderationId, realm, caseId, actorId, actor, authorityScope, 'f'.repeat(64),
      `moderation-${moderationId}`, '1'.repeat(64), 'rule', 'revision', '2'.repeat(64), '3'.repeat(64)]);
    await access.query(`UPDATE access.governance_case SET generation = 1, decision_head = $2 WHERE id = $1`,
      [caseId, moderationId]);
    expect(await producer.runAccessOnce()).toBe(1);
    expect((await access.query<{ principal_id: string }>(`SELECT principal_id FROM access.notification_item
      WHERE source_event = $1 ORDER BY principal_id`, [`moderation:${moderationId}`])).rows
      .map(row => row.principal_id).sort()).toEqual([recipientId, mutedId].sort());
    expect((await reader.resolve({ principalId: recipientId, owner: 'access', ref: moderationId,
      revision: null, disclosureBasis: 'moderation-outcome-v1', realm })).status).toBe('available');
    await access.query(`UPDATE access.representation SET active = false WHERE principal_id = $1`, [recipientId]);
    expect((await reader.resolve({ principalId: recipientId, owner: 'access', ref: receipt,
      revision: null, disclosureBasis: 'realm-role-change-v1', realm })).status).toBe('undisclosed');
  } finally {
    await Promise.all([access.end(), relay.end()]);
    await databases.close();
  }
}, 60_000);
