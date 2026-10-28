import { expect } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import type { Dump, Source } from '../../../../specs/imports-api-driver.ts';
import type { HttpResponse, Statement, Subject } from '../../../../specs/semantic-driver.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { createReleasedDiscoveryFixture, type ReleasedDiscoveryFixture } from '../support/released-discovery.ts';

export { createReleasedDiscoveryFixture };
export type { ReleasedDiscoveryFixture };

export function successful(response: HttpResponse, status = 200): void {
  expect({ status: response.status, body: response.status === status ? undefined : response.body }).toEqual({
    status,
    body: undefined,
  });
}

/** Native DTO, useful pages and exact controlled population; no matcher or result adapter. */
export async function searchBooks(
  fixture: ReleasedDiscoveryFixture,
  filter: FilterDocument,
  expected: readonly string[],
): Promise<void> {
  const found: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
      filter,
      sort: 'id',
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    successful(response);
    const subjects = response.body.subjects as { id: string }[];
    const next = response.body.next as string | null;
    expect(subjects.length === 2 || next === null).toBe(true);
    found.push(...subjects.map((subject) => subject.id));
    if (next === null) {
      expect(found).toEqual([...expected].sort());
      expect(new Set(found).size).toBe(found.length);
      return;
    }
    expect(cursors.has(next)).toBe(false);
    cursors.add(next);
    cursor = next;
  }
  throw new Error('Controlled seven-book population did not exhaust in eight native pages');
}

const encode = (text: string) => new TextEncoder().encode(text);
const input = (path: string) => Bun.file(new URL(`../../../../specs/fixtures/imports/${path}`, import.meta.url));
export const observedBangumi = () => input('bangumi/public-book-meta-tags.json').json();

/** All but the explicitly observed Bangumi projection are controlled native-format inputs. */
export async function discoveryDump(source: Source): Promise<Dump> {
  const registration = createSourceRegistration(source, { source });
  const common = { source, snapshot: 'controlled-discovery', converterRevision: registration.converter_revision };
  if (source === 'bangumi') return { ...common, bytes: encode(`${JSON.stringify(await observedBangumi())}\n`) };
  if (source === 'wikidata')
    return { ...common, bytes: new Uint8Array(await input('api/wikidata.jsonl').arrayBuffer()) };
  if (source === 'openlibrary') {
    const work = await input('api/openlibrary.tsv').text();
    const edition = {
      type: { key: '/type/edition' },
      key: '/books/OL1M',
      revision: 1,
      title: 'Controlled edition',
      last_modified: { type: '/type/datetime', value: '2020-01-01T00:00:00.000000' },
      works: [{ key: '/works/OL1W' }],
      number_of_pages: 1400000,
      languages: [{ key: '/languages/eng' }],
    };
    return {
      ...common,
      bytes: encode(`${work}/type/edition\t/books/OL1M\t1\t2020-01-01T00:00:00.000000\t${JSON.stringify(edition)}\n`),
    };
  }
  const tables = {
    vn: [
      (await input('vndb-tables/db/vn.header').text()).trimEnd(),
      'v1\t\\N\t\\N\ten\t0\t\\N\t\\N\t\\N\t0\t0\t0\tControlled novel\tUNLICENSED_DESCRIPTION_SENTINEL',
    ],
    vn_titles: ['id\tlang\tofficial\ttitle\tlatin', 'v1\ten\tt\tControlled novel\t\\N'],
    entry_meta: ['id\tcreated\tlastmod\trevision\tnum_edits\tnum_users', 'v1\t2020-01-01\t2020-01-01\t7\t6\t3'],
  };
  return {
    ...common,
    bytes: new Uint8Array(),
    entries: () =>
      (async function* () {
        for (const [name, [header, rows]] of Object.entries(tables))
          for (const [path, text] of [
            [`db/${name}.header`, header],
            [`db/${name}`, rows],
          ]) {
            const bytes = encode(text + '\n');
            yield {
              path: path!,
              kind: 'file' as const,
              declaredBytes: bytes.length,
              bytes: (async function* () {
                yield bytes;
              })(),
            };
          }
      })(),
  };
}

export async function openDiscoveryImports() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const observer = await openApiObserver(runtime);
    const contextResponse = await observer.http('/v1/contexts', { labels: { en: 'Discovery import review' } });
    successful(contextResponse, 201);
    const context = (contextResponse.body.context as { id: string }).id;
    async function selected(source: Source, key: string, properties: readonly string[]) {
      const view = await observer.read(source, key);
      expect(view.subject).not.toBeNull();
      const id = view.subject!.id;
      // Accept only candidates actually returned by the importer. No editorial replacement proposal.
      for (const property of properties) {
        const candidates = view.proposals.filter((p) => p.statement?.property.id === property);
        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) {
          expect(candidate.references.length).toBeGreaterThan(0);
          successful(
            await observer.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
              context,
              expected_head: null,
            }),
          );
        }
        successful(
          await observer.http(`/v1/subjects/${id}:adopt`, {
            context,
            property,
            mode: 'replace',
            expected_head: null,
            selection: candidates.map((candidate) => ({ candidate: candidate.id, rank: 'normal' })),
          }),
        );
      }
      const response = await runtime.request(`/v1/subjects/${id}?${new URLSearchParams({ context })}`);
      const body = (await response.json()) as { subject: Subject & { sourceRecords?: unknown[] } };
      expect(response.status).toBe(200);
      expect(body.subject.id).toBe(id);
      for (const property of properties) {
        const statements = body.subject.statements[property] as Statement[];
        expect(statements?.length).toBeGreaterThan(0);
        expect(statements.every((statement) => statement.references.length > 0)).toBe(true);
      }
      return { view, subject: body.subject };
    }
    return { runtime, observer, context, selected, close: runtime.close };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
