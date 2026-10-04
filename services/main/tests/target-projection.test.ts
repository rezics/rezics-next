import { expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readProjectionViews } from '../src/modules/projection/read.ts';
import { resolveTargets, targetSummaries, TargetNotBound } from '../src/modules/target/resolve.ts';
import { WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
const literal = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });
const RV = 'https://rezics.com/vocab/';
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
interface Work { resource: string; name: string; public?: boolean }
interface Projection { resource: string; subject: string; frames: string[] }

/** A graph holding Works and projections of them, answering the summary and exact-head probes. */
function fixture(works: Work[], projections: Projection[], options: { hidden?: string[]; movedAfter?: number } = {}) {
  const queries: string[] = [];
  const graph = new FusekiClient('http://graph.invalid');
  let summaryReads = 0;
  const requested = (query: string) => [...(/VALUES \?[rp] \{([^}]*)\}/.exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
  graph.query = async (query: string) => {
    queries.push(query);
    if (query.includes('SELECT ?epoch ?sequence ?hold')) {
      const sequence = options.movedAfter !== undefined && summaryReads++ >= options.movedAfter ? '2' : '1';
      const control = { epoch: literal('epoch'), sequence: literal(sequence) };
      const bindings = requested(query).flatMap((resource): Row[] => {
        const work = works.find(candidate => candidate.resource === resource);
        if (work) return [{ ...control, r: uri(resource), type: literal('work'), work: uri(resource), head: uri(id(900)),
          public: literal(String(work.public ?? true)), erased: literal('false'),
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
      return { results: { bindings: requested(query).map((resource, index) => ({ p: uri(resource), revision: uri(id(1000 + index)) })) } };
    }
    if (query.includes('SELECT ?epoch ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal('1') }] } };
    }
    throw new Error(`Unexpected graph probe: ${query}`);
  };
  const allowed = async (resources: readonly string[]) => new Set(resources.filter(resource => !options.hidden?.includes(resource)));
  const deps: MainWorkDependencies = { environment: { fuseki: graph, objectDirectory: '.temp/projection-unit',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, access: {} as never, account: {} as never,
  mediaAccess: { canReadWorks: (_principal, _actor, resources) => allowed(resources),
    canReadSemantics: (_principal, _actor, resources) => allowed(resources),
    canReadPrivateContexts: (_principal, _actor, resources) => allowed(resources) } };
  const session = new WorkReadSession(deps, new Request('http://main.test/v1/projections'),
    { actingSubject: id(999) }, { dataEpoch: 'epoch', sequence: '1' });
  session.principal = { issuer: 'https://account.test', subject: 'reader' };
  const summaryQueries = () => queries.filter(query => query.includes('SELECT ?epoch ?sequence ?hold')).length;
  return { session, queries, summaryQueries };
}

const [misaka, railgun, season, episode] = [id(1), id(2), id(3), id(4)];
const [one, two, three] = [id(10), id(11), id(12)];
const works: Work[] = [{ resource: misaka, name: 'Misaka' }, { resource: railgun, name: 'Railgun' },
  { resource: season, name: 'Season 2' }, { resource: episode, name: 'Episode 3', public: false }];

test('a projection summarizes as its subject and each frame, never one joined label', async () => {
  const { session } = fixture(works, [{ resource: one, subject: misaka, frames: [season, railgun] }]);
  const { summaries } = await targetSummaries(session, [one]);
  const summary = summaries[0]!;
  if (summary.status !== 'available') throw new Error('projection is unavailable');
  expect(summary).toMatchObject({ reference: one, type: 'projection', base: 'projection', work: null, disclosure: 'public',
    name: { value: 'Misaka' }, avatar: { kind: 'fallback', resourceType: 'projection' } });
  expect(summary.parts!.subject.reference).toBe(misaka);
  expect(summary.parts!.frames.map(frame => frame.reference)).toEqual([railgun, season].sort());
  expect(summary.parts!.frames.map(frame => frame.name.value).sort()).toEqual(['Railgun', 'Season 2']);
  // The parts are ordinary summaries: they carry no parts or merge resolution of their own.
  for (const part of [summary.parts!.subject, ...summary.parts!.frames]) {
    expect(part).not.toHaveProperty('parts');
    expect(part.status).toBe('available');
  }
  expect(JSON.stringify(summary.name)).not.toContain('Railgun');
});

test('disclosure is the most restrictive of the parts, and an unreadable part hides the projection', async () => {
  const frames = [railgun, episode];
  const restricted = fixture(works, [{ resource: one, subject: misaka, frames }]);
  expect((await targetSummaries(restricted.session, [one])).summaries[0]).toMatchObject({ status: 'available', disclosure: 'restricted' });
  const hidden = fixture(works, [{ resource: one, subject: misaka, frames }], { hidden: [episode] });
  expect((await targetSummaries(hidden.session, [one])).summaries).toEqual([{ reference: one, status: 'unavailable' }]);
  // A subject the reader may not read is not public and not granted, so the whole projection is unavailable.
  const privateSubject = [{ ...works[0]!, public: false }, ...works.slice(1)];
  const unreadable = fixture(privateSubject, [{ resource: one, subject: misaka, frames: [railgun] }], { hidden: [misaka] });
  expect((await targetSummaries(unreadable.session, [one])).summaries).toEqual([{ reference: one, status: 'unavailable' }]);
});

test('there are no projections of projections: a projection used as a subject or frame is unavailable', async () => {
  const projections = [{ resource: one, subject: misaka, frames: [railgun] },
    { resource: two, subject: one, frames: [season] }, { resource: three, subject: misaka, frames: [one] }];
  const { session } = fixture(works, projections);
  const { summaries } = await targetSummaries(session, [one, two, three]);
  expect(summaries.map(summary => summary.status)).toEqual(['available', 'unavailable', 'unavailable']);
});

test('a batch of projections costs one summary page and one page of parts, shared by every projection', async () => {
  const projections = [{ resource: one, subject: misaka, frames: [railgun, season] },
    { resource: two, subject: misaka, frames: [railgun] }, { resource: three, subject: railgun, frames: [season] }];
  const { session, summaryQueries } = fixture(works, projections);
  const { summaries, cost } = await targetSummaries(session, [one, two, three]);
  expect(summaries.every(summary => summary.status === 'available')).toBe(true);
  expect(summaryQueries()).toBe(2);
  expect(cost.graphQueries).toBe(2);
  const views = await readProjectionViews(session, [three, one]);
  expect(views.map(view => [view.id, view.subject, view.frames, view.disclosure])).toEqual([
    [three, railgun, [season], 'public'], [one, misaka, [railgun, season].sort(), 'public']]);
});

test('parts read at another graph position than the projection are read again, not mixed', async () => {
  const { session } = fixture(works, [{ resource: one, subject: misaka, frames: [railgun] }], { movedAfter: 1 });
  await expect(targetSummaries(session, [one])).rejects.toBeInstanceOf(WorkReadMoved);
});

test('target resolution reports base projection for its capabilities and refuses the grains it lacks', async () => {
  const { session } = fixture(works, [{ resource: one, subject: misaka, frames: [railgun] }]);
  for (const capability of ['report', 'review', 'rating', 'discussion', 'collection-member', 'suitability'] as const) {
    expect(await resolveTargets(session, [one], capability), capability).toEqual([{ resource: one, base: 'projection',
      types: [`${RV}Projection`], work: null, revision: id(1000), disclosure: 'public' }]);
  }
  for (const capability of ['library-status', 'progress', 'continuity', 'spoiler-boundary', 'session'] as const) {
    await expect(resolveTargets(session, [one], capability), capability).rejects.toBeInstanceOf(TargetNotBound);
  }
});
