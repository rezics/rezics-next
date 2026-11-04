import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { checkSubjectStructure } from '@rezics/definitions/validate';
import { createFakeKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';
import { loadSubjectPage, subjectBody } from '../src/features/pages/subject';
import { WORK_NAMES_BYTES, workNames } from '../src/features/catalogue/work-names/model';
import { NAMES_RETURN_BYTES, namesReturn } from '../src/features/catalogue/work-names/navigation';
import { readTermsPageAuthority } from '../src/features/catalogue/subject-terms-request';
import { readSubjectTerms } from '../src/features/catalogue/subject-terms-request';
import { work } from './work-title-variants.test';

test('native-valid complete term sets can exceed the Web presentation budget', () => {
  const s = work(); s.labels = { ja: '名' }; s.aliases = {};
  for (let i = 0; i < 16; i++) s.aliases[`ja-x-${i}`] = Array.from({ length: i === 15 ? 31 : 32 }, (_, j) => `${i}-${j}${'旅'.repeat(240)}`);
  expect(checkSubjectStructure(s).violations).toEqual([]);
  const names = workNames(s, 'ja');
  expect(names.state).toBe('unavailable'); expect(names.bytes).toBeGreaterThan(WORK_NAMES_BYTES);
});

test('composition charges page/action/refresh/Terms response bytes at all three unrelated Subject and obsolete-history scales', async () => {
  const id = fixtures.subjects[0]!.id;
  let previous: unknown;
  for (const size of [64, 512, 4096]) {
    const unrelated = Array.from({ length: size }, (_, i) => ({ ...fixtures.subjects[0]!,
      id: `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`, type: 'schema:Thing', labels: { en: `Unrelated ${i}` }, statements: {} }));
    const local = createFakeKernelFetch({ ...fixtures, subjects: [...fixtures.subjects, ...unrelated] } as never);
    const requests: string[] = []; const responses: number[] = [];
    let actionCount = 0;
    const client = createKernelClient('https://kernel.invalid', { fetch: (async (input, init) => {
      const request = new Request(input, init); const path = new URL(request.url).pathname; requests.push(path);
      const response = path.includes('viewer-actions')
        ? new Response(JSON.stringify(++actionCount === 1 ? { code: 'unavailable' } : { resources: [{ type: 'semantic.context', id: '00000000-0000-0000-0000-000000000001', viewerActions: [] }] }), { status: actionCount === 1 ? 503 : 200, headers: { 'content-type': 'application/json' } })
        : await local(request);
      responses.push(new TextEncoder().encode(await response.clone().text()).length);
      return response;
    }) as typeof fetch });
    const loaded = await loadSubjectPage(client, id, undefined, 'en', { authorization: 'Bearer fixture' });
    expect(loaded.kind).toBe('page'); if (loaded.kind !== 'page') throw Error('Expected page');
    expect(loaded.page.termsAuthority?.actions.state).toBe('unavailable');
    const admitted = subjectBody(loaded.page)!;
    const names = workNames(admitted.subject, 'en'); expect(names.state).toBe('ready');
    await readTermsPageAuthority(client, 'signed-in', 'Bearer fixture'); // the one explicit failed-section refresh
    await readSubjectTerms(client, id, 'en', 'Bearer fixture'); // original Terms candidate, never the names projection
    await readTermsPageAuthority(client, 'signed-in', 'Bearer fixture');
    // Definitions are a separate Terms-owned projection. Charge its bytes as well.
    await client.definitions({ digest: admitted.subject.release }).get();
    const saved = { binding: JSON.stringify([id, 'global', 'en', admitted.subject.release, admitted.subject.revision, 'cache-incarnation']),
      href: `/en/subjects/${id}/title#supplied-names`, window: { query: '心', page: 0, expanded: true, groups: [{ index: 0, page: 0, open: true }] } };
    const obsoleteHistory = Array.from({ length: size }, () => ({ namesReturn: { binding: 'obsolete' } }));
    obsoleteHistory.push({ namesReturn: saved } as never);
    expect(namesReturn(obsoleteHistory.at(-1)!.namesReturn, 'en')).toEqual(saved);
    const returnBytes = new TextEncoder().encode(JSON.stringify(saved)).length;
    expect(returnBytes).toBeLessThanOrEqual(NAMES_RETURN_BYTES);
    expect(requests).toHaveLength(6);
    const accounting = { requests, responses, termBytes: names.bytes, returnBytes, decodeBytes: responses.reduce((a, b) => a + b, 0) };
    if (previous) expect(accounting).toEqual(previous);
    previous = accounting;
  }
});
