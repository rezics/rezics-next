import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import subjects from '../../db/search/indices/subjects.json';
import { decodeSearchCursor, encodeSearchCursor, type SearchSortValue } from '../../src/search/cursor.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { LIST_CURSOR_BOUNDS } from '../../src/tokens/list-cursor.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const issued = 1_800_000_000_000;
const id = '018f0000-0000-7000-8000-00a000000042';
const binding = {
  operation: 'subjects.search',
  request: { text: 'confidentiality', sort: 'name', limit: 1 },
  principal: 'anonymous',
};

// An ordinary client can decode every wire segment without keys or backend access.
function disclosed(token: string, secrets: string[]): string[] {
  const views = [token, ...token.split('.').map((part) => Buffer.from(part, 'base64url').toString('utf8'))];
  return secrets.filter((secret) => views.some((view) => view.includes(secret)));
}

test('cursor confidentiality: rejected sort name and id cannot be recovered by base64 decoding', async () => {
  const secret = 'withheld-secret-normalized-name';
  const after = [secret, id];
  const token = await encodeSearchCursor(ring, binding, { generation: 3, after }, issued);
  expect(await decodeSearchCursor(ring, binding, token, issued)).toEqual({ ok: true, generation: 3, after });
  expect(disclosed(token, [secret, id])).toEqual([]);
});

test('backend cursor decoding preserves finite numbers, null, positive and negative zero exactly', async () => {
  const after: SearchSortValue[] = [12.75, -1.25, Number.MAX_VALUE, Number.MIN_VALUE, null, 0, -0, id];
  const token = await encodeSearchCursor(ring, binding, { generation: 3, after }, issued);
  const decoded = await decodeSearchCursor(ring, binding, token, issued);
  expect(decoded).toEqual({ ok: true, generation: 3, after });
  if (!decoded.ok) throw new Error('Backend rejected its own cursor');
  for (let index = 0; index < after.length; index++) expect(Object.is(decoded.after[index], after[index])).toBe(true);
});

test('opaque cursors retain canonical request, principal and operation binding', async () => {
  const after = ['private-sort-key', id];
  const token = await encodeSearchCursor(ring, binding, { generation: 3, after }, issued);
  const reordered = { ...binding, request: { limit: 1, sort: 'name', text: 'confidentiality' } };
  expect(await decodeSearchCursor(ring, reordered, token, issued)).toEqual({ ok: true, generation: 3, after });
  for (const changed of [
    { ...binding, request: { ...binding.request, text: 'different' } },
    { ...binding, principal: `account:${id}` },
    { ...binding, operation: 'subjects.suggest' },
  ]) {
    expect(await decodeSearchCursor(ring, changed, token, issued)).toEqual({ ok: false, reason: 'invalid' });
  }
});

for (const principal of ['anonymous', `account:${id}`]) {
  test(`search cursors expire after fifteen minutes for ${principal}`, async () => {
    const scope = { ...binding, principal };
    const after = ['private-sort-key', id];
    const token = await encodeSearchCursor(ring, scope, { generation: 3, after }, issued);
    expect(await decodeSearchCursor(ring, scope, token, issued + 15 * 60_000)).toEqual({
      ok: true,
      generation: 3,
      after,
    });
    expect(await decodeSearchCursor(ring, scope, token, issued + 15 * 60_000 + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
}

for (const name of ['秘'.repeat(100), 'k'.repeat(2100)]) {
  test(`cursor key boundary: preserve the complete ${Buffer.byteLength(name)}-byte raw sort key`, async () => {
    // Codec boundary coverage, not a claim that a 2100-character label passes Semantic writes.
    // Truncating or hashing this key changes OpenSearch search_after ordering.
    expect(Buffer.byteLength(name)).toBeGreaterThan(256);
    const after = [name, id];
    const token = await encodeSearchCursor(ring, binding, { generation: 3, after }, issued);
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(LIST_CURSOR_BOUNDS.search.maxTokenLength);
    expect(await decodeSearchCursor(ring, binding, token, issued)).toEqual({ ok: true, generation: 3, after });
    expect(disclosed(token, [name, id])).toEqual([]);
  });
}

test('pinned OpenSearch ICU normalization can expand a bounded identity into a long cursor key', async () => {
  if (!process.env.OPENSEARCH_URL) throw new Error('OPENSEARCH_URL must name the check node');
  const search = createOpenSearch(process.env.OPENSEARCH_URL);
  const index = `test-cursor-normalization-${randomUUID()}`;
  // U+FDFA expands under NFKC_CF; the input stays within 250 UTF-16 code units.
  const label = '\uFDFA'.repeat(60);
  expect(label.length).toBeLessThanOrEqual(250);
  await search.request('PUT', `/${index}`, subjects);
  try {
    const analyzed = await search.request<{ tokens: { token: string }[] }>('POST', `/${index}/_analyze`, {
      normalizer: 'name_key',
      text: label,
    });
    expect(analyzed.body.tokens).toHaveLength(1);
    const name = analyzed.body.tokens[0]!.token;
    expect(Buffer.byteLength(name)).toBeGreaterThan(256);
    const after = [name, id];
    const token = await encodeSearchCursor(ring, binding, { generation: 3, after }, issued);
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(LIST_CURSOR_BOUNDS.search.maxTokenLength);
    expect(await decodeSearchCursor(ring, binding, token, issued)).toEqual({ ok: true, generation: 3, after });
    expect(disclosed(token, [name, id])).toEqual([]);
  } finally {
    await search.request('DELETE', `/${index}`);
  }
});
