import { expect, test } from 'bun:test';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

const work = {
  type: { key: '/type/work' },
  key: '/works/OL1W',
  revision: 1,
  title: 'Known native work',
  last_modified: { value: '2025-01-02T03:04:05' },
};
const edition = {
  type: { key: '/type/edition' },
  key: '/books/OL1M',
  revision: 1,
  title: 'Native edition',
  last_modified: { value: '2025-01-02T03:04:05' },
  works: [{ key: work.key }],
  authors: [{ key: '/authors/OL1A' }],
};
const relation = 'schema:exampleOfWork';
type Candidate = { id: string; statement: BatchStatement; revision: number; retracted: number | null };
type Propose = Extract<BatchCommand, { op: 'propose' }>;
const owner = (key: string) => ({ source: 'openlibrary', external_id: key });
function dump(records: readonly (typeof work | typeof edition)[]): Dump {
  return {
    source: 'openlibrary',
    snapshot: 'native-reference-control',
    converterRevision: converter_revision,
    bytes: new TextEncoder().encode(
      records
        .map((r) => [r.type.key, r.key, r.revision, r.last_modified.value, JSON.stringify(r)].join('\t'))
        .join('\n') + '\n',
    ),
  };
}
const commands = (run: Run) => run.exchanges.flatMap((e) => (e.request.body as { commands: BatchCommand[] }).commands);
function proposal(run: Run, property: string) {
  return commands(run).find(
    (c): c is Propose =>
      c.op === 'propose' && c.source.external_id === edition.key && c.statement.property.id === property,
  );
}
function completed(run: Run) {
  expect(run.outcome).toBe('complete');
  for (const exchange of run.exchanges) {
    expect(exchange.response.status).toBe(200);
    for (const result of (exchange.response.body as BatchWriteResult).results) expect(result.status).toBeLessThan(400);
  }
}
// Point-read only the successful own binding, and retain its actual public claim response.
function claim(runtime: ApiRuntime, run: Run, key: string) {
  const create = commands(run).find((c) => c.op === 'create' && c.source.external_id === key);
  expect(create).toBeDefined();
  const result = run.exchanges
    .flatMap((e) => (e.response.body as BatchWriteResult).results)
    .find((r) => r.key === create!.key);
  if (!result || !('value' in result) || !('id' in result.value)) throw new Error('Missing real claim response');
  expect([200, 201]).toContain(result.status);
  const binding = runtime.importer.session.bindings.claim(owner(key));
  expect(binding).toEqual({ state: 'bound', subject: result.value.id });
  return { id: result.value.id, response: result, binding };
}
function unresolved(statement: BatchStatement, key: string) {
  expect(statement.value).toEqual({ type: 'somevalue' });
  expect(statement.qualifiers).toContainEqual({
    property: { id: 'wdt:P648' },
    value: { type: 'value', content: key.split('/').at(-1) },
  });
}
async function open() {
  // Same construction as the platform API controls: no identifierLookup callback.
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const editor = await openApiObserver(runtime);
    async function candidates(id: string, property: string, context?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({
          property,
          limit: '100',
          ...(context ? { context } : {}),
        })}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body.candidates as Candidate[];
    }
    return { runtime, editor, candidates };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

test('an importer reference resolves only through actual known native claims without invented identity or revision', async () => {
  const { runtime, editor, candidates } = await open();
  try {
    const first = await runtime.run(dump([work]));
    completed(first);
    const known = claim(runtime, first, work.key);
    // A complete dump retains the work; no accidental disappearance/retraction control.
    const second = await runtime.run(dump([work, edition]));
    completed(second);
    const book = claim(runtime, second, edition.key);
    const author = proposal(second, 'schema:author');
    expect(author).toBeDefined();
    unresolved(author!.statement, '/authors/OL1A');
    expect(runtime.importer.session.bindings.claim(owner('/authors/OL1A'))).toBeNull();
    const rows = await candidates(book.id, relation);
    expect(rows).toHaveLength(1);
    const resolved = proposal(second, relation);
    expect(resolved).toBeDefined();
    expect(resolved!.source.record_revision).toBe('1');
    expect(resolved!.source.converter_revision).toBe(converter_revision);
    // Expected red on the default platform path: knowing the own claim is not handed to conversion.
    expect(resolved!.statement.value).toEqual({ type: 'value', content: known.id });
    expect(rows[0]!.statement.value).toEqual({ type: 'value', content: known.id });
    // Use only the retrieved candidate; never synthesize a manual replacement to make adoption pass.
    await editor.adopt('openlibrary', edition.key, relation, known.id);
    completed(await runtime.run(dump([work, edition])));
    expect(await candidates(book.id, relation)).toEqual(rows);
    await runtime.identity.setBulkPermission(false);
    const exchange = second.exchanges.find((e) => e.request.keys.includes(resolved!.key))!;
    const denied = await runtime.replay(
      new Request(exchange.request.url, {
        method: exchange.request.method,
        headers: exchange.request.headers,
        body: exchange.request.serializedBody,
      }),
    );
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(known.id);
    expect(runtime.importer.session.bindings.claim(owner(work.key))).toEqual(known.binding);
    expect(await candidates(book.id, relation)).toEqual(rows);
  } finally {
    await runtime.close();
  }
}, 600_000);

test('the same session refreshes an unchanged native edition after learning its real work claim', async () => {
  const { runtime, editor, candidates } = await open();
  try {
    const first = await runtime.run(dump([edition]));
    completed(first);
    const book = claim(runtime, first, edition.key);
    const old = proposal(first, relation)!;
    unresolved(old.statement, work.key);
    const before = await candidates(book.id, relation);
    expect(before).toHaveLength(1);
    const oldCandidate = before[0]!;
    const contextResponse = await editor.http('/v1/contexts', { labels: { en: 'Native reference review' } });
    expect(contextResponse.status).toBe(201);
    const context = (contextResponse.body.context as { id: string }).id;
    async function adopt(candidate: string) {
      const listing = await editor.http(
        `/v1/subjects/${book.id}/candidates?${new URLSearchParams({
          property: relation,
          context,
          limit: '100',
        })}`,
      );
      expect(listing.status).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${book.id}/candidates/${candidate}:accept`, {
            context,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${book.id}:adopt`, {
            context,
            property: relation,
            mode: 'replace',
            selection: [{ candidate, rank: 'normal' }],
            expected_head: (listing.body.adoption as { head: number } | null)?.head ?? null,
          })
        ).status,
      ).toBe(200);
    }
    await adopt(oldCandidate.id);
    const learned = await runtime.run(dump([edition, work]));
    completed(learned);
    const known = claim(runtime, learned, work.key);
    expect(runtime.importer.session.bindings.claim(owner(work.key))).toEqual(known.binding);
    const refreshed = await runtime.run(dump([edition, work]));
    completed(refreshed);
    const after = await candidates(book.id, relation, context);
    const resolved = after.find((c) => c.statement.value.type === 'value' && c.statement.value.content === known.id);
    // Learning may refresh in that complete dump or in the subsequent unchanged import.
    expect(resolved).toBeDefined();
    const fresh = proposal(learned, relation) ?? proposal(refreshed, relation);
    expect(fresh).toBeDefined();
    expect(fresh!.key).not.toBe(old.key);
    expect(fresh!.statement).not.toEqual(old.statement);
    expect(fresh!.source).toEqual(old.source); // data-only digest and both real revisions stay stable
    expect(resolved!.id).not.toBe(oldCandidate.id);
    const retained = after.find((c) => c.id === oldCandidate.id);
    expect(retained?.statement).toEqual(oldCandidate.statement);
    expect(retained?.revision).toBe(oldCandidate.revision);
    // Source retraction does not silently undo the community's earlier adoption.
    const adopted = await editor.http(`/v1/subjects/${book.id}?context=${context}`);
    expect(adopted.status).toBe(200);
    const subject = adopted.body.subject as { statements: Record<string, BatchStatement[]> };
    expect(subject.statements[relation]?.some((s) => s.value.type === 'somevalue')).toBe(true);
    await adopt(resolved!.id);
    const selected = await editor.http(`/v1/subjects/${book.id}?context=${context}`);
    expect(selected.status).toBe(200);
    expect(
      (selected.body.subject as typeof subject).statements[relation]?.some(
        (s) => s.value.type === 'value' && s.value.content === known.id,
      ),
    ).toBe(true);
    const history = await candidates(book.id, relation, context);
    expect(history.some((c) => c.id === oldCandidate.id)).toBe(true);
    completed(await runtime.run(dump([edition, work])));
    expect(await candidates(book.id, relation, context)).toEqual(history);
    const author = await candidates(book.id, 'schema:author');
    expect(author).toHaveLength(1);
    unresolved(author[0]!.statement, '/authors/OL1A');
  } finally {
    await runtime.close();
  }
}, 600_000);
