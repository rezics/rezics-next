import { expect, test } from 'bun:test';
import { runCliConversionDiagnosticsJourney } from './cli-conversion-diagnostics-fixture.ts';

test('operator reviews retained Open Library field omissions and returns through a corrected source import', async () => {
  const r = await runCliConversionDiagnosticsJourney();
  try {
    expect(r.interrupted.code).toBe(130);
    expect(r.interrupted.openHandles).toBe(0);
    expect(r.stagedReview.coverage).toBe('recorded');
    expect(r.stagedReview.records.flatMap((row) => row.diagnostics)).toContainEqual({
      pointer: '/publish_date',
      code: 'unsupported_publication_date_format',
    });
    expect(r.resumed.code).toBe(0);
    expect(r.corrected.code).toBe(0);
    expect(r.originalRequests.length).toBeGreaterThan(0);
    expect(r.subjectId).toMatch(/^[0-9a-f-]{36}$/);
    const names = r.subject.statements['schema:name'] ?? [];
    expect(JSON.stringify(names)).toContain('Glass Atlas');
    const isbn = r.subject.statements['schema:isbn'] ?? [];
    expect(JSON.stringify(isbn)).toContain('9780306406157');
    const published = r.subject.statements['schema:datePublished'] ?? [];
    expect(published.length).toBeGreaterThan(0);
    expect(JSON.stringify(published)).toContain('1980');
  } finally {
    await r.close();
  }
}, 1_800_000);
