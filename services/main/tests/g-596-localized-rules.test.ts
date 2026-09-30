import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { GovernanceRules, currentRealmRulesDocument, publicRealmRules }
  from '../src/modules/governance/rules.ts';
import { readRealmSettings, saveRealmSettings } from '../src/modules/access/realm-management-settings.ts';
import { RealmAdminConflict, RealmAdminInvalid, RealmAdminStale, settingsCommand,
  type SettingsCommand } from '../src/modules/realm-admin/contract.ts';
import { selectDisplayName, type LocalizedText } from '../src/modules/display-language/select.ts';
import { currentProfile } from '../src/modules/realm-profile/schema.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const rule = { id: 'kind', title: { original: 'ja', labels: { ja: '親切に', ko: '친절하게' } },
  body: { original: 'ja', labels: { ja: '読者を尊重する\n丁寧に話す', ko: '독자를 존중하세요' } }, governanceRule: null };
const command = (): SettingsCommand => ({ actingSubject: actor, expectedGeneration: '0',
  expectedRulesRevision: null, reason: 'Publish native rules', settings: { visibility: 'public',
    reviewRequired: false, whoMaySubmit: 'members', rules: [structuredClone(rule)] } });
const legacy = (same: boolean) => ({ profile: 'realm-settings-rules-v1', public: true,
  rules: [{ id: 'kind', title: { en: 'Be kind', 'zh-CN': same ? 'Be kind' : '友善' },
    body: { en: 'Respect readers', 'zh-CN': same ? 'Respect readers' : '尊重读者' }, governanceRule: null }] });

// A strict owner-storage double runs the actual settings and immutable-publication
// implementations. PostgreSQL transaction/authority coverage stays in realm-admin-api.
function storage(initial?: unknown) {
  type Revision = { ref: string; revision: string; scope_id: string; digest: string;
    document: unknown; request_digest: string };
  let head: Revision | undefined = initial === undefined ? undefined : {
    ref: '', revision: '7', scope_id: `governance:realm:${realm}`, digest: 'legacy-digest',
    document: initial, request_digest: '' };
  const revisions = new Map<string, Revision>();
  let settingsRow: Record<string, unknown> | undefined;
  let settingsWrites = 0;
  let revisionWrites = 0;
  const query = async (sql: string, values: unknown[] = []) => {
    const rows = (items: unknown[]) => ({ rows: items, rowCount: items.length });
    if (sql.includes('FROM access.realm_admin_settings')) return rows(settingsRow ? [settingsRow] : []);
    if (sql.includes('FROM access.recovery_fence f')) return rows([{ open: true, document: head?.document }]);
    if (sql.includes('JOIN access.governance_rule_revision')) return rows(head ? [head] : []);
    if (sql.includes('SELECT pg_advisory_xact_lock')) return rows([]);
    if (sql.includes('WHERE principal_id = $1 AND idempotency_key = $2')) {
      const prior = revisions.get(`${values[0]}:${values[1]}`);
      return rows(prior ? [prior] : []);
    }
    if (sql.includes('FROM access.governance_rule_head')) return rows(head ? [head] : []);
    if (sql.includes('INSERT INTO access.governance_rule_head') || sql.includes('UPDATE access.governance_rule_head')) return rows([]);
    if (sql.includes('INSERT INTO access.governance_rule_revision')) {
      head = { ref: String(values[0]), revision: String(values[1]), scope_id: String(values[2]),
        digest: String(values[3]), document: JSON.parse(String(values[4])) as unknown,
        request_digest: String(values[8]) };
      revisions.set(`${values[5]}:${values[7]}`, head);
      revisionWrites++;
      return rows([]);
    }
    if (sql.includes('INSERT INTO access.realm_admin_settings')) {
      settingsRow = { who_may_submit: values[1], visibility: values[2], review_mode: values[3], self_join: values[4] };
      settingsWrites++;
      return rows([]);
    }
    throw new Error(`Unexpected owner query: ${sql}`);
  };
  return { client: { query } as unknown as PoolClient, pool: { query } as unknown as Pool,
    document: () => head?.document, writes: () => ({ settingsWrites, revisionWrites }) };
}

test('G-596 rules publish ja with a ko translation, preserve multiline text, select language/direction and replay one revision', async () => {
  const input = command();
  expect(Value.Check(settingsCommand, input)).toBe(true);
  const db = storage();
  const saved = await saveRealmSettings(db.client, realm, 'principal', input, 'native-rules');
  expect(db.document()).toEqual({ profile: 'realm-settings-rules-v2', public: true, rules: input.settings.rules });
  expect(Value.Check(publicRealmRules, db.document())).toBe(true);
  const read = await readRealmSettings(db.client, realm);
  expect(read.ruleBasis).toEqual(saved.ruleBasis);
  expect(read.settings.rules).toEqual(input.settings.rules);
  const published = await new GovernanceRules(db.pool).publishedRealmRules(realm);
  expect(published).toEqual(input.settings.rules);
  expect(selectDisplayName(published![0]!.title, ['ja'])).toEqual({
    value: '親切に', language: 'ja', direction: 'ltr', basis: 'requested' });
  expect(selectDisplayName(published![0]!.title, ['ko'])).toEqual({
    value: '친절하게', language: 'ko', direction: 'ltr', basis: 'requested' });
  expect(await saveRealmSettings(db.client, realm, 'principal', input, 'native-rules')).toEqual(saved);
  expect(db.writes().revisionWrites).toBe(1);
  await expect(saveRealmSettings(db.client, realm, 'principal', { ...input,
    settings: { ...input.settings, rules: [{ ...rule, title: { original: 'ar', labels: { ar: 'كن لطيفاً' } } }] } },
  'native-rules')).rejects.toBeInstanceOf(RealmAdminConflict);
  await expect(saveRealmSettings(db.client, realm, 'principal', input, 'another-command'))
    .rejects.toBeInstanceOf(RealmAdminStale);
  expect(db.writes()).toEqual({ settingsWrites: 2, revisionWrites: 1 });
});

for (const same of [true, false]) test(`G-596 v1 ${same ? 'duplicated' : 'translated'} rules normalize on both reads without rewriting`, async () => {
  const document = legacy(same);
  const db = storage(document);
  const settings = await readRealmSettings(db.client, realm);
  const published = await new GovernanceRules(db.pool).publishedRealmRules(realm);
  expect(settings.settings.rules).toEqual(published!);
  expect(published![0]!.title).toEqual(same ? { original: 'und', labels: { und: 'Be kind' } }
    : { original: 'en', labels: { en: 'Be kind', 'zh-Hans': '友善' } });
  expect(published![0]!.body).toEqual(same ? { original: 'und', labels: { und: 'Respect readers' } }
    : { original: 'en', labels: { en: 'Respect readers', 'zh-Hans': '尊重读者' } });
  expect(selectDisplayName(published![0]!.title, ['en'])?.language).toBe(same ? 'und' : 'en');
  expect(settings.ruleBasis).toMatchObject({ revision: '7', digest: 'legacy-digest' });
  expect(db.document()).toEqual(document);
  expect(db.writes()).toEqual({ settingsWrites: 0, revisionWrites: 0 });
});

test('G-596 legacy conversion is per field and private rules remain fenced', async () => {
  const document = legacy(false);
  document.rules[0]!.title['zh-CN'] = document.rules[0]!.title.en;
  document.public = false;
  const db = storage(document);
  expect(await new GovernanceRules(db.pool).publishedRealmRules(realm)).toBeNull();
  const rules = await new GovernanceRules(db.pool).publishedRealmRules(realm, true);
  expect(rules![0]!.title.original).toBe('und');
  expect(rules![0]!.body.labels['zh-Hans']).toBe('尊重读者');
  const profile = currentProfile({ name: { en: 'Readers', 'zh-CN': '读者' },
    description: { en: 'Books', 'zh-CN': '书' }, iconSelection: null, bannerSelection: null,
    rules: legacy(true).rules, count: { kind: 'unknown', value: null }, moderators: [] });
  expect(profile.rules[0]!.title).toEqual({ original: 'und', labels: { und: 'Be kind' } });
});

test('G-596 commands reject legacy maps and malformed, empty, duplicate or oversized localized rules before mutation', async () => {
  expect(Value.Check(settingsCommand, { ...command(), settings: {
    ...command().settings, rules: legacy(false).rules } })).toBe(false);
  const db = storage();
  const invalidTitles: LocalizedText[] = [{ original: 'ja', labels: {} }, { original: 'ko', labels: { ja: 'Title' } },
    { original: 'ja', labels: { ja: ' ' } }, { original: 'xx-invalid-tag', labels: { 'xx-invalid-tag': 'Title' } },
    { original: 'zh-cn', labels: { 'zh-cn': 'Title' } }, { original: 'ja', labels: { ja: 'X'.repeat(101) } }];
  for (const title of invalidTitles) {
    const input = command();
    input.settings.rules[0]!.title = title;
    await expect(saveRealmSettings(db.client, realm, 'principal', input, 'invalid'))
      .rejects.toBeInstanceOf(RealmAdminInvalid);
  }
  for (const rules of [[rule, rule], Array.from({ length: 13 }, (_, index) => ({ ...rule, id: `rule-${index}` }))]) {
    const input = command();
    input.settings.rules = rules;
    await expect(saveRealmSettings(db.client, realm, 'principal', input, 'invalid'))
      .rejects.toBeInstanceOf(RealmAdminInvalid);
  }
  const input = command();
  input.settings.rules = Array.from({ length: 12 }, (_, index) => ({ ...rule, id: `rule-${index}`,
    body: { original: 'ja', labels: { ja: 'あ'.repeat(1000) } } }));
  await expect(saveRealmSettings(db.client, realm, 'principal', input, 'over-budget'))
    .rejects.toBeInstanceOf(RealmAdminInvalid);
  expect(db.writes()).toEqual({ settingsWrites: 0, revisionWrites: 0 });
  expect(() => currentRealmRulesDocument({ profile: 'unrelated', public: true, rules: [] })).toThrow();
  expect((await readRealmSettings(db.client, realm)).settings.rules).toEqual([]);
});
