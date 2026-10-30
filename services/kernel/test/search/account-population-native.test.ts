import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { createLifecycleCommands, createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { admittedAccess, authenticateAccount, accountToken } from '../support/admitted-access.ts';
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
