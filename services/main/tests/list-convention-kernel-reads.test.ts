import { expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readPostIdentifications } from '../src/modules/post/identification-read.ts';
import { projectionRoutes } from '../src/routes/projections.ts';
import { resourceRelationRoutes } from '../src/routes/resource-relations.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
const literal = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });
const RV = 'https://rezics.com/vocab/';
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
interface Work { resource: string; name: string }
interface Projection { resource: string; subject: string; frames: string[] }
interface Membership { continuity: string; occurrence: string }

/** Works and projections the summary and exact-head probes already understand, plus one continuity page. */
function catalogue(works: Work[], projections: Projection[] = [], memberships: readonly Membership[] = []) {
  const graph = new FusekiClient('http://graph.invalid');
  const requested = (query: string) => [...(/VALUES \?[rp] \{([^}]*)\}/.exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
    .map(match => match[1]!);
  graph.query = async (query: string) => {
    if (query.includes('ASK {')) return { boolean: true };
    if (query.includes('in-continuity')) {
      return { results: { bindings: memberships.map(row => ({ work: uri(works[0]!.resource),
        continuity: uri(row.continuity), occurrence: uri(row.occurrence) })) } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?hold')) {
      const control = { epoch: literal('epoch'), sequence: literal('1') };
      const bindings = requested(query).flatMap((resource): Row[] => {
        const work = works.find(candidate => candidate.resource === resource);
        if (work) return [{ ...control, r: uri(resource), type: literal('work'), work: uri(resource), head: uri(id(900)),
          public: literal('true'), erased: literal('false'),
          label: { type: 'literal' as const, value: work.name, 'xml:lang': 'en' } }];
        const projection = projections.find(candidate => candidate.resource === resource);
        return projection ? projection.frames.map(frame => ({ ...control, r: uri(resource), type: literal('projection'),
          public: literal('false'), erased: literal('false'), projectionSubject: uri(projection.subject),
          projectionFrame: uri(frame) })) : [];
      });
      return { results: { bindings: bindings.length ? bindings : [control] } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision ?type')) {
      return { results: { bindings: requested(query).map((resource, index) => ({ epoch: literal('epoch'),
        sequence: literal('1'), r: uri(resource), revision: uri(id(1000 + index)), type: uri(`${RV}Projection`) })) } };
    }
    if (query.includes('SELECT ?p ?revision')) {
      return { results: { bindings: requested(query).map((resource, index) => ({ p: uri(resource),
        revision: uri(id(1000 + index)) })) } };
    }
    if (query.includes('SELECT ?epoch ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal('1') }] } };
    }
    throw new Error(`Unexpected graph probe: ${query.slice(0, 180)}`);
  };
  const allowed = async (resources: readonly string[]) => new Set(resources);
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/list-convention-kernel-reads',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: {} as never, account: {} as never,
    mediaAccess: { canReadWorks: (_principal: unknown, _actor: unknown, resources: readonly string[]) => allowed(resources),
      canReadSemantics: (_principal: unknown, _actor: unknown, resources: readonly string[]) => allowed(resources),
      canReadPrivateContexts: (_principal: unknown, _actor: unknown, resources: readonly string[]) => allowed(resources) } };
  return { graph, deps };
}

async function page(response: Response) {
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${response.status}: ${text}`);
  return JSON.parse(text) as { items: unknown[]; nextCursor: string | null; complete: boolean };
}

test('post identifications are complete only when the page bound does not cut them', async () => {
  const post = id(7);
  const [first, second] = [id(10), id(11)];
  const graph = new FusekiClient('http://graph.invalid');
  const works = [first, second];
  graph.query = async (query: string) => {
    if (query.includes('composition-part')) {
      return { results: { bindings: works.map(work => ({ work: uri(work), main: uri(id(901)),
        structure: uri(id(903)), occurrence: uri(id(904)) })) } };
    }
    if (query.includes('?publisher')) {
      return { results: { bindings: [{ head: uri(id(910)), publisher: uri(id(911)),
        label: { type: 'literal' as const, value: 'Chapter', 'xml:lang': 'en' }, public: literal('true') }] } };
    }
    if (query.includes('SELECT DISTINCT ?book')) return { results: { bindings: [] } };
    if (query.includes('?mainHead')) {
      return { results: { bindings: [{ head: uri(id(900)), main: uri(id(901)), mainHead: uri(id(902)),
        public: literal('true') }] } };
    }
    if (query.includes('?selection ?language')) return { results: { bindings: [] } };
    throw new Error(`Unexpected graph probe: ${query.slice(0, 180)}`);
  };
  const read = async (limit: number, listed: string[]) => {
    works.splice(0, works.length, ...listed);
    const deps = { environment: { fuseki: graph, objectDirectory: '.temp/list-convention-kernel-reads',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: {} as never, account: {} as never };
    const session = new WorkReadSession(deps as unknown as MainWorkDependencies,
      new Request(`http://main.test/v1/posts/${post.slice(-36)}/identifications`),
      { limit }, { dataEpoch: 'epoch', sequence: '1' });
    session.summaries = async (resources) => resources.map(reference => ({ reference, status: 'available' as const,
      type: 'work' as const, name: { value: 'A story', language: 'en', direction: 'ltr' as const, basis: 'requested' as const },
      avatar: { kind: 'fallback' as const, policy: 'avatar-fallback-v1', key: 'k', resourceType: 'work' as const } })) as never;
    return readPostIdentifications(session, post);
  };
  const short = await read(20, [first]);
  expect(short.items).toHaveLength(1);
  expect(short).toMatchObject({ nextCursor: null, complete: true });
  const cut = await read(1, [first, second]);
  expect(cut.items).toHaveLength(1);
  expect(cut.nextCursor).toBeString();
  expect(cut.complete).toBe(false);
});

test('projection lists are complete only when the page bound does not cut them', async () => {
  const [subject, frame] = [id(1), id(2)];
  const [one, two] = [id(10), id(11)];
  const works: Work[] = [{ resource: subject, name: 'Subject' }, { resource: frame, name: 'Frame' }];
  const read = async (projections: Projection[]) => {
    const { deps } = catalogue(works, projections);
    const store = { list: async (listed: string, _after: string | null, limit: number) => projections
      .filter(row => row.subject === listed).map(row => row.resource).sort().slice(0, limit),
      listByFrame: async () => [] };
    const app = projectionRoutes({ ...deps, projections: store } as unknown as MainWorkDependencies);
    return page(await app.handle(new Request(
      `http://main.test/v1/projections?subject=${encodeURIComponent(subject)}&limit=1&position=all`)));
  };
  const short = await read([{ resource: one, subject, frames: [frame] }]);
  expect(short.items).toHaveLength(1);
  expect(short).toMatchObject({ nextCursor: null, complete: true });
  const cut = await read([{ resource: one, subject, frames: [frame] }, { resource: two, subject, frames: [frame] }]);
  expect(cut.items).toHaveLength(1);
  expect(cut.nextCursor).toBeString();
  expect(cut.complete).toBe(false);
});

test('work continuities are complete only when the page bound does not cut them', async () => {
  const work = id(1);
  const [first, second] = [id(3), id(4)];
  const works: Work[] = [{ resource: work, name: 'Work' }, { resource: first, name: 'First' },
    { resource: second, name: 'Second' }];
  const read = async (memberships: Membership[], limit?: number) => {
    const { graph, deps } = catalogue(works, [], memberships);
    const app = resourceRelationRoutes(graph, deps as unknown as MainWorkDependencies);
    const query = limit === undefined ? 'position=all' : `position=all&limit=${limit}`;
    return page(await app.handle(new Request(`http://main.test/v1/resources/${work.slice(-36)}/continuities?${query}`)));
  };
  const short = await read([{ continuity: first, occurrence: id(50) }]);
  expect(short.items).toHaveLength(1);
  expect(short).toMatchObject({ nextCursor: null, complete: true });
  const cut = await read([{ continuity: first, occurrence: id(50) }, { continuity: second, occurrence: id(51) }], 1);
  expect(cut.items).toHaveLength(1);
  expect(cut.nextCursor).toBeString();
  expect(cut.complete).toBe(false);
});
