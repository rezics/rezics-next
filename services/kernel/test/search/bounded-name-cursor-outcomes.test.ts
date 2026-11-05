import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse } from '../../../../specs/search-driver.ts';
import { createDriverClient } from './support/driver-client.ts';

type Hit = { id: string; labels: Record<string, string>; summary: { label: { value: string } } };
type NativeHit = {
  _id: string;
  _index: string;
  _source: { names: string[]; name_sort: string | null };
  sort: [string | null, string];
};

function page(response: HttpResponse) {
  expect(response.status).toBe(200);
  return response.body as unknown as { subjects: Hit[]; next: string | null };
}

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = performance.now() + 30_000;
  let last: T;
  do {
    last = await read();
    if (ready(last)) return last;
    await Bun.sleep(100);
  } while (performance.now() < deadline);
  throw new Error(`Normal Search projection did not drain: ${JSON.stringify(last)}`);
}

test('legal compatibility ligature names page through the real API with native null sort keys and confidential bounded cursors', async () => {
  const client = createDriverClient();
  try {
    const driver = await client.init();
    const scope = `bounded${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
    const expanded = '\uFDFA'.repeat(250);
    const cjk = '中'.repeat(250);
    const ordinary = `A ${scope}`;
    const labels = new Map<string, string>();
    // Two missing keys force a real continuation *after* a native null key, with an id tie.
    for (const label of [ordinary, cjk, expanded, expanded]) {
      expect(label.length).toBeLessThanOrEqual(250);
      const response = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        { type: 'schema:Book', labels: { en: label }, descriptions: { en: scope } },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      expect(response.status).toBe(201);
      expect(response.headers.get('rezics-session-token')).toBeTruthy();
      const subject = response.body.subject as { id: string; labels: Record<string, string> };
      expect(subject.labels.en).toBe(label);
      labels.set(subject.id, label);
    }
    const search = (extra: Record<string, unknown> = {}) =>
      driver.request('anonymous', 'POST', '/v1/subjects:search', { text: scope, ...extra });
    // This legal API baseline must run before checking additive cursor-profile readiness.
    await eventually(
      async () => page(await search()),
      (result) => result.subjects.length === labels.size && result.subjects.every((hit) => labels.has(hit.id)),
    );
    const observation = await client.inspect();
    expect(observation.workerStats!.registeredModules).toEqual(observation.workerStats!.defaultModules);
    expect(observation.workerStats!.searchStarterInvocations).toBe(1);
    await driver.indexing('paused');

    const cursors: Record<string, unknown> = await import('../../src/tokens/list-cursor.ts');
    const bounds = cursors.LIST_CURSOR_BOUNDS as { search?: { maxTokenLength: number } } | undefined;
    if (!bounds?.search)
      throw new Error('Prerequisite missing: shared encrypted Search cursor profile LIST_CURSOR_BOUNDS.search');
    expect(bounds.search.maxTokenLength).toBe(4864);
    const maxTokenLength = bounds.search.maxTokenLength;

    // Inspect only the service-owned index acknowledged by this real supervisor, as in
    // real-source-composition.test.ts. Never bulk-write a document or supply a sort tuple.
    const owned = client.ledger().resources.find((resource) => resource.kind === 'index_prefix');
    if (!owned || owned.kind !== 'index_prefix') throw new Error('Missing acknowledged native Search index prefix');
    const alias = `${owned.name}subjects`;
    async function native<T>(path: string, body: unknown): Promise<T> {
      const response = await fetch(`${process.env.OPENSEARCH_URL}/${alias}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    }
    const analyzed = await native<{ tokens: { token: string }[] }>('_analyze', {
      normalizer: 'name_key',
      text: expanded,
    });
    expect(analyzed.tokens).toHaveLength(1);
    expect(analyzed.tokens[0]!.token.length).toBeGreaterThan(512);
    const expected = [...labels.keys()].sort((left, right) => {
      const a = labels.get(left)!;
      const b = labels.get(right)!;
      if (a === expanded && b !== expanded) return 1;
      if (a !== expanded && b === expanded) return -1;
      if (a !== b) return a < b ? -1 : 1;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    async function inspectGeneration() {
      const result = await native<{ hits: { hits: NativeHit[] } }>('_search', {
        size: labels.size,
        query: { terms: { id: [...labels.keys()] } },
        sort: [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }],
      });
      expect(result.hits.hits.map((hit) => hit._id)).toEqual(expected);
      for (const hit of result.hits.hits) {
        const label = labels.get(hit._id)!;
        expect(hit._source.names).toContain(label);
        expect(hit.sort).toEqual([
          label === expanded ? null : label === ordinary ? ordinary.toLowerCase() : cjk,
          hit._id,
        ]);
        expect(hit._source.name_sort).toBe(hit.sort[0]);
      }
      // Full exact names remain indexed even though their normalized sort key is absent.
      for (const label of [ordinary, cjk, expanded]) {
        const exact = await native<{ hits: { hits: NativeHit[] } }>('_search', {
          size: labels.size,
          query: { bool: { filter: [{ terms: { id: [...labels.keys()] } }, { term: { 'names.exact': label } }] } },
        });
        expect(exact.hits.hits.map((hit) => hit._id).sort()).toEqual(
          [...labels]
            .filter(([, value]) => value === label)
            .map(([id]) => id)
            .sort(),
        );
      }
      return result.hits.hits[0]!._index;
    }
    async function traverse() {
      const seen: string[] = [];
      let cursor: string | undefined;
      let first: string | undefined;
      for (let index = 0; index < labels.size; index++) {
        const result = page(await search({ sort: 'name', limit: 1, ...(cursor ? { cursor } : {}) }));
        expect(result.subjects).toHaveLength(1);
        const hit = result.subjects[0]!;
        expect(hit.id).toBe(expected[index]!);
        expect(hit.labels.en).toBe(labels.get(hit.id)!);
        expect(hit.summary.label.value).toBe(labels.get(hit.id)!);
        seen.push(hit.id);
        if (index === labels.size - 1) expect(result.next).toBeNull();
        else {
          expect(result.next).toBeString();
          const token = result.next!;
          expect(token.length).toBeLessThanOrEqual(maxTokenLength);
          // Ordinary untrusted decoding, with no signing keys or backend decrypt access.
          for (const segment of token.split('.')) {
            const decoded = Buffer.from(segment, 'base64url').toString('utf8');
            expect(decoded).not.toContain(hit.id);
            expect(decoded).not.toContain(labels.get(hit.id)!);
          }
          cursor = token;
          first ??= token;
        }
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(labels.size);
      return first!;
    }
    const oldIndex = await inspectGeneration();
    const oldCursor = await traverse();
    // This fixture exposes the actual replay/reconciliation/alias-switch control.
    await driver.indexing('running');
    const rebuilt = await driver.rebuild();
    await driver.indexing('paused');
    expect(rebuilt.generation).toBeGreaterThan(0);
    const newIndex = await inspectGeneration();
    expect(newIndex).not.toBe(oldIndex);
    expect(newIndex).toBe(`${owned.name}subjects-g${rebuilt.generation}`);
    const stale = await search({ sort: 'name', limit: 1, cursor: oldCursor });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('search_restart_required');
    await traverse();
  } finally {
    await client.close();
  }
}, 600_000);
