import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { POLICY_VERSIONS } from '../../../services/account/src/policy-versions.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import type { MergedIdentity } from '../../../services/main/src/modules/identity-merge/resolution.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';

/** A state a user or owner causes goes through the product operation. A crash
 * or lag state goes through the real component stopped at the real point. An
 * operator's deliberate state goes through the existing maintenance command.
 * A state no path produces is deleted. Public visibility is a Main selection
 * of a public contribution. A later publication moves the contribution head
 * off that selection, which is how a public Work stops being publicly
 * readable. The merge and its reversal are reviewed identity-merge decisions.
 * A merge cycle is not produced by any path; the resolver refuses one in the
 * owner test for merged resolution. */

const scopes = 'openid work:create work:edit work:read work:correct work:review work:protect source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read address:claim agent:create';
interface Command { proposal: string; revision: number; outcome: string; receipt?: OwnerReceipt }
interface Published { contribution: string; draftRevision: string; publicationDecision: string; selection: string }

test('G836: public old IDs, slugs and retained revisions explain a merge without replacing original bytes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `g-836-address-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory, scopes);
  // Contribution history proves an edited draft through the Access pool the
  // product composition attaches. The fixture environment does not.
  (f.env as { eventTemporalAccess: Pool }).eventTemporalAccess = f.accessPool;
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const app = createMainApp(f.env.fuseki, {
    environment: f.env, access: f.access, account: f.account.verifier,
    identityMerge: { accessPool: f.accessPool, contentPool: f.pool },
    agentProvisioning: new AgentProvisioning(f.accessPool, f.env),
    editorialReview: new EditorialReviewStore(f.accessPool),
  });
  const call = (method: string, path: string, body?: object, token: string | null = f.account.tokenA, key = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}`, { method, headers: {
      'idempotency-key': key, ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const body: unknown = await response.json();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
    return body as T;
  };
  const anonymous = (path: string, body?: object) => call(body ? 'POST' : 'GET', path, body, null);
  const grant = async (principal: string, agent: string, scope: string, action: string) => {
    await f.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await f.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,'infinity')`, [randomUUID(), principal, agent, action]);
    await f.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,'infinity')`, [randomUUID(), agent, scope, action]);
  };
  try {
    await provisionFixtureAuthor(f.env, f.actor);
    await accountPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=ANY($1::text[])', [[f.account.a.id, f.account.b.id]]);
    const tokenB = await f.account.tokenFor(f.account.b, scopes);
    const email = `g836-address-${randomUUID()}@example.test`, password = randomBytes(24).toString('base64url');
    const third = await json<{ user: { id: string } }>(await fetch(`${f.account.issuer}/sign-up/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: f.account.issuer.replace('/api/auth', '') },
      body: JSON.stringify({ name: 'Independent reviewer', email, password, minimumAgeConfirmed: true,
        acceptedPolicies: POLICY_VERSIONS.map(({ policyId, versionDigest }) => ({ policyId, versionDigest })) }) }));
    await accountPool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [third.user.id]);
    const tokenC = await f.account.tokenFor({ email, password }, scopes);
    const agent = async (name: string, token: string) => (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: name }, token), 201)).agent;
    const actorA = await agent('Address reader', f.account.tokenA);
    const actorB = await agent('Address reviewer', tokenB);
    const actorC = await agent('Second human reviewer', tokenC);
    const principalC = (await f.accessPool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_issuer=$1 AND account_subject=$2',
      [f.account.issuer, third.user.id])).rows[0]!.id;
    for (const [principal, actor] of [[f.principalId, actorA], [f.otherPrincipal, actorB], [principalC, actorC]])
      await grant(principal!, actor!, 'editorial:review:urn:rezics:context:global', 'work.review');
    const source = await f.adoptWork(await f.propose('OL836001W', [], 'Sword Art Online 1 — Aincrad'));
    const survivor = await f.adoptWork(await f.propose('OL836002W', [], 'ソードアート・オンライン 1 アインクラッド'));
    const publish = async (work: { work: string; mainVersion: string }, body: string): Promise<Published> => {
      await f.grant(`contribution:create:${work.work}`, 'contribution.create');
      const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en', body, actingSubject: f.actor }), 201);
      await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
      await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
      await f.grant(`contribution:edit:${draft.contribution}`, 'contribution.edit');
      const publication = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: f.actor }), 201);
      await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
      const selected = await json<{ selection: string }>(await call('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: f.actor }), 201);
      return { contribution: draft.contribution, draftRevision: draft.draftRevision,
        publicationDecision: publication.publicationDecision, selection: selected.selection };
    };
    const published = { source: await publish(source, 'Sword Art Online 1 — Aincrad'),
      survivor: await publish(survivor, 'ソードアート・オンライン 1 アインクラッド') };
    for (const [principal, actor] of [[f.principalId, actorA], [f.otherPrincipal, actorB], [principalC, actorC]]) {
      for (const work of [source.work, survivor.work]) await grant(principal!, actor!, `work:edit:${work}`, 'work.edit');
    }
    for (const work of [source.work, survivor.work]) await f.grant(`work:read:${work}`, 'work.read');
    await f.grant(`address:claim:${source.work}`, 'address.claim');
    const slug = `sao-836-${randomUUID().slice(0, 8)}`;
    const address = await f.json<{ revision: string }>(await f.call('POST', '/v1/addresses/claims',
      { profile: 'alias-write-v1', operation: 'claim', scope: 'work', holder: source.work, alias: slug,
        expectedRevision: null, actingSubject: f.actor }), 201);
    const revisionPath = `/v1/revisions/${shortId(source.workRevision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const mainPath = `/v1/main-versions/${shortId(source.mainVersion)}/revisions/${shortId(source.mainRevision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const original = await f.json<Record<string, unknown>>(await f.call('GET', revisionPath), 200);
    const originalMain = await f.json<Record<string, unknown>>(await f.call('GET', mainPath), 200);
    const addressPath = `/v1/addresses/resolve?scope=work&key=${slug}`;
    const addressRevisionPath = `/v1/addresses/revisions/${address.revision}?scope=work&key=${slug}`;
    const originalAddress = await json<Record<string, unknown>>(await anonymous(addressRevisionPath), 200);
    const evidence = [{ resource: source.work, revision: source.workRevision, locator: 'SAO-volume-1/cover-and-title' }];
    const target = { resource: source.work, revision: source.workRevision, context: 'urn:rezics:context:global' };
    const candidate = { operation: 'merge', source: { resource: source.work, revision: source.workRevision },
      survivor: { resource: survivor.work, revision: survivor.workRevision }, evidence };
    const proposed = await json<Command>(await call('POST', '/v1/editorial/proposals', {
      profile: 'editorial-proposal-create-v1', kind: 'merge', target, candidate, evidence, actingSubject: actorA,
      baseHeads: [{ component: source.work, head: source.workRevision }, { component: survivor.work, head: survivor.workRevision }] }), 201);
    const proposalPath = (id: string, suffix = '') => `/v1/editorial/proposals/${id}${suffix}`;
    const approve = (id: string, actor: string, token: string) => call('POST', proposalPath(id, '/reviews'),
      { profile: 'editorial-proposal-review-v1', revision: 1, outcome: 'approve',
        message: 'Checked volume and language evidence', actingSubject: actor }, token);
    const decide = (id: string, actor: string, token: string, key = randomUUID()) => call('POST', proposalPath(id, '/decisions'),
      { profile: 'editorial-proposal-decide-v1', revision: 1, outcome: 'applied', approve: true,
        message: 'Apply reviewed correction', actingSubject: actor }, token, key);
    const finish = async (id: string, key = randomUUID()) => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const response = await decide(id, actorC, tokenC, key);
        if (response.status === 200) return json<Command>(response);
        await json<Command>(response, 202);
      }
      throw new Error('Bounded native stages did not finish');
    };
    await json(await approve(proposed.proposal, actorB, tokenB));
    const merged = await finish(proposed.proposal);
    expect(merged.outcome).toBe('applied');
    const resolution: MergedIdentity = { state: 'merged', source: source.work, survivor: survivor.work, hops: 1 };
    const oldId = await json<{ reference: string; status: string; resolution: MergedIdentity }>(
      await anonymous(`/v1/resources/${shortId(source.work)}`), 200);
    expect(oldId).toMatchObject({ reference: source.work, status: 'merged', resolution });
    const batch = await json<{ summaries: unknown[] }>(await anonymous('/v1/resources/summaries',
      { profile: 'resource-summary-batch-v1', resources: [source.work, survivor.work, source.work] }), 200);
    expect(batch.summaries).toHaveLength(3);
    expect(batch.summaries[0]).toMatchObject({ reference: source.work, status: 'available', resolution });
    expect(batch.summaries[2]).toEqual(batch.summaries[0]);
    const route = await json<{ state: string; holder: string; resolution: MergedIdentity }>(
      await anonymous(addressPath), 200);
    expect(route).toMatchObject({ state: 'current', holder: source.work, resolution });
    // Survivor deliberately has no slug: identity resolution still succeeds.
    expect(await json(await anonymous(addressRevisionPath), 200)).toEqual({ ...originalAddress, resolution });
    expect(await json(await f.call('GET', revisionPath), 200)).toEqual({ ...original, resolution });
    expect(await json(await f.call('GET', mainPath), 200)).toEqual({ ...originalMain, resolution });
    // A replacement publication moves the contribution head off the selected
    // decision, so the survivor is no longer a public Work.
    const edited = await json<{ draftRevision: string }>(await call('POST', '/v1/contribution-edits', {
      profile: 'text-contribution-v1', contribution: published.survivor.contribution,
      expectedHead: published.survivor.draftRevision, body: 'Survivor text is no longer the public selection',
      actingSubject: f.actor }), 200);
    const withdrawn = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: published.survivor.contribution,
      expectedDraftHead: edited.draftRevision, expectedPublicationHead: published.survivor.publicationDecision,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.actor }), 201);
    // No survivor identity or metadata escapes through a public source alias.
    expect((await anonymous(`/v1/resources/${shortId(source.work)}`)).status).toBe(404);
    expect((await anonymous(addressPath)).status).toBe(404);
    await json(await call('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: survivor.mainVersion },
      work: survivor.work, contribution: published.survivor.contribution,
      publicationDecision: withdrawn.publicationDecision, expectedSelectionHead: published.survivor.selection,
      selectionBasis: 'main-maintainer', actingSubject: f.actor }), 201);
    const reverse = await json<Command>(await call('POST', proposalPath(proposed.proposal, '/reversal'),
      { profile: 'editorial-proposal-revert-v1', evidence, actingSubject: actorA }), 201);
    await json(await approve(reverse.proposal, actorB, tokenB));
    const unmerged = await finish(reverse.proposal);
    expect(unmerged.outcome).toBe('applied');
    expect(await json(await f.call('GET', revisionPath), 200)).toEqual(original);
    expect(await json(await f.call('GET', mainPath), 200)).toEqual(originalMain);
    expect(await json(await anonymous(addressRevisionPath), 200)).toEqual(originalAddress);
    expect(await json(await anonymous(addressPath), 200)).toMatchObject({ state: 'current', holder: source.work });
  } finally {
    await accountPool.end();
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
