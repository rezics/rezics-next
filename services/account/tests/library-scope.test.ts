import { describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { accountLocales } from '../src/account-settings.ts';
import { thirdPartyConsentDecision } from '../src/consent.ts';
import {
  closedGroupScopes,
  consentScopes,
  discoverOAuthScopeRegistry,
  dynamicRegistrationScopes,
  providerScopes,
  resourceScopes,
} from '../src/oauth-scopes.ts';
import { oauthScopes } from '../src/oauth-scopes/library.ts';
import { reconcileResourceScopes } from '../src/resource-scopes.ts';
import { describeScope, scopeDescriptions } from '../src/scope-descriptions.ts';

test('library mutation scope is discovered once without replacing existing tokens or closed groups', async () => {
  expect(oauthScopes).toEqual(['library:write']);
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(join('.temp', 'library-scope-baseline-'));
  const installed = join(import.meta.dir, '../src/oauth-scopes');
  try {
    for (const file of await readdir(installed)) {
      if (file.endsWith('.ts') && file !== 'library.ts')
        await copyFile(join(installed, file), join(directory, file));
    }
    const baseline = await discoverOAuthScopeRegistry(directory);
    expect(providerScopes.filter((scope) => scope !== 'library:write')).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      ...baseline.scopes,
    ]);
    expect(resourceScopes.filter((scope) => scope !== 'library:write')).toEqual([
      'openid',
      'offline_access',
      ...baseline.scopes,
    ]);
    expect(providerScopes.filter((scope) => scope === 'library:write')).toHaveLength(1);
    expect(resourceScopes.filter((scope) => scope === 'library:write')).toHaveLength(1);
    expect(closedGroupScopes).toEqual(baseline.closedGroupScopes);
    expect(closedGroupScopes).not.toContain('library:write');
    expect(describeScope('work:read').description.en).toBe('Read works');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup installs the new resource scope through the existing reconciliation', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  expect(await reconcileResourceScopes(pool as never, 'https://main.rezics.test')).toBe(true);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('UPDATE "oauthResource"');
  expect(queries[0]!.params).toEqual([JSON.stringify(resourceScopes), 'https://main.rezics.test']);
  expect(JSON.parse(String(queries[0]!.params[0]))).toContain('library:write');
});

test('both client classes can request mutation consent without changing existing requests', () => {
  const requested = ['openid', 'work:read', 'library:write', 'type:admit'];
  expect(consentScopes(requested, false)).toEqual(['openid', 'work:read', 'library:write']);
  expect(consentScopes(requested, true)).toBe(requested);
  expect(dynamicRegistrationScopes(requested)).toEqual(['openid', 'work:read', 'library:write']);
  const readOnly = ['openid', 'work:read'];
  expect(consentScopes(readOnly, false)).toEqual(readOnly);
  expect(dynamicRegistrationScopes(readOnly)).toEqual(readOnly);
  expect(
    thirdPartyConsentDecision(
      { accept: true, oauth_query: 'signed' },
      consentScopes(requested, false),
      true,
    ),
  ).toEqual({ accept: true, oauth_query: 'signed', scope: 'openid work:read library:write' });
  expect(
    thirdPartyConsentDecision({ accept: true, oauth_query: 'signed' }, readOnly, true),
  ).toEqual({ accept: true, oauth_query: 'signed', scope: 'openid work:read' });
  const selected = { accept: true, oauth_query: 'signed', scope: 'openid work:read' };
  expect(thirdPartyConsentDecision(selected, consentScopes(requested, false), true)).toBe(selected);
  const refused = { accept: false, oauth_query: 'signed' };
  expect(thirdPartyConsentDecision(refused, ['library:write'], true)).toBe(refused);
});

// These independent capability clauses keep translations from silently reducing
// mutation consent to only shelving or only reading settings.
const boundaryClauses = {
  en: [
    'Change',
    'your library',
    'reading records',
    'shelves',
    'statuses',
    'private reviews',
    'goals',
    'copies',
    'loans',
    'imports',
    'reading sessions',
    'reading settings',
  ],
  'zh-Hans': [
    '更改',
    '你的书库',
    '阅读记录',
    '书架',
    '阅读状态',
    '私人书评',
    '阅读目标',
    '副本',
    '借阅',
    '导入',
    '阅读会话',
    '阅读设置',
  ],
  'zh-Hant': [
    '變更',
    '你的書庫',
    '閱讀紀錄',
    '書架',
    '閱讀狀態',
    '私人書評',
    '閱讀目標',
    '副本',
    '借閱',
    '匯入',
    '閱讀工作階段',
    '閱讀設定',
  ],
  ja: [
    '変更',
    'あなたのライブラリ',
    '読書記録',
    '本棚',
    '読書状況',
    '非公開のレビュー',
    '読書目標',
    'コピー',
    '貸し借り',
    'インポート',
    '読書セッション',
    '読書設定',
  ],
  ko: [
    '변경',
    '내 라이브러리',
    '독서 기록',
    '책장',
    '독서 상태',
    '비공개 리뷰',
    '독서 목표',
    '사본',
    '대출',
    '가져오기',
    '독서 세션',
    '독서 설정',
  ],
  de: [
    'ändern',
    'Ihre Bibliothek',
    'Leseaufzeichnungen',
    'Regale',
    'Lesestatus',
    'private Rezensionen',
    'Leseziele',
    'Exemplare',
    'Ausleihen',
    'Importe',
    'Lesesitzungen',
    'Leseeinstellungen',
  ],
  fr: [
    'Modifier',
    'votre bibliothèque',
    'données de lecture',
    'étagères',
    'statuts de lecture',
    'critiques privées',
    'objectifs de lecture',
    'exemplaires',
    'prêts',
    'imports',
    'sessions',
    'paramètres de lecture',
  ],
  es: [
    'Modificar',
    'tu biblioteca',
    'registros de lectura',
    'estantes',
    'estados de lectura',
    'reseñas privadas',
    'objetivos de lectura',
    'ejemplares',
    'préstamos',
    'importaciones',
    'sesiones de lectura',
    'ajustes de lectura',
  ],
} as const;

describe('complete personal-library mutation consent in every locale', () => {
  const item = scopeDescriptions.find((item) => item.scope === 'library:write')!;
  test('publishes all eight existing interface locales and the launch meaning', () => {
    expect(item).toBeDefined();
    expect(Object.keys(item.description).sort()).toEqual([...accountLocales].sort());
    expect(item.description.en).toBe(
      'Change your library and reading records: shelves and statuses, private reviews and goals, copies and loans, imports, reading sessions and reading settings.',
    );
  });
  for (const locale of accountLocales) {
    test(`${locale} describes the whole mutation boundary`, () => {
      const text = item.description[locale];
      for (const clause of boundaryClauses[locale]) expect(text).toContain(clause);
      expect(text).not.toContain('library:write');
      expect(text).not.toContain('{n}');
    });
  }
});
