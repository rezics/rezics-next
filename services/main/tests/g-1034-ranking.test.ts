import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { GovernanceRules } from '../src/modules/governance/rules.ts';
import { GovernanceUnavailable } from '../src/modules/governance/store.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { DisclosureStore, DisclosureUnavailable } from '../src/modules/disclosure/read.ts';
import { PersonPreferencesStore } from '../src/modules/preferences/store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000001034';
const principal = {
  issuer: 'https://account.test',
  subject: 'reader',
  emailVerified: true,
} as VerifiedPrincipal;
function database(row: unknown) {
  const calls: { sql: string; values: unknown }[] = [];
  const pool = {
    query: async (sql: string, values: unknown) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT id AS agent')) return { rows: [] };
      return { rows: [row] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('G1034: Realm rule document and live scoped links share a single cut; private flags remain owner-authorized', async () => {
  const rule = {
    id: 'rule-1',
    title: { original: 'en', labels: { en: 'Be kind' } },
    body: { original: 'en', labels: { en: 'Read together' } },
    governanceRule: { ref: 'urn:rule:a', revision: '1' },
  };
  const db = database({
    open: true,
    document: { profile: 'realm-settings-rules-v2', public: false, rules: [rule] },
    heads: [{ ref: 'urn:rule:a', revision: '2', digest: 'a'.repeat(64) }],
  });
  const result = await new GovernanceRules(db.pool).realmHeaderRules(realm, []);
  expect(result.rules).toEqual([rule]);
  expect(result.heads.get('urn:rule:a')?.revision).toBe('2');
  expect(db.calls).toHaveLength(1);
  expect(db.calls[0]!.values).toEqual([
    `urn:rezics:realm-rules:${realm.slice(-36)}`,
    `governance:realm:${realm}`,
    '[]',
  ]);
  await expect(
    new GovernanceRules(database({ open: false }).pool).realmHeaderRules(realm, []),
  ).rejects.toBeInstanceOf(GovernanceUnavailable);
});

test('G1034: atomic principal probes distinguish inactive authority from held recovery', async () => {
  const db = database({ open: true, id: 'principal-id' });
  expect(await new AccessAdmissionRegistry(db.pool).activePrincipalId(principal)).toBe(
    'principal-id',
  );
  expect(db.calls).toHaveLength(1);
  expect(
    await new AccessAdmissionRegistry(database({ open: true, id: null }).pool).activePrincipalId(
      principal,
    ),
  ).toBeNull();
  await expect(
    new AccessAdmissionRegistry(
      database({ open: false, id: 'principal-id' }).pool,
    ).activePrincipalId(principal),
  ).rejects.toBeInstanceOf(AdmissionUnavailable);
});

test('G1034: atomic language/disclosure probes never interpret a missing recovery fence as public access', async () => {
  const languages = database({ open: true, id: 'principal-id', content_languages: ['ja', 'en'] });
  expect(await new PersonPreferencesStore(languages.pool).languagesForReader(principal)).toEqual([
    'ja',
    'en',
  ]);
  expect(languages.calls).toHaveLength(1);
  const db = database({ open: true, ordinal: 0, restricted: true, assessments: [] });
  const target = [{ owner: 'graph' as const, resource: realm, component: 'name' as const }];
  expect(await new DisclosureStore(db.pool).read(target, ANONYMOUS_VIEWER, 'summary')).toEqual([
    'tombstone',
  ]);
  expect(db.calls).toHaveLength(2); // Exact name-owner lookup, then the atomic disclosure fence.
  await expect(
    new DisclosureStore(
      database({ open: false, ordinal: 0, restricted: false, assessments: [] }).pool,
    ).read(target, ANONYMOUS_VIEWER, 'summary'),
  ).rejects.toBeInstanceOf(DisclosureUnavailable);
});
