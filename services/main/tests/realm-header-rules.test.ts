import { withFixtureRealmDisclosure } from './support/disclosure-ancestry.ts';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { GovernanceRules } from '../src/modules/governance/rules.ts';
import { fallbackAvatar } from '../src/modules/media/summary.ts';
import { REALM_PROFILE, type PublicProfile } from '../src/modules/realm-profile/schema.ts';
import { readRealmHeader } from '../src/modules/realm-reads/read-realm.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000001504';
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000001505';

function rule(id: string, title: string) {
  return {
    id,
    title: { original: 'en', labels: { en: title } },
    body: { original: 'en', labels: { en: `${title} body` } },
    governanceRule: null,
  };
}

function profile(): PublicProfile {
  return {
    name: { original: 'en', labels: { en: 'Rank community' } },
    description: { original: 'en', labels: { en: 'Read together' } },
    moderators: [],
    iconSelection: null,
    bannerSelection: null,
    count: { kind: 'unknown', value: null },
  };
}

/** The header read uses the real profile parser and the real governance store.
 * Graph identity and the summary card are already fenced by the page. */
function headerSession(document: unknown, legacyRules: unknown[]) {
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      calls.push(values);
      return { rows: [{ open: true, document, heads: [], member_value: null, member_revision: null }] };
    },
  } as unknown as Pool;
  const governance = new GovernanceRules(pool);
  const session = {
    displayLanguages: ['en'],
    position: { dataEpoch: 'epoch', sequence: '1' },
    realm: async () => ({
      id: realm, space, revision: 'urn:rezics:revision:realm', visibility: 'public' as const,
      reviewMode: 'open' as const, policyRevision: null, history: 'everything' as const,
      listing: 'listed' as const, admission: 'invitation' as const, realmRevision: 'urn:rezics:revision:realm',
    }),
    summaries: async () => [{
      reference: realm, status: 'available' as const, type: 'realm' as const,
      name: { value: 'Rank community', language: 'en', direction: 'ltr' as const, basis: 'requested' as const },
      avatar: fallbackAvatar('realm', realm),
    }],
    deps: {
      environment: {
        fuseki: {
          query: async (sparql: string) => {
            if (!sparql.includes('rv:publicProfileHead')) throw new Error('Unexpected profile query');
            return { results: { bindings: [{
              revision: { type: 'uri', value: 'urn:rezics:revision:profile' },
              payload: { type: 'literal', value: JSON.stringify({ ...profile(), rules: legacyRules }) },
              model: { type: 'uri', value: REALM_PROFILE },
            }] } };
          },
        },
      },
      governance: { rules: governance },
      access: {},
    },
  } as unknown as WorkReadSession;
  return { session: withFixtureRealmDisclosure(session), calls, governance };
}

test('settings rules stay the header source when an old profile also has rules', async () => {
  const managed = rule('stay', 'Stay');
  const { session } = headerSession(
    { profile: 'realm-settings-rules-v2', public: true, rules: [managed] },
    [rule('be-kind', 'Be kind')],
  );
  const header = await readRealmHeader(session, realm);
  expect(header.rules?.map(item => item.id)).toEqual(['stay']);
  expect(header.rules?.[0]?.title).toEqual({
    value: 'Stay', language: 'en', direction: 'ltr', basis: 'requested',
  });
});

test('invalid managed rules are unreadable while absent and empty documents mean no rules', async () => {
  const staleProfileRules = [rule('stale', 'Stale profile rule')];
  const invalid = headerSession(
    { profile: 'realm-settings-rules-v2', public: true, rules: 'invalid' },
    staleProfileRules,
  );
  expect((await invalid.governance.realmHeaderRules(realm)).rules).toBeNull();
  await expect(readRealmHeader(invalid.session, realm)).rejects.toBeInstanceOf(WorkReadUnavailable);

  const absent = headerSession(null, staleProfileRules);
  expect((await readRealmHeader(absent.session, realm)).rules).toEqual([]);

  const empty = headerSession(
    { profile: 'realm-settings-rules-v2', public: true, rules: [] },
    staleProfileRules,
  );
  expect((await readRealmHeader(empty.session, realm)).rules).toEqual([]);
});
