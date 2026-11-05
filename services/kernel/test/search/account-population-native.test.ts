import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import {
  completeAgentVerification,
  finishAgentVerification,
  mergeVerifiedAgent,
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
} from '../../src/access/agent-verification.ts';
import { accountAgentId, accountAgentsForSubjects } from '../../src/semantic/agents.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { readIdentityMappings } from '../../src/semantic/identity-adapters/read.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import { readAccountDiscoverySummaries } from '../../src/access/account-discovery-source.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { runCommand } from '../../src/command/command.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { admittedAccess, authenticateAccount, accountToken } from '../support/admitted-access.ts';
import { digest, epochFixture, globalResource, identityEpochDatabase } from '../semantic/support/identity-epoch.ts';
import type { IdentityReceipt } from '../../src/semantic/identity-epoch-contract.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { nativeDiscoveryRegistry, createDiscoveryProjection } from '../../src/search/account-discovery.ts';
import { allocateDiscovery, advanceDiscovery, discoveryGenerations } from '../../src/search/generations.ts';
import { discoveryIndexName, discoveryAlias } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import { parseDiscoveryHitIdentity } from '../../src/search/discovery-documents.ts';
import type { DiscoveryKey } from '../../src/search/discovery.ts';

const databaseUrl = process.env.DATABASE_URL,
  searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl) throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check services');

test('native handled and handleless Accounts and catalogue Person converge; current fencing rejects a stale copy and replay preserves incomplete population', async () => {
  const pool = createPool(databaseUrl),
    search = createOpenSearch(searchUrl),
    routeKey = new Uint8Array(32).fill(87);
  const prefix = `account-${crypto.randomUUID().slice(0, 8)}-`,
    key = () => crypto.randomUUID();
  const actions = new Map(LIFECYCLE_ACTIONS);
  actions.set('subject:create', { anonymous: false });
  actions.set('subject:read', { anonymous: false });
  const access = admittedAccess({ actions });
  const proofs = new Map<
    object,
    { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
  >();
  const internal = createLifecycleInternals({
    pool,
    routeKey,
    provisioningEvidence: async (proof) =>
      typeof proof === 'object' && proof !== null ? (proofs.get(proof) ?? null) : null,
    recoveryEvidence: async () => null,
  });
  const commands = createLifecycleCommands({ pool, access });
  try {
    await setupSemantic(pool, bundledRelease);
    const registration = key(),
      accountId = internal.registrationTarget(registration),
      handle = `native_${key().replaceAll('-', '')}`;
    const claim = (await internal.reserveHandle({ accountId, handle, key: registration })).value;
    await internal.createPending({ accountId, handle, reservationId: claim.reservationId, key: key() });
    const evidence = {};
    proofs.set(evidence, { accountId, registrationId: claim.reservationId, authIdentityId: accountId, authnEpoch: 1 });
    await internal.claimHandle({ accountId, handle, reservationId: claim.reservationId, evidence, key: key() });
    await internal.activate({ accountId, evidence, key: key() });
    const actor = await authenticateAccount(
      access,
      { pool, deadline: Date.now() + 30_000 },
      { accountId, clientId: 'account-population', scopes: [...actions.keys()] },
    );
    const context = { actor, deadline: Date.now() + 30_000 };
    const organizationId = newId(routeOf(accountId)!);
    const reservation = await internal.reserveCoordination({
      accountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    });
    await internal.createOrganization({
      organizationId,
      ownerAccountId: accountId,
      ownerReservationId: reservation.value.reservationId,
      key: key(),
    });
    const label = `Native shared label ${key()}`;
    for (const id of [accountId, organizationId])
      await commands.updateAccount(context, { accountId: id, patch: { displayName: label }, key: key() });
    const kernel = createKernel({
      pool,
      access,
      routeKey,
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) },
      writeRate: createWriteRateLimiter({ secret: key() }),
    });
    const bearer = await accountToken({ accountId, clientId: 'account-population', scopes: [...actions.keys()] });
    const created = await kernel.handle(
      new Request('http://kernel.test/v1/subjects', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key()),
        },
        body: JSON.stringify({ type: 'schema:Person', labels: { en: label } }),
      }),
    );
    expect(created.status).toBe(201);
    const body: unknown = await created.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('subject' in body) ||
      !body.subject ||
      typeof body.subject !== 'object' ||
      !('id' in body.subject) ||
      typeof body.subject.id !== 'string'
    )
      throw new Error('Native Subject creation returned no identity');
    const personId = body.subject.id;
    const source = createRatedSubjectSource(pool, routeKey).source,
      registry = await nativeDiscoveryRegistry(pool, routeKey, source),
      listing = subjectListingSource(pool);
    const options = { pool, search, prefix, registry, listing };
    await allocateDiscovery(pool, prefix, registry);
    await advanceDiscovery(options);
    const target = (await discoveryGenerations(pool, prefix))[0];
    if (!target?.uuid) throw new Error('Native generation was not allocated');
    const projection = createDiscoveryProjection({ ...options, target }),
      index = discoveryIndexName(prefix, target.generation);
    const keys: DiscoveryKey[] = [
      ...[accountId, organizationId].map((id): DiscoveryKey => ({
        owner: 'accounts',
        kind: 'account',
        route: routeOf(id)!,
        id,
      })),
      { owner: 'semantic', kind: 'schema:Person', route: routeOf(personId)!, id: personId },
    ];
    for (const partition of new Set(keys.map(({ route }) => partitionOf(route))))
      await projection.project(
        partition,
        keys.filter((key) => partitionOf(key.route) === partition),
      );
    const read = async () => {
      const { body } = await search.request<{ hits: { hits: unknown[] } }>('POST', `/${index}/_search`, {
        size: 10,
        query: { match: { search_text: label } },
      });
      return body.hits.hits.map((hit) => parseDiscoveryHitIdentity(registry, hit));
    };
    expect((await read()).map(({ id }) => id).sort()).toEqual([accountId, organizationId, personId].sort());
    const accounts = registry.get('account');
    if (accounts.owner !== 'accounts') throw new Error('Missing native Account registry');
    const summaries = await accounts.hydrate([accountId, organizationId], {
      actor,
      access,
      deadline: Date.now() + 30_000,
    });
    expect(summaries.get(accountId)?.handle).toBe(handle);
    expect(summaries.get(organizationId)?.handle).toBeNull();
    await withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('UPDATE access.account SET display_name=$3 WHERE route=$1 AND account_id=$2', [
          routeOf(accountId),
          accountId,
          'Rolled back private value',
        ]);
      } finally {
        await client.query('ROLLBACK');
      }
    });
    await projection.project(
      partitionOf(routeOf(accountId)!),
      keys.filter((key) => partitionOf(key.route) === partitionOf(routeOf(accountId)!)),
    );
    expect((await read()).map(({ id }) => id).sort()).toEqual([accountId, organizationId, personId].sort());
    await internal.raiseFence({ accountId, key: key() });
    expect((await read()).some(({ id }) => id === accountId)).toBe(true); // Worker has deliberately not run.
    expect((await accounts.hydrate([accountId], { actor, access, deadline: Date.now() + 30_000 })).has(accountId)).toBe(
      false,
    );
    await projection.project(partitionOf(routeOf(accountId)!), [
      { owner: 'accounts', kind: 'account', route: routeOf(accountId)!, id: accountId },
    ]);
    expect((await read()).some(({ id }) => id === accountId)).toBe(false);
    expect((await discoveryGenerations(pool, prefix))[0]?.state).toBe('populating');
    await expect(search.request('GET', `/_alias/${discoveryAlias(prefix)}`)).rejects.toBeInstanceOf(OpenSearchError);
  } finally {
    for (const target of await discoveryGenerations(pool, prefix))
      if (target.uuid) await search.request('DELETE', `/${discoveryIndexName(prefix, target.generation)}`);
    await pool.end();
  }
}, 60_000);

test('native account context reads the exact published agent graph and withholds pending or unavailable mappings', async () => {
  const deployment = await identityEpochDatabase();
  try {
    const fixture = await epochFixture(deployment.url, { pool: deployment.pool });
    try {
      const pool = fixture.pool,
        accountId = fixture.accounts.editor,
        staffId = fixture.accounts.outsider,
        routeKey = new Uint8Array(32).fill(93),
        tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(46)]]) },
        writeRate = createWriteRateLimiter({ secret: crypto.randomUUID() });
      const routeKernel = createKernel({ pool, routeKey, tokens, writeRate });
      const actions = new Map(actionCatalogue(routeKernel));
      const access = admittedAccess({ actions });
      const kernel = createKernel({ pool, routeKey, tokens, writeRate, access });
      const clientId = 'account-population-context';
      const scopes = [...actions.keys(), 'account:manage', 'gate:any'];
      const accountBearer = await accountToken({ accountId, clientId, scopes });
      const staffBearer = await accountToken({ accountId: staffId, clientId, scopes });
      const subject = (await fixture.create('Published account context person')).subject.id;
      const original = accountAgentId(accountId);
      await ensureAccountAgent(pool, { account: accountId, kind: 'person', name: 'Published account context person' });
      await fixture.real.grant({ route: routeOf(accountId)!, id: accountId }, 'editor', 'account:update');
      await fixture.real.grant({ route: routeOf(accountId)!, id: accountId }, 'editor', 'account:read');
      await bootstrapGovernance(pool, staffId);

      const post = async (path: string, bearer: string, body?: unknown) => {
        const headers: Record<string, string> = { [IDEMPOTENCY_HEADER]: JSON.stringify(crypto.randomUUID()) };
        const init: RequestInit = { method: 'POST', headers };
        if (body !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        headers.authorization = `Bearer ${bearer}`;
        return kernel.handle(new Request(`https://kernel.test${path}`, init));
      };
      const opened = await post('/v1/platform/exposure/agent_verification:open', staffBearer);
      expect(opened.status).toBe(200);
      const requested = await post(`/v1/accounts/${accountId}:requestVerification`, accountBearer, {
        subject,
        statement: 'This public subject represents my account.',
        links: [{ label: 'Website', url: 'https://example.test/profile' }],
      });
      expect(requested.status).toBe(200);
      const requestBody = (await requested.json()) as { verificationRequest: { id: string } };
      const approved = await post(
        `/v1/verification-requests/${requestBody.verificationRequest.id}:approve`,
        staffBearer,
        {},
      );
      expect(approved.status).toBe(200);
      const decision = await readAgentVerificationWorkflowRequest(pool, requestBody.verificationRequest.id);
      if (!decision?.decisionReceiptId) throw new Error('Approved verification has no native decision receipt');
      const workflow = { ...decision, receiptId: decision.decisionReceiptId };
      const clock = () => new Date();
      await recordPendingAgentVerification(pool, workflow, clock);
      await mergeVerifiedAgent(pool, workflow);
      await completeAgentVerification(pool, workflow, clock);
      await finishAgentVerification(pool, workflow, clock);

      const nativeLink = (await accountAgentsForSubjects(pool, [subject])).get(subject);
      expect(nativeLink).toMatchObject({
        account: accountId,
        agent_id: original,
        subject,
        verified: true,
        receipt_id: workflow.receiptId,
      });
      const mappings = await readIdentityMappings(pool, [original, subject]);
      expect(mappings).toMatchObject([
        { state: 'mapped', original, terminal: subject },
        { state: 'mapped', original: subject, terminal: subject },
      ]);
      if (mappings[0]?.state !== 'mapped' || mappings[1]?.state !== 'mapped')
        throw new Error('Published account context mapping is unavailable');
      expect(mappings[0].epoch).toBeGreaterThan(0n);
      expect(mappings[0].epoch).toBe(mappings[1].epoch);

      const actor = await authenticateAccount(
        access,
        { pool, deadline: Date.now() + 30_000 },
        { accountId, clientId, scopes },
      );
      const read = (context: boolean) =>
        readAccountDiscoverySummaries({ pool, routeKey, access, actor, deadline: Date.now() + 30_000 }, [accountId], {
          context,
        });
      const available = (await read(true)).get(accountId);
      expect(available?.verifiedAgent).toEqual({
        id: subject,
        label: 'Published account context person',
        type: 'schema:Person',
      });
      expect(available?.context?.followTarget).toMatchObject({
        state: 'available',
        id: subject,
        label: 'Published account context person',
        type: 'schema:Person',
      });
      expect((await read(false)).get(accountId)).not.toHaveProperty('context');

      const sourceEpoch = mappings[0].epoch;
      await fixture.admin.query('UPDATE semantic.identity_epoch_mapping SET epoch=0 WHERE route=$1 AND original=$2', [
        routeOf(original),
        original,
      ]);
      try {
        expect((await read(true)).get(accountId)?.context?.followTarget).toEqual({ state: 'unavailable' });
      } finally {
        await fixture.admin.query(
          'UPDATE semantic.identity_epoch_mapping SET epoch=$3 WHERE route=$1 AND original=$2',
          [routeOf(original), original, sourceEpoch.toString()],
        );
      }

      const pendingSubject = (await fixture.create('Pending account context merge')).subject.id;
      const merger = await authenticateAccount(
        access,
        { pool, deadline: Date.now() + 30_000 },
        { accountId, clientId, scopes },
      );
      const store = identityEpochStore(),
        key = crypto.randomUUID();
      const receipt: IdentityReceipt = {
        kind: 'subject.merge',
        command: {
          actorAccountId: accountId,
          kind: 'subject.merge',
          key,
          digest: digest(key),
        },
      };
      await runCommand(
        pool,
        {
          partition: store.controlPartition,
          basis: { actorAccountId: merger.accountId, clientId: merger.clientId, requestedBy: merger.requestedBy },
          authorization: await accessCommandAuthorization(
            access,
            merger,
            'subject:merge',
            globalResource,
            { pool, deadline: Date.now() + 30_000 },
            () => new Error('Native identity merge admission denied'),
          ),
        },
        (tx) =>
          store.admit(tx, {
            intent: { kind: 'merge', survivor: subject, redirected: pendingSubject, release: bundledDigest },
            receipt,
          }),
      );
      expect(await store.readMapping(pool, original)).toMatchObject({ state: 'pending' });
      expect((await read(true)).get(accountId)?.context?.followTarget).toEqual({ state: 'unavailable' });
    } finally {
      await fixture.close();
    }
  } finally {
    await deployment.close();
  }
}, 120_000);
