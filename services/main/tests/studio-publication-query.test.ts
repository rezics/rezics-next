import { expect, test } from 'bun:test';
import { GRAPHS } from '../src/modules/work/activate.ts';
import { READ_PREFIX, type ReadRow, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { readStudioWork, readStudioWorks } from '../src/modules/studio/works.ts';
import { evaluatePublicationQueries } from './structured-work-publication-fixture.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const agent = id(1), otherAgent = id(2);
const term = (value: string) => ({ value });
const works = [10, 20, 30].map(n => ({ work: id(n), main: id(n + 1), contribution: id(n + 2),
  draft: id(n + 3), publication: n === 10 ? null : id(n + 4), selected: n === 20 ? id(n + 5) : null }));

// Only text/publication queries are evaluated in Jena. Authority, Work heads and
// empty chapter structures are owner boundary doubles, not genuine API proof.
function fixture() {
  const queries = new Set<string>(), answers = new Map<string, ReadRow[]>();
  const admission = (work: string) => ({ id: work, work, writer: agent, generation: '1',
    created_at: new Date('2026-10-01T00:00:00Z'), created_key: '2026-10-01T00:00:00Z',
    updated_key: '2026-10-01T00:00:00Z', action: 'work.create' });
  const head = (item: typeof works[number]) => ({ admission: term(item.work), work: term(item.work),
    main: term(item.main), head: term(`${item.work}/head`), mainHead: term(`${item.main}/head`),
    title: term(`Work ${item.work}`), hasText: term('true'), hasPublication: term(String(!!item.publication)) });
  const session = {
    principal: { issuer: 'fixture', subject: 'owner', emailVerified: true },
    options: { actingSubject: agent, limit: 5 }, position: { dataEpoch: 'fixture', sequence: '1' },
    deps: {
      environment: { fuseki: { async query() { return { results: { bindings: [] } }; } } },
      studioAccess: {
        async studioWorks(_principal: unknown, _agent: string, after: string, limit: number) {
          return { stamp: 'controller-1', rows: works.filter(item => item.work > after)
            .slice(0, limit).map(item => admission(item.work)) };
        },
        async studioWork(_principal: unknown, _agent: string, work: string) {
          return { stamp: 'controller-1', row: admission(work) };
        },
        async studioWorkDetails() { return { edits: [], submissions: [] }; },
      },
    },
    observeDependency() {},
    async summaries() { return []; },
    async query(query: string) {
      if (query.includes('SELECT ?contribution') || query.includes('SELECT ?work ?contribution')) {
        queries.add(query);
        return answers.get(query) ?? [];
      }
      if (query.includes('SELECT ?admission')) return works.map(head);
      if (query.includes('SELECT ?main ?head')) return works.filter(item => query.includes(`<${item.work}>`)).map(head);
      if (query.includes('SELECT ?work ?type')) return works.map(item => ({ work: term(item.work), type: term('https://schema.org/Book') }));
      if (query.includes('SELECT ?type')) return [{ type: term('https://schema.org/Book') }];
      return [];
    },
  } as unknown as WorkReadSession;
  return { session, queries, answers };
}

test('Studio exact and list reads keep private drafts separate from unrelated publications', async () => {
  const f = fixture();
  for (const item of works) await readStudioWork(f.session, agent, item.work);
  await readStudioWorks(f.session, agent, {});
  await readStudioWorks(f.session, agent, { state: 'draft' });
  expect(f.queries.size).toBe(5);

  const dataset = `@prefix rv: <https://rezics.com/vocab/> .
    <${GRAPHS.current}> {
      ${works.map(item => `<${item.contribution}> a rv:TextContribution ; rv:work <${item.work}> ;
        rv:author <${agent}> ; rv:language "en" ; rv:draftHead <${item.draft}>
        ${item.publication ? `; rv:publicationHead <${item.publication}>` : ''} .`).join('\n')}
      <${id(40)}> a rv:TextContribution ; rv:work <${works[0]!.work}> ; rv:author <${otherAgent}> ;
        rv:language "en" ; rv:draftHead <${id(41)}> ; rv:publicationHead <${id(42)}> .
      <${id(50)}> a rv:TextContribution ; rv:work <${id(51)}> ; rv:author <${agent}> ;
        rv:language "en" ; rv:draftHead <${id(52)}> ; rv:publicationHead <${id(53)}> .
    }
    <${GRAPHS.revisions}> {
      <${works[1]!.publication}> rv:selectedDraft <${works[1]!.selected}> .
      <${id(42)}> rv:selectedDraft <${id(41)}> .
      <${id(53)}> rv:selectedDraft <${id(52)}> .
      <${id(60)}> rv:selectedDraft <${id(61)}> .
    }`;
  const queries = [...f.queries];
  const evaluated = evaluatePublicationQueries(queries.map(query => ({ dataset, query: `${READ_PREFIX}\n${query}` })));
  for (const [index, query] of queries.entries()) f.answers.set(query, evaluated[index]!.results!.bindings);

  const expected = works.map(item => ({ id: item.work, state: item.publication ? 'published' : 'draft',
    chapterCount: { value: 0, complete: true }, texts: [{ contribution: item.contribution, language: 'en',
      draftHead: item.draft, publicationHead: item.publication, publicationDraft: item.selected }] }));
  for (const [index, item] of works.entries()) {
    expect((await readStudioWork(f.session, agent, item.work)).item).toMatchObject(expected[index]!);
  }
  const page = await readStudioWorks(f.session, agent, {});
  expect(page.items).toHaveLength(3);
  expect(page.items).toMatchObject(expected);
  expect(page.count).toEqual({ value: 3, kind: 'exact-page', total: null });
  const drafts = await readStudioWorks(f.session, agent, { state: 'draft' });
  expect(drafts.items).toHaveLength(1);
  expect(drafts.items[0]).toMatchObject(expected[0]!);
  expect(drafts.nextCursor).toBeNull();
}, 120_000);
