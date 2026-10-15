import { withFixtureRealmDisclosure } from './support/disclosure-ancestry.ts';
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { saveRealmSettings } from '../src/modules/access/realm-management-settings.ts';
import { GovernanceRules } from '../src/modules/governance/rules.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { SettingsCommand } from '../src/modules/realm-admin/contract.ts';
import { fallbackAvatar } from '../src/modules/media/summary.ts';
import { REALM_PROFILE } from '../src/modules/realm-profile/schema.ts';
import { realmProfileRoutes, realmProfileSchemaError } from '../src/routes/realm-profile.ts';
import { reportRoutes } from '../src/routes/reports.ts';
import { readRealmHeader, readRealmLanding } from '../src/modules/realm-reads/read-realm.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { RV } from '../src/modules/work/activate.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000001504';
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000001505';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000001506';
const authoredRule = { id: 'be-kind',
  title: { original: 'en', labels: { en: 'Be kind' } },
  body: { original: 'en', labels: { en: 'Respect readers' } },
  governanceRule: null };

function settingsCommand(rules: (typeof authoredRule)[], expectedRulesRevision: string | null,
  expectedGeneration: string): SettingsCommand {
  return { actingSubject: actor, expectedGeneration, expectedRulesRevision,
    reason: 'Set community rules', settings: { visibility: 'private', reviewRequired: false,
      reviewMode: 'open', whoMaySubmit: 'members', selfJoin: false, rules } };
}

/** A small owner store drives the real settings writer and governance readers. */
function settingsStore() {
  interface Revision { ref: string; revision: string; scope_id: string; digest: string;
    document: unknown; request_digest: string }
  let head: Revision | undefined;
  let settings: Record<string, unknown> | undefined;
  const authorityActions: unknown[] = [];
  const revisions = new Map<string, Revision>();
  const query = async (sql: string, values: unknown[] = []) => {
    const result = (items: unknown[] = []) => ({ rows: items, rowCount: items.length });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return result();
    if (sql.startsWith('SELECT open FROM access.recovery_fence')) return result([{ open: true }]);
    if (sql.includes('SELECT p.id FROM access.principal p')) {
      authorityActions.push(values[4]);
      return result(values[4] === 'governance.rule.publish' ? [{ id: 'principal' }] : []);
    }
    if (sql.includes('SELECT f.open,r.document')) {
      return result([{ open: true, document: head?.document ?? null }]);
    }
    if (sql.includes('WITH fence AS MATERIALIZED')) {
      return result([{ open: true, document: head?.document ?? null, heads: [],
        member_value: null, member_revision: null }]);
    }
    if (sql.includes('SELECT COALESCE(s.visibility')) {
      return result([{ visibility: settings?.visibility ?? 'public', listing: 'listed',
        history: 'everything', self_join: settings?.self_join ?? false, admission: 'invitation' }]);
    }
    if (sql.includes('SELECT pg_advisory_xact_lock')) return result();
    if (sql.includes('WHERE principal_id = $1 AND idempotency_key = $2')) {
      const prior = revisions.get(`${values[0]}:${values[1]}`);
      return result(prior ? [prior] : []);
    }
    if (sql.includes('SELECT revision::text, scope_id FROM access.governance_rule_head')) {
      return result(head ? [head] : []);
    }
    if (sql.includes('INSERT INTO access.governance_rule_head')
      || sql.includes('UPDATE access.governance_rule_head')) return result();
    if (sql.includes('INSERT INTO access.governance_rule_revision')) {
      head = { ref: String(values[0]), revision: String(values[1]), scope_id: String(values[2]),
        digest: String(values[3]), document: JSON.parse(String(values[4])) as unknown,
        request_digest: String(values[8]) };
      revisions.set(`${values[5]}:${values[7]}`, head);
      return result();
    }
    if (sql.includes('INSERT INTO access.realm_admin_settings')) {
      settings = { who_may_submit: values[1], visibility: values[2], review_mode: values[3],
        self_join: values[4] };
      return result();
    }
    if (sql.includes('UPDATE access.membership_policy')) return result([{ updated: true }]);
    throw new Error(`Unexpected settings-store query: ${sql}`);
  };
  const client = { query, release: () => {} } as unknown as PoolClient;
  return { client, pool: { query, connect: async () => client } as unknown as Pool,
    authorityActions, setDocument: (document: unknown) => {
      if (!head) throw new Error('Save settings before replacing the document');
      head.document = document;
    } };
}

function readSession(governance: GovernanceRules, profileRules: unknown, summaryAvailable: boolean) {
  const payload = { name: { original: 'en', labels: { en: 'Readers' } },
    description: { original: 'en', labels: { en: 'Read together' } },
    iconSelection: null, bannerSelection: null, count: { kind: 'unknown', value: null },
    moderators: [], rules: profileRules };
  const policy = { id: realm, space, revision: 'urn:rezics:revision:realm',
    visibility: 'private' as const, reviewMode: 'open' as const,
    policyRevision: 'urn:rezics:receipt:policy', history: 'everything' as const,
    listing: 'listed' as const, admission: 'request' as const,
    realmRevision: 'urn:rezics:revision:realm' };
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (sparql: string) => {
      if (sparql.includes('SELECT ?space ?realmRevision')) return { results: { bindings: [{
        space: { type: 'uri', value: space },
        realmRevision: { type: 'uri', value: policy.realmRevision },
        disclosure: { value: `${RV}Private` },
        visibility: { value: 'private' }, mode: { value: 'open' },
        head: { type: 'uri', value: policy.policyRevision }, listing: { value: 'listed' },
        history: { value: 'everything' }, admission: { value: 'request' },
      }] } };
      if (sparql.includes('rv:publicProfileHead')) return { results: { bindings: [{
        revision: { type: 'uri', value: 'urn:rezics:revision:profile' },
        payload: { type: 'literal', value: JSON.stringify(payload) },
        model: { type: 'uri', value: REALM_PROFILE },
      }] } };
      throw new Error('Unexpected Realm read query');
    } } };
  const session = {
    displayLanguages: ['en'], position: { dataEpoch: 'epoch', sequence: '1' },
    realm: async () => policy,
    summaries: async () => summaryAvailable ? [{
      reference: realm, status: 'available', type: 'realm',
      name: { value: 'Readers', language: 'en', direction: 'ltr', basis: 'requested' },
      avatar: fallbackAvatar('realm', realm),
    }] : [{ reference: realm, status: 'unavailable' }],
    query: async () => [{ name: { value: 'Readers', 'xml:lang': 'en' } }],
    deps: { environment, governance: { rules: governance }, access: {} },
  } as unknown as WorkReadSession;
  return withFixtureRealmDisclosure(session);
}

test('profile publication refuses rules on every matched route form', async () => {
  const request = new Elysia().onError(({ error, request, route, params }) =>
    realmProfileSchemaError(error, request, route, params))
    .use(realmProfileRoutes({} as never));
  for (const path of [
    '/v1/realms/00000000-0000-4000-8000-000000001504/profile',
    '/v1/realms/00000000-0000-4000-8000-000000001504/profile/',
    '/v1/realms/%300000000-0000-4000-8000-000000001504/profile',
  ]) {
    const rejected = await request.handle(new Request(`http://main.local${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rules-rejected' },
      body: JSON.stringify({ profile: 'realm-public-profile-v2', expectedHead: null,
        actingSubject: actor, publication: { name: { original: 'en', labels: { en: 'Readers' } },
          description: { original: 'en', labels: { en: 'Read together' } }, iconSelection: null,
          bannerSelection: null, count: { kind: 'unknown', value: null }, moderators: [],
          rules: [authoredRule] } }),
    }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ status: 400, code: 'invalid_realm_profile' });
  }
});

test('Realm reads use only saved settings rules and clearing means no rules', async () => {
  const db = settingsStore();
  const governance = new GovernanceRules(db.pool);
  const saved = await saveRealmSettings(db.client, realm, 'principal',
    settingsCommand([authoredRule], null, '1'), 'rules-present');
  const profileRules = [{ obsolete: true }];
  const headerSession = readSession(governance, profileRules, true);
  const header = await readRealmHeader(headerSession, realm);
  expect(header.rules).toMatchObject([{ id: 'be-kind', title: { value: 'Be kind' } }]);
  const joinPage = await readRealmLanding(readSession(governance, profileRules, false), realm);
  expect(joinPage.profile).toBe('realm-join-page-v1');
  expect(joinPage.rules).toMatchObject([{ id: 'be-kind', title: { value: 'Be kind' } }]);

  await saveRealmSettings(db.client, realm, 'principal',
    settingsCommand([], saved.ruleBasis.revision, '2'), 'rules-cleared');
  expect((await readRealmHeader(readSession(governance, profileRules, true), realm)).rules).toEqual([]);
  expect((await readRealmLanding(readSession(governance, profileRules, false), realm)).rules).toEqual([]);
});

test('generic rule publication authority cannot replace or clear managed Realm rules', async () => {
  const db = settingsStore();
  const governance = new GovernanceRules(db.pool);
  const saved = await saveRealmSettings(db.client, realm, 'settings-principal',
    settingsCommand([authoredRule], null, '1'), 'rules-present');
  const principal = { issuer: 'https://account.test', subject: 'rule-publisher', emailVerified: true } as VerifiedPrincipal;
  const input = { ref: saved.ruleBasis.ref, scopeId: `governance:realm:${realm}`,
    actingSubject: actor, expectedRevision: saved.ruleBasis.revision, idempotencyKey: 'generic-rules' };
  const api = new Elysia().use(reportRoutes({ governance: { rules: governance },
    account: { verify: async () => principal } } as never));
  // The reference remains reserved even when disguised as a generic document.
  for (const document of [
    { profile: 'realm-settings-rules-v2', public: true, rules: [{ ...authoredRule, id: 'replacement' }] },
    { profile: 'realm-settings-rules-v2', public: true, rules: [] },
    { message: 'clear' },
  ]) {
    const refused = await api.handle(new Request('http://main.local/v1/governance/rules', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ profile: 'governance-rule-v1', ...input, document }),
    }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'invalid_governance_request' });
    expect(await governance.publishedRealmRules(realm, true)).toEqual([authoredRule]);
  }
  expect(db.authorityActions).toEqual(Array(3).fill('governance.rule.publish'));
});

test('unreadable rules make the join page unavailable; absent and empty documents have no rules', async () => {
  const db = settingsStore();
  const governance = new GovernanceRules(db.pool);
  const staleProfileRules = [authoredRule];
  expect(await governance.publishedRealmRules(realm, true)).toEqual([]);
  expect((await readRealmLanding(readSession(governance, staleProfileRules, false), realm)).rules).toEqual([]);
  await saveRealmSettings(db.client, realm, 'principal', settingsCommand([], null, '1'), 'rules-empty');
  expect(await governance.publishedRealmRules(realm, true)).toEqual([]);
  expect((await readRealmLanding(readSession(governance, staleProfileRules, false), realm)).rules).toEqual([]);

  db.setDocument({ profile: 'realm-settings-rules-v2', public: true, rules: 'invalid' });
  expect(await governance.publishedRealmRules(realm, true)).toBeNull();
  await expect(readRealmLanding(readSession(governance, staleProfileRules, false), realm))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});
