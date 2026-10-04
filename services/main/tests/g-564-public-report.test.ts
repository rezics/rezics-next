import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { addBusinessDays, categoryProcesses, publicReportInput, reportCategory, validContentLanguage } from '../src/modules/public-report/contract.ts';
import { capabilityBases } from '../src/modules/target/contract.ts';
import { openApiOperations } from '../src/routes/public-reports.ts';
import { mandatoryPurposes, optionalPurposes } from '../src/modules/notification/schema.ts';
import { reportAddress } from '../src/modules/public-report/owners.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { Pool } from 'pg';
import { withPreservationFence, type PreservationFence } from '../src/modules/public-report/preservation.ts';

test('G-564: every closed category has a process and every admitted base supports reporting', () => {
  const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  for (const [category, mapping] of Object.entries(categoryProcesses)) {
    expect(mapping.process.length).toBeGreaterThan(0);
    expect(Value.Check(publicReportInput, { profile: 'public-report-v1', category, target,
      statement: 'Reported context', contentLanguage: 'sw-KE' })).toBe(true);
  }
  expect(reportCategory.anyOf.map(item => String(item.const)).sort()).toEqual(Object.keys(categoryProcesses).sort());
  expect(Value.Check(publicReportInput, { profile: 'public-report-v1', category: 'invented', target,
    statement: 'Reported context', contentLanguage: 'sw-KE' })).toBe(false);
  expect(capabilityBases.report).toEqual(['work', 'realization', 'release', 'occurrence', 'resource', 'projection']);
  expect(Object.entries(categoryProcesses).filter(([, item]) => item.urgent).map(([key]) => key))
    .toEqual(['child_exploitation', 'ncii', 'credible_threat']);
});

test('G-564: intake, status and correspondence cannot acquire a bearer requirement', () => {
  expect(openApiOperations['/v1/public-reports'].post.bearer).toBe(false);
  expect(openApiOperations['/v1/public-reports/{caseId}'].get.bearer).toBe(false);
  expect(openApiOperations['/v1/public-reports/{caseId}/correspondence'].post.bearer).toBe(false);
  expect(optionalPurposes).toEqual(['social', 'subscription']);
  expect(mandatoryPurposes).toContain('governance');
});

test('G-564: original languages and business-day deadlines survive non-UI tags and weekends', () => {
  for (const tag of ['sw-KE', 'fa', 'zh-Hant-TW', 'en-US-u-ca-gregory', 'x-victim', 'i-klingon', 'zh-cmn-Hans-CN']) {
    expect(validContentLanguage(tag)).toBe(true);
  }
  for (const tag of ['', 'garbage_language', 'en--US', 'en-US-US', 'English (US)', 'sl-rozaj-rozaj', 'en-u-ca-gregory-u-nu-latn']) {
    expect(validContentLanguage(tag)).toBe(false);
  }
  const friday = new Date('2026-10-02T14:37:12Z');
  expect(addBusinessDays(friday, 10).toISOString()).toBe('2026-10-16T14:37:12.000Z');
  expect(addBusinessDays(friday, 14).toISOString()).toBe('2026-10-22T14:37:12.000Z');
  expect(friday.toISOString()).toBe('2026-10-02T14:37:12.000Z');
  expect(() => addBusinessDays(friday, -1)).toThrow(RangeError);
});

test('G-564: URL intake never performs a network fetch for an arbitrary caller address', async () => {
  for (const value of ['http://127.0.0.1/admin', 'https://example.com/works/a',
    'https://rezics.com@evil.test/id/a', 'https://rezics.com/works/a?credential=secret']) {
    await expect(reportAddress({} as MainWorkDependencies, value)).rejects.toThrow();
  }
  expect(await reportAddress({} as MainWorkDependencies,
    'https://rezics.com/media/assets/00000000-0000-4000-8000-000000000001'))
    .toBe('https://rezics.com/id/00000000-0000-4000-8000-000000000001');
});

test('G-564: a nested preservation fence cannot escape its transaction or authorize another target', async () => {
  const queries: string[] = [];
  const pool = { connect: async () => ({
    query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
    release() {},
  }) } as unknown as Pool;
  let retained: PreservationFence | undefined;
  const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const result = await withPreservationFence(pool, target, 'outer', async fence => {
    retained = fence;
    await expect(withPreservationFence(fence, 'another-target', 'wrong', async () => 0)).rejects.toThrow();
    return withPreservationFence(fence, target, 'nested', async () => 42);
  });
  expect(result).toEqual({ held: false, value: { held: false, value: 42 } });
  expect(queries.filter(sql => sql === 'BEGIN')).toHaveLength(1);
  await expect(withPreservationFence(retained!, target, 'expired', async () => 0)).rejects.toThrow();
});
