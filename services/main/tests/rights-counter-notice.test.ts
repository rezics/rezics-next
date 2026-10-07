import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { addBusinessDays } from '../src/modules/public-report/contract.ts';
import {
  assertCounterNoticeRestoration,
  assertNoParallelRestriction,
  partyDeclarations,
  recordCounterNotice,
} from '../src/modules/rights/counter-notice.ts';
import { GovernanceInvalid, GovernanceStale } from '../src/modules/governance/store.ts';
import { safetyDecisionMessage } from '../../account/src/email-safety.ts';

test('Counter-notice windows preserve UTC delivery time and skip weekends', () => {
  for (const delivered of [
    '2026-10-02T14:37:12Z',
    '2026-10-03T14:37:12Z',
    '2026-10-04T14:37:12Z',
  ]) {
    expect(addBusinessDays(new Date(delivered), 10).toISOString()).toBe('2026-10-16T14:37:12.000Z');
    expect(addBusinessDays(new Date(delivered), 14).toISOString()).toBe('2026-10-22T14:37:12.000Z');
  }
});

test('Only the submitting party sees its contact and signature declarations', () => {
  const declaration = {
    signature: 'private signature',
    name: 'private name',
    address: 'private address',
    phone: 'private phone',
    courtJurisdiction: 'private jurisdiction',
    materialLocation: 'public location',
    goodFaithMistakeUnderPerjury: true,
    consentToJurisdiction: true,
    acceptService: true,
    futurePrivateField: 'secret',
  };
  expect(partyDeclarations('counter_notice', declaration, true)).toEqual(declaration);
  expect(partyDeclarations('counter_notice', declaration, false)).toEqual({
    materialLocation: 'public location',
    goodFaithMistakeUnderPerjury: true,
    consentToJurisdiction: true,
    acceptService: true,
  });
  expect(
    partyDeclarations('intake', { claimantAddress: 'secret', claimedWork: 'Original work' }, false),
  ).toEqual({ claimedWork: 'Original work' });
});

test('An unsigned authenticated counter-notice cannot enter the shared operation', async () => {
  await expect(
    recordCounterNotice({} as PoolClient, {
      caseId: 'case',
      reportId: 'report',
      statement: 'Mistake',
      contentLanguage: 'en',
      declarations: {} as never,
      key: 'key',
      requestDigest: 'digest',
      now: new Date(),
    }),
  ).rejects.toBeInstanceOf(GovernanceInvalid);
});

test('Restoration requires confirmed delivery and rejects the court-filing stay', async () => {
  const now = new Date('2026-10-22T14:37:12Z');
  let eligible = false;
  const statements: string[] = [];
  const client = {
    query: async (sql: string, args: unknown[]) => {
      statements.push(sql);
      if (sql.includes('FROM access.rights_complaint')) return { rowCount: 1, rows: [] };
      expect(args).toEqual(['case', 'restriction', now]);
      expect(sql).toContain('delivered_at IS NOT NULL');
      expect(sql).toContain("step = 'claimant_action'");
      return { rowCount: eligible ? 1 : 0, rows: [] };
    },
  } as unknown as PoolClient;
  await expect(
    assertCounterNoticeRestoration(client, 'case', 'restriction', now),
  ).rejects.toBeInstanceOf(GovernanceStale);
  eligible = true;
  await assertCounterNoticeRestoration(client, 'case', 'restriction', now);
  expect(statements).toHaveLength(4);
});

test('A restriction in any scope or context blocks a release of the same grain', async () => {
  const target = { owner: 'content', resource: 'asset', component: 'body', revision: 'revision' };
  const client = {
    query: async (sql: string, args: unknown[]) => {
      expect(args).toEqual(['content', 'asset', 'body', 'revision', 'original']);
      expect(sql).not.toContain('authority_scope_id =');
      expect(sql).toContain('revision IS NULL OR $4::text IS NULL OR revision = $4');
      return { rowCount: 1, rows: [] };
    },
  } as unknown as PoolClient;
  await expect(assertNoParallelRestriction(client, target, 'original')).rejects.toThrow(
    'Another active restriction',
  );
});

test('Mandatory claimant mail includes the full signed counter-notice and the filing response route in every locale', () => {
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
    const message = safetyDecisionMessage(locale, {
      caseId: 'case',
      outcome: 'counter_notice',
      credential: 'claimant-secret',
      counterNotice: {
        statement: 'Misidentified material',
        declaration: '{"signature":"Subscriber"}',
      },
    });
    expect(message).toContain('Misidentified material');
    expect(message).toContain('Subscriber');
    expect(message).toContain('claimant-secret');
    expect(message).toContain('10');
    expect(message).toContain('POST /v1/public-reports/case/correspondence');
    expect(message).not.toContain('undefined');
  }
});
