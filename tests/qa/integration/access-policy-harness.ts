import { isForegroundOperation } from './support/operation-cost.ts';
// Shared real-owner fixture for the Access policy, interaction and revocation
// APIs: cloned Account/Access databases, real OAuth tokens, Main HTTP handlers and
// an Access pool that counts owner SQL calls, selected rows and written rows.
import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { authorityState, revocationSourceState, workAuthorityEpoch } from './g-903-api-values.ts';
import { AccessAuthorityRead } from '../../../services/main/src/modules/access/authority-read.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

export const POLICY_SCOPES = 'openid access:manage access:grant work:read work:edit work:create comment:create';
export const iri = () => `https://rezics.com/id/${randomUUID()}`;

export async function policyHarness() {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access'], 'owner');
  const pool = new Pool({ connectionString: databases.urls.access, max: 12 });
  const costs = { calls: 0, rows: 0, writes: 0 };
  const count = (sql: string, result: { rows: unknown[]; rowCount: number | null }) => {
    if (!isForegroundOperation()) return result;
    costs.calls++;
    costs.rows += result.rows.length;
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) costs.writes += result.rowCount ?? 0;
    return result;
  };
  const measured = {
    query: async (sql: string, values?: unknown[]) => count(sql, await pool.query(sql, values)),
    connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => count(sql, await client.query(sql, values)),
        release: () => client.release() };
    },
  } as unknown as Pool;
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
      Record<string, string>, POLICY_SCOPES);
  } catch (error) {
    await pool.end();
    await databases.close();
    throw error;
  }
  const manager = randomUUID();
  const reader = randomUUID();
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, $3, $4), ($2, $3, $5)`, [manager, reader, account.issuer, account.a.id, account.b.id]);
  await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
  const registry = new AccessAdmissionRegistry(pool);
  const owner = new AccessPolicyOwner(measured);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const app = createMainApp(fuseki, { environment: { fuseki, objectDirectory: '.temp/access-policy-objects',
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } },
  account: account.verifier, access: registry, accessPolicy: owner,
  authorityRead: new AccessAuthorityRead(pool), actingContexts: new AccessActingContexts(pool) });
  const call = async (method: string, path: string, token: string, body?: object, key = randomUUID()) => {
    const response = await app.handle(new Request(`http://main.local${path}`, { method,
      headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> & {
      code?: string; title?: string } };
  };
  const ok = async <T = Record<string, unknown>>(pending: ReturnType<typeof call>, status = 200) => {
    const response = await pending;
    if (response.status !== status) throw new Error(`${response.status} ${JSON.stringify(response.body)}`);
    expect(response.status).toBe(status);
    return response.body as T;
  };
  const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
  const authorityReaders: { subject: string; action: string }[] = [];
  const issuedSources: { id: string; issuer: string; scope: string }[] = [];
  const observedEpochs = new Map<string, string>();
  const fixture = {
    agent: async (kind: 'agent' | 'institution' = 'agent') => {
      const id = iri();
      await q('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [id, kind]);
      return id;
    },
    scope: async (prefix = 'wiki') => {
      const id = `${prefix}:${randomUUID()}`;
      await q('INSERT INTO access.scope_gate (id) VALUES ($1)', [id]);
      return id;
    },
    mandate: async (principal: string, subject: string, action: string) => {
      const id = randomUUID();
      await q(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [id, principal, subject, action]);
      if (principal === manager && ['access.policy.manage', 'access.revoke'].includes(action)) {
        authorityReaders.push({ subject, action });
      }
      return id;
    },
    grant: async (issuer: string, recipient: string, scope: string, action: string,
      membership?: { id: string; generation: number }, lifetime = '1 hour') => {
      const id = randomUUID();
      issuedSources.push({ id, issuer, scope });
      await q(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
          action, valid_until, membership_id, membership_generation)
        VALUES ($1, $2, $3, $4, $5, now() + $6::interval, $7, $8)`, [id, issuer, recipient, scope, action,
        lifetime, membership?.id ?? null, membership?.generation ?? null]);
      return id;
    },
    memberSet: async (kind: 'org' | 'realm', ownerSubject: string) => {
      await q(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
        VALUES ($1, $2, 1, 'terms-1')`, [kind, ownerSubject]);
    },
    agentMember: async (kind: 'org' | 'realm', ownerSubject: string, member: string) => {
      const id = randomUUID();
      await q(`INSERT INTO access.membership (id, kind, owner_subject, member_subject, state, generation,
          policy_revision, terms_revision, consent_reference)
        VALUES ($1, $2, $3, $4, 'joined', 1, 1, 'terms-1', $5)`, [id, kind, ownerSubject, member, randomUUID()]);
      return id;
    },
    principalMember: async (kind: 'org' | 'realm', ownerSubject: string, principal: string) => {
      const consent = randomUUID();
      const id = randomUUID();
      await q(`INSERT INTO access.private_membership_consent (id, principal_id, principal_epoch, kind,
          owner_subject, policy_revision, terms_revision, next_generation, expires_at)
        VALUES ($1, $2, 0, $3, $4, 1, 'terms-1', 1, now() + interval '5 minutes')`,
      [consent, principal, kind, ownerSubject]);
      await q(`INSERT INTO access.private_membership (id, kind, owner_subject, principal_id, state,
          generation, policy_revision, terms_revision, consent_reference)
        VALUES ($1, $2, $3, $4, 'joined', 1, 1, 'terms-1', $5)`, [id, kind, ownerSubject, principal, consent]);
      return id;
    },
    epoch: async (scope: string) => {
      let failure: unknown;
      if (scope === 'work:create:root') {
        try {
          const epoch = await workAuthorityEpoch(app, account.tokenA);
          observedEpochs.set(scope, epoch);
          return epoch;
        } catch (error) { failure = error; }
      }
      for (const reader of authorityReaders) {
        try {
          const source = issuedSources.find(source => source.scope === scope && source.issuer === reader.subject);
          if (reader.action === 'access.revoke' && !source) continue;
          const epoch = (reader.action === 'access.revoke'
            ? await revocationSourceState(app, account.tokenA, source!.id, reader.subject)
            : await authorityState(app, account.tokenA, scope, reader.subject, reader.action)).authorityEpoch;
          observedEpochs.set(scope, epoch);
          return epoch;
        } catch (error) { failure = error; }
      }
      const observed = observedEpochs.get(scope);
      if (observed !== undefined) return observed;
      throw failure ?? new Error(`No authorized authority reader for ${scope}`);
    },
  };
  return { pool, costs, account, manager, reader, registry, app, call, ok, q, fixture,
    managerToken: account.tokenA, readerToken: account.tokenB,
    close: async () => {
      await account?.close();
      await pool.end();
      await databases.close();
    } };
}

export type PolicyHarness = Awaited<ReturnType<typeof policyHarness>>;

/** Condition and rule builders for the access-policy-v1 profile. */
export const rule = {
  guard: (condition: object, actions = ['work.read', 'work.edit', 'work.create']) =>
    ({ ruleId: randomUUID(), actions, condition }),
  allow: (condition: object, actions = ['work.read', 'work.edit', 'work.create']) =>
    ({ ruleId: randomUUID(), actions, effect: 'allow' as const, condition }),
  deny: (condition: object, actions = ['work.read', 'work.edit', 'work.create']) =>
    ({ ruleId: randomUUID(), actions, effect: 'deny' as const, condition }),
};
export const memberOf = (admission: string, basis: 'authenticated_principal' | 'acting_subject') =>
  ({ op: 'member-of', admission, basis });

/** A wiki with an owner Agent whose representative (the manager) publishes its policy. */
export async function governedWiki(h: PolicyHarness, scopePrefix = 'wiki') {
  const owner = await h.fixture.agent();
  const scope = scopePrefix === 'work:create:root' ? scopePrefix : await h.fixture.scope(scopePrefix);
  await h.fixture.mandate(h.manager, owner, 'access.policy.manage');
  await h.fixture.grant(owner, owner, scope, 'access.policy.manage');
  const policyId = randomUUID();
  let head = 0;
  const body = async (mandatory: object[], ordered: object[], extra: Record<string, unknown> = {}) => ({
    profile: 'access-policy-change-v1', action: 'publish-revision', issuerSubject: owner, policyId,
    scopeId: scope, expectedHeadRevision: String(head), expectedAuthorityEpoch: await h.fixture.epoch(scope),
    mandatory, ordered, ...extra });
  const publish = async (mandatory: object[], ordered: object[], extra: Record<string, unknown> = {},
    key = randomUUID()) => h.call('POST', '/v1/access/policy-changes', h.managerToken,
    await body(mandatory, ordered, extra), key);
  return { owner, scope, policyId, body,
    publish,
    advance: (revision: string) => { head = Number(revision); },
    published: async (mandatory: object[], ordered: object[], extra: Record<string, unknown> = {}) => {
      const result = await h.ok<{ revision: string; authorityEpoch: string }>(publish(mandatory, ordered, extra));
      head = Number(result.revision);
      return result;
    },
    admit: async (setOwner: string, basis: 'authenticated_principal' | 'acting_subject',
      purpose: 'resource-exclusion' | 'resource-eligibility' = 'resource-exclusion') => {
      const setAdmissionId = randomUUID();
      await h.ok(h.call('POST', '/v1/access/policy-changes', h.managerToken, {
        profile: 'access-policy-change-v1', action: 'admit-set', issuerSubject: setOwner,
        expectedAuthorityEpoch: await h.fixture.epoch(scope), setAdmissionId, setKind: 'realm', basis,
        referencingScopeId: scope, purpose, validUntil: new Date(Date.now() + 86_400_000).toISOString() }));
      return setAdmissionId;
    },
    revokeSet: async (setOwner: string, setAdmissionId: string) => h.ok(h.call('POST',
      '/v1/access/policy-changes', h.managerToken, { profile: 'access-policy-change-v1',
        action: 'revoke-set', issuerSubject: setOwner, expectedAuthorityEpoch: await h.fixture.epoch(scope),
        setAdmissionId, expectedGeneration: '0' })),
    decide: async (actingSubject: string | null, action = 'work.edit', token = h.readerToken,
      extra: Record<string, unknown> = {}) => h.ok<{ decisionId: string | null; result: string;
      policyRevision: string; sources: { kind: string; id: string; generation: string }[];
      reusable: boolean }>(h.call('POST', '/v1/access/policy-decisions', token, {
      profile: 'access-policy-decision-v1', scopeId: scope, action, actingSubject, ...extra })),
  };
}

/** A Realm whose manager may admit its member sets for referencing scopes. */
export async function realm(h: PolicyHarness) {
  const id = await h.fixture.agent('institution');
  await h.fixture.memberSet('realm', id);
  await h.fixture.mandate(h.manager, id, 'access.policy.set-admission');
  return id;
}
