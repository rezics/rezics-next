import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { validateRuleLabelPage } from '../src/library/collection-rule-label-input';
import { loadRuleChoices } from '../src/library/collection-rule-read';

test('rule label action bounds raw input separately and validates the native normalized prefix', () => {
  expect(validateRuleLabelPage({ q: ' e\u0301\u00a0 x ', cursor: 'next' })).toEqual({ q: 'é x', cursor: 'next' });
  expect(validateRuleLabelPage({ q: '😀'.repeat(100) }).q).toBe('😀'.repeat(100));
  expect(validateRuleLabelPage({ q: ' '.repeat(1000) }).q).toBe('');
  for (const q of [' '.repeat(1001), 'a'.repeat(101), 'x\u0000', '\ud800'])
    expect(() => validateRuleLabelPage({ q })).toThrow();
});

test('direct rule choice reads use normalized prefixes and never look up invalid input', async () => {
  const queries: string[] = [];
  const client = createKernelClient('https://kernel.test', { fetch: async (input) => {
    const url = new URL(new Request(input).url);
    if (url.pathname === '/v1/libraryLabels') {
      queries.push(url.searchParams.get('q')!);
      return Response.json({ labels: [], next: null });
    }
    return Response.json({}, { status: 503 });
  } });
  await loadRuleChoices(client, 'Bearer owner', { q: ' e\u0301 ' });
  for (const q of ['😀'.repeat(101), 'x\u0001', ' '.repeat(1001)])
    expect((await loadRuleChoices(client, 'Bearer owner', { q })).labels.state).toBe('unavailable');
  expect(queries).toEqual(['é']);
});
