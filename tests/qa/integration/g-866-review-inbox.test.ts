import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import {
  NotificationStore,
  NOTIFICATION_TRIAGE_COST, NOTIFICATION_SUBSCRIPTION_COST,
  type StreamPage,
} from '../../../services/main/src/modules/notification/store.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { FakeDeliveryProvider } from '../support/fake-delivery.ts';
import { NotificationDigestWorker } from '../../../services/main/src/modules/notification/digest.ts';
import { editorialNotificationSubjectReader, EDITORIAL_NOTIFICATION_TOPICS } from '../../../services/main/src/modules/notification-producers/editorial.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';
import {
  metadataComponent,
  checkedMetadataState,
} from '../../../services/main/src/modules/work/metadata-schema.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { configureDisclosurePool, disclosurePoolReader } from '../../../services/main/src/modules/disclosure/read.ts';

test('G-866: review journey reaches recipients, triage is independent and revocation hides exact destinations', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `g-866-${randomUUID()}`),
    preparation = Date.now();
  const scopes =
    'openid work:create work:edit work:read work:correct work:review notification:manage';
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory, scopes);
  const reader = nativeId(),
    tokenB = await f.account.tokenFor(f.account.b, scopes);
  let statements = 0;
  const measured = {
    query: (...args: unknown[]) => { statements++; return (f.accessPool.query as (...a: unknown[]) => unknown).apply(f.accessPool,args); },
    connect: async () => {
      const client = await f.accessPool.connect();
      return { query: (...args: unknown[]) => { statements++; return (client.query as (...a: unknown[]) => unknown).apply(client,args); },
        release: () => client.release() };
    },
  } as unknown as Pool;
  const disclosure = disclosurePoolReader(f.accessPool);
  if (disclosure) configureDisclosurePool(measured,disclosure);
  const store = new NotificationStore(measured);
  const subjects = editorialNotificationSubjectReader(f.accessPool, f.env);
  let unavailableProposal: string | null = null;
  store.registerReadSubjectReader('editorial-proposal-v1', {
    resolve: async input => input.ref === unavailableProposal
      ? { status: 'unavailable' } : subjects.resolve(input),
  });
  const producer = new NotificationProducer(f.accessPool, null, f.pool, f.env.fuseki, store, null);
  const deps: MainWorkDependencies = {
    environment: f.env,
    access: f.access,
    account: f.account.verifier,
    editorialReview: new EditorialReviewStore(f.accessPool),
    notifications: { store },
  };
  f.access.configureBaseline(f.env.fuseki);
  const app = createMainApp(f.env.fuseki, deps);
  const request = (
    method: string,
    path: string,
    body?: object,
    token = f.account.tokenA,
    key = randomUUID(),
  ) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  async function json<T>(response: Response, status = 200): Promise<T> {
    const body: unknown = await response.json();
    expect({ status: response.status, ...(response.status !== status ? { body } : {}) }).toEqual({
      status,
    });
    return body as T;
  }
  const inbox = (token = f.account.tokenA, query = '') =>
    request('GET', `/v1/me/notifications${query}`, undefined, token).then((response) =>
      json<StreamPage>(response),
    );
  const triage = (item: string, input: object, token = f.account.tokenA) =>
    request(
      'PUT',
      `/v1/me/notifications/${item}/triage`,
      { profile: 'notification-item-triage-v1', ...input },
      token,
    );
  const subscription = (
    proposal: string,
    level: string,
    expectedRevision: string | null,
    token = f.account.tokenA,
  ) =>
    request(
      'PUT',
      `/v1/me/proposal-subscriptions/${proposal}`,
      { profile: 'proposal-subscription-v1', level, expectedRevision },
      token,
    );
  try {
    const definition = (await f.accessPool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'access.editorial_event'::regclass AND conname = 'editorial_event_kind_check'`)).rows[0]!.definition;
    expect([...definition.matchAll(/'([^']+)'/g)].map(match => match[1]).sort())
      .toEqual(Object.keys(EDITORIAL_NOTIFICATION_TOPICS).sort());
    await f.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
      reader,
    ]);
    for (const [agent, principal] of [
      [f.actor, f.principalId],
      [reader, f.otherPrincipal],
    ]) {
      await f.accessPool.query(
        `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'agent.control','infinity')`,
        [randomUUID(), principal, agent],
      );
    }
    await createAgentGraph(f.env, {
      id: randomUUID(),
      agent: f.actor,
      kind: 'person',
      displayName: 'Review author',
      digest: hash(f.actor),
    });
    const work = await json<{ work: string; workRevision: string }>(
      await request('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        authoring: 'own-work',
        title: 'Review inbox Work',
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.accessPool.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [
      work.work,
      reader,
    ]);
    const readGrant = randomUUID();
    for (const [action, id] of [
      ['work.read', readGrant],
      ['work.edit', randomUUID()],
    ]) {
      const scope = `${action!.replace('.', ':')}:${work.work}`;
      await f.accessPool.query(
        'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await f.accessPool.query(
        `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,'infinity')`,
        [randomUUID(), f.otherPrincipal, reader, action],
      );
      await f.accessPool.query(
        `INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$3,$4,$5,'infinity')`,
        [id, f.actor, reader, scope, action],
      );
    }
    const state = (description: string) =>
      checkedMetadataState({
        kind: 'header',
        originalTitle: { value: 'Reviewed inbox Work', language: 'en' },
        localized: [{ language: 'en', title: null, description, mainVersionLabel: null }],
      });
    const baseHeads = [{ component: metadataComponent(work.work, state('First')), head: null }];
    const proposal = await json<{ proposal: string }>(
      await request('POST', '/v1/editorial/proposals', {
        profile: 'editorial-proposal-create-v1',
        kind: 'component-correction',
        target: {
          resource: work.work,
          revision: work.workRevision,
          context: 'urn:rezics:context:global',
        },
        candidate: { command: 'work-metadata', state: state('First') },
        baseHeads,
        evidence: [],
        actingSubject: f.actor,
      }),
      201,
    );
    const path = `/v1/editorial/proposals/${proposal.proposal}`;
    expect(await producer.runEditorialOnce()).toBe(1);
    const requested = (await inbox(tokenB)).items[0]!;
    expect(requested.topic).toBe('review-requested');
    expect(requested.reason).toBe('steward');
    expect(requested.proposal).toEqual({ id: proposal.proposal, revision: 1 });
    expect(requested.subject?.revision).toBe('1');
    expect((await inbox()).items).toHaveLength(0);
    expect(
      await json(await request('GET', `/v1/me/proposal-subscriptions/${proposal.proposal}`)),
    ).toMatchObject({ subscription: { level: 'participating', reason: 'author', revision: '1' } });
    const emailKey = randomUUID();
    await json(
      await request(
        'PUT',
        '/v1/me/notification-preferences',
        {
          profile: 'notification-preference-v1',
          purpose: 'governance',
          topic: 'changes-requested',
          channel: 'email',
          state: 'enabled',
          expectedRevision: null,
          idempotencyKey: emailKey,
        },
        f.account.tokenA,
        emailKey,
      ),
    );
    await store.registerEndpoint(
      { issuer: f.account.issuer, subject: f.account.a.id },
      {
        channel: 'email',
        deviceId: null,
        address: null,
        addressDigest: 'a'.repeat(64),
        lockScreenDisclosure: false,
      },
    );
    await json(
      await request(
        'POST',
        `${path}/reviews`,
        {
          profile: 'editorial-proposal-review-v1',
          revision: 1,
          outcome: 'request_changes',
          message: 'Clarify the source',
          actingSubject: reader,
        },
        tokenB,
      ),
    );
    let loseAcknowledgement = true;
    const interrupted = new NotificationProducer(f.accessPool,null,f.pool,f.env.fuseki,{
      enqueue: async event => {
        const result = await store.enqueue(event);
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('lost intake acknowledgement'); }
        return result;
      },
    },null);
    await expect(interrupted.runEditorialOnce()).rejects.toThrow('lost intake acknowledgement');
    await producer.runEditorialOnce();
    const change = (await inbox()).items[0]!;
    expect((await inbox()).items).toHaveLength(1);
    expect(change.topic).toBe('changes-requested');
    expect(change.reason).toBe('author');
    expect(change.read).toBe(false);
    expect(
      (
        await f.accessPool.query(
          "SELECT 1 FROM access.notification_delivery WHERE item_id = $1 AND channel = 'email'",
          [change.id],
        )
      ).rowCount,
    ).toBe(0);
    await f.accessPool.query(
      `INSERT INTO access.notification_digest_day (principal_id,day)
      VALUES ($1,(clock_timestamp() AT TIME ZONE 'UTC')::date - 1)`,
      [f.principalId],
    );
    await f.accessPool.query(
      `UPDATE access.notification_digest_candidate SET day = (clock_timestamp() AT TIME ZONE 'UTC')::date - 1
      WHERE principal_id = $1`,
      [f.principalId],
    );
    const nativeFetch = globalThis.fetch,
      digests: unknown[] = [];
    try {
      globalThis.fetch = (async (input, init) =>
        String(input) === 'http://digest.local/intake'
          ? (digests.push(JSON.parse(String(init?.body))), new Response(null, { status: 204 }))
          : nativeFetch(input, init)) as typeof fetch;
      await new NotificationDigestWorker(
        f.accessPool,
        store,
        f.account.issuer,
        'http://digest.local/intake',
        'test',
      ).runOnce();
    } finally {
      globalThis.fetch = nativeFetch;
    }
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ counts: [{ topic: 'changes-requested', count: 1 }] });
    statements = 0;
    await json(await triage(change.id, { saved: true, expectedRevision: null }));
    expect(statements).toBe(NOTIFICATION_TRIAGE_COST.statements);
    expect((await inbox()).items[0]).toMatchObject({ saved: true, done: false, read: false });
    await json(await triage(change.id, { done: true, expectedRevision: '1' }));
    expect((await inbox()).items).toHaveLength(0);
    expect((await inbox(f.account.tokenA, '?view=saved&reason=author')).items[0]).toMatchObject({
      saved: true,
      done: true,
      read: false,
    });
    await json(await request('PUT', `/v1/me/notifications/${change.id}/read`));
    expect((await inbox(f.account.tokenA, '?view=done')).items[0]).toMatchObject({
      saved: true,
      done: true,
      read: true,
    });
    await json(await triage(change.id, { saved: false, expectedRevision: '2' }));
    await json(await triage(change.id, { done: false, expectedRevision: '3' }));
    await json(await triage(change.id, { done: true, expectedRevision: '1' }), 409);
    await json(await triage(change.id, { done: true, expectedRevision: '4' }, tokenB), 404);
    const competing = await Promise.all([
      triage(change.id, { done: true, expectedRevision: '4' }),
      triage(change.id, { saved: true, expectedRevision: '4' }),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([200, 409]);
    const current =
      (await inbox(f.account.tokenA, '?view=done')).items[0] ?? (await inbox()).items[0]!;
    if (!current.done)
      await json(await triage(change.id, { done: true, expectedRevision: current.triageRevision }));
    await json(await triage(requested.id, { done: true, expectedRevision: null }, tokenB));
    await json(
      await request('POST', `${path}/revisions`, {
        profile: 'editorial-proposal-revise-v1',
        revision: 1,
        candidate: { command: 'work-metadata', state: state('Revised') },
        baseHeads,
        evidence: [],
        actingSubject: f.actor,
      }),
    );
    await producer.runEditorialOnce();
    expect(
      (await inbox(tokenB)).items.some(
        (item) => item.topic === 'proposal-revised' && item.proposal?.revision === 2,
      ),
    ).toBe(true);
    expect((await inbox()).items.some(item => item.topic === 'proposal-revised')).toBe(false);
    // Done applies to an item: someone else's new revision still reaches the reviewer.
    expect((await inbox(tokenB)).items.some(item =>
      item.topic === 'proposal-revised' && !item.done)).toBe(true);
    expect((await inbox(tokenB, '?view=done')).items.some(item => item.id === requested.id)).toBe(true);
    expect((await inbox(tokenB)).items.some(item => item.topic === 'changes-requested')).toBe(false);
    const beforeReplay = (await inbox()).items.length;
    const reviewerBeforeReplay = (await inbox(tokenB)).items.map(item => item.id);
    await f.accessPool.query(
      `UPDATE access.notification_producer_cursor SET position = 0 WHERE consumer = 'editorial-notification-v1'`,
    );
    await producer.runEditorialOnce();
    expect((await inbox()).items).toHaveLength(beforeReplay);
    expect((await inbox(tokenB)).items.map(item => item.id)).toEqual(reviewerBeforeReplay);
    statements = 0;
    await json(await subscription(proposal.proposal, 'ignore', '1'));
    expect(statements).toBe(NOTIFICATION_SUBSCRIPTION_COST.setStatements);
    await json(
      await request('POST', `${path}/revisions`, {
        profile: 'editorial-proposal-revise-v1',
        revision: 2,
        candidate: { command: 'work-metadata', state: state('Muted revision') },
        baseHeads,
        evidence: [],
        actingSubject: f.actor,
      }),
    );
    await producer.runEditorialOnce();
    await json(await request('POST', `${path}/reviews`, {
      profile: 'editorial-proposal-review-v1', revision: 3, outcome: 'request_changes',
      message: 'Muted change request', actingSubject: reader,
    }, tokenB));
    await producer.runEditorialOnce();
    // Watch Ignore preserves direct involvement in the author's own proposal.
    expect((await inbox()).items).toHaveLength(beforeReplay + 1);
    await json(await subscription(proposal.proposal, 'participating', '2'));
    await json(await subscription(proposal.proposal, 'ignore', '1'), 409);
    await json(
      await request(
        'POST',
        `${path}/decisions`,
        {
          profile: 'editorial-proposal-decide-v1',
          revision: 3,
          outcome: 'applied',
          approve: true,
          message: 'Checked',
          actingSubject: reader,
        },
        tokenB,
      ),
    );
    await producer.runEditorialOnce();
    expect(
      (await inbox()).items.some(
        (item) => item.topic === 'proposal-decided' && item.proposal?.revision === 3,
      ),
    ).toBe(true);
    expect((await inbox(tokenB)).items.some(item => item.topic === 'proposal-decided')).toBe(false);
    const reversed = await json<{ proposal: string }>(
      await request('POST', `${path}/reversal`, {
        profile: 'editorial-proposal-revert-v1',
        evidence: [],
        actingSubject: f.actor,
      }),
      201,
    );
    await producer.runEditorialOnce();
    await json(
      await request(
        'POST',
        `/v1/editorial/proposals/${reversed.proposal}/decisions`,
        {
          profile: 'editorial-proposal-decide-v1',
          revision: 1,
          outcome: 'applied',
          approve: true,
          message: 'Undo the previous decision',
          actingSubject: reader,
        },
        tokenB,
      ),
    );
    await producer.runEditorialOnce();
    expect(
      (await inbox()).items.some(
        (item) => item.topic === 'proposal-reverted' && item.proposal?.id === reversed.proposal,
      ),
    ).toBe(true);
    const newProposal = async () => {
      const metadata = await json<{ revision: string }>(
        await request(
          'GET',
          `/v1/works/${shortId(work.work)}/metadata?actingSubject=${encodeURIComponent(f.actor)}`,
        ),
      );
      return json<{ proposal: string }>(
        await request('POST', '/v1/editorial/proposals', {
          profile: 'editorial-proposal-create-v1',
          kind: 'component-correction',
          target: {
            resource: work.work,
            revision: work.workRevision,
            context: 'urn:rezics:context:global',
          },
          candidate: { command: 'work-metadata', state: state('Another review') },
          baseHeads: [{ component: baseHeads[0]!.component, head: metadata.revision }],
          evidence: [],
          actingSubject: f.actor,
        }),
        201,
      );
    };
    const withdrawn = await newProposal();
    // Watching before the first producer tick makes this a manual subscription.
    expect(
      await json(
        await request(
          'GET',
          `/v1/me/proposal-subscriptions/${withdrawn.proposal}`,
          undefined,
          tokenB,
        ),
      ),
    ).toMatchObject({ subscription: null });
    await json(await request('PUT',`/v1/me/proposal-subscriptions/${withdrawn.proposal}`,{
      profile: 'proposal-subscription-v1', level: 'all', expectedRevision: null },tokenB));
    await producer.runEditorialOnce();
    await json(
      await request('POST', `/v1/editorial/proposals/${withdrawn.proposal}/withdrawal`, {
        profile: 'editorial-proposal-withdraw-v1',
        revision: 1,
        actingSubject: f.actor,
      }),
    );
    await producer.runEditorialOnce();
    expect(
      (await inbox(tokenB)).items.some(
        (item) =>
          item.topic === 'proposal-withdrawn' &&
          item.proposal?.id === withdrawn.proposal &&
          item.reason === 'steward',
      ),
    ).toBe(true);
    const rejected = await newProposal();
    await json(
      await request(
        'POST',
        `/v1/editorial/proposals/${rejected.proposal}/decisions`,
        {
          profile: 'editorial-proposal-decide-v1',
          revision: 1,
          outcome: 'rejected',
          approve: false,
          message: 'Evidence does not support this change',
          actingSubject: reader,
        },
        tokenB,
      ),
    );
    await producer.runEditorialOnce();
    expect(
      (await inbox()).items.some(
        (item) => item.topic === 'proposal-decided' && item.proposal?.id === rejected.proposal,
      ),
    ).toBe(true);
    unavailableProposal = proposal.proposal;
    const partlyUnavailable = (await inbox(tokenB, '?view=done')).items;
    expect(partlyUnavailable.find(item => item.id === requested.id)).toMatchObject({
      state: 'active', subject: null, proposal: null, reason: null,
    });
    const mixedPage = (await inbox(tokenB)).items;
    expect(mixedPage.find(item => item.topic === 'proposal-revised')).toMatchObject({
      state: 'active', subject: null, proposal: null, reason: null,
    });
    expect(mixedPage.some(item => item.proposal?.id === withdrawn.proposal && item.subject !== null)).toBe(true);
    unavailableProposal = null;
    const recipient = { issuer: f.account.issuer, subject: f.account.b.id };
    await store.setPreference(recipient, { purpose: 'governance', topic: 'review-requested',
      channel: 'email', state: 'enabled', expectedRevision: null, idempotencyKey: randomUUID(), via: 'settings' });
    await store.registerEndpoint(recipient, { channel: 'push', deviceId: 'review-device',
      address: 'https://push.local/reviews', addressDigest: hash('review-device'), lockScreenDisclosure: true });
    const provider = new FakeDeliveryProvider();
    const dispatcher = new NotificationDispatcher(f.accessPool, provider, subjects);
    const delivered = await newProposal();
    await producer.runEditorialOnce();
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, delivered: 1 });
    expect((await inbox(tokenB)).items.some(item => item.proposal?.id === delivered.proposal)).toBe(true);
    const formerSteward = await newProposal();
    await producer.runEditorialOnce();
    await f.accessPool.query('DELETE FROM access.work_maintainer WHERE work = $1 AND agent = $2', [
      work.work, reader,
    ]);
    // Read access and manual watches remain usable; only steward authority is lost.
    await json(await request('GET', `/v1/works/${shortId(work.work)}/metadata?actingSubject=${encodeURIComponent(reader)}`,
      undefined, tokenB));
    expect((await inbox(tokenB)).items.some(item => item.proposal?.id === withdrawn.proposal)).toBe(true);
    expect(await json(await request('GET', `/v1/me/proposal-subscriptions/${formerSteward.proposal}`,
      undefined, tokenB))).toMatchObject({ subscription: { reason: 'steward', level: 'participating' } });
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, delivered: 0, cancelled: 1 });
    expect(provider.calls.send).toBe(1);
    const cancelled = (await f.accessPool.query<{ state: string }>(`SELECT d.state
      FROM access.notification_delivery d JOIN access.notification_proposal_context c ON c.item_id = d.item_id
      WHERE c.proposal = $1 AND d.principal_id = $2`, [formerSteward.proposal, f.otherPrincipal])).rows;
    expect(cancelled).toEqual([{ state: 'cancelled' }]);
    await f.accessPool.query(`INSERT INTO access.notification_digest_day (principal_id,day)
      VALUES ($1,(clock_timestamp() AT TIME ZONE 'UTC')::date - 1)`, [f.otherPrincipal]);
    await f.accessPool.query(`UPDATE access.notification_digest_candidate
      SET day = (clock_timestamp() AT TIME ZONE 'UTC')::date - 1 WHERE principal_id = $1`, [f.otherPrincipal]);
    try {
      globalThis.fetch = (async (input, init) => String(input) === 'http://digest.local/intake'
        ? (digests.push(JSON.parse(String(init?.body))), new Response(null, { status: 204 }))
        : nativeFetch(input, init)) as typeof fetch;
      await new NotificationDigestWorker(f.accessPool, store, f.account.issuer,
        'http://digest.local/intake', 'test').runOnce();
    } finally { globalThis.fetch = nativeFetch; }
    expect(digests).toHaveLength(1); // No email for the former steward; only the earlier author digest.
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [readGrant]);
    const hidden = [...(await inbox(tokenB)).items, ...(await inbox(tokenB, '?view=done')).items];
    expect(hidden.length).toBeGreaterThan(0);
    expect(
      hidden.every(
        (item) =>
          item.state === 'withdrawn' &&
          item.subject === null &&
          item.proposal === null &&
          item.reason === null,
      ),
    ).toBe(true);
    await json(await subscription(proposal.proposal, 'participating', null, tokenB), 404);
    expect(Date.now() - preparation).toBeLessThan(600_000);
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 600_000);
