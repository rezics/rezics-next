import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { compositionTargetReader } from '../src/modules/composition/disclosure-read.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const value = (value: string) => ({ type: 'literal', value });

function fixture(options: { post?: boolean; public?: boolean; granted?: boolean;
  erased?: boolean; absent?: boolean; unavailable?: boolean }) {
  const graph = new FusekiClient('http://graph.invalid');
  const queries: string[] = [], grants: string[] = [];
  graph.query = async query => {
    queries.push(query);
    if (options.unavailable) throw new Error('target graph unavailable');
    // A Post has no CreativeWork/MainVersion result. The regression's Work-only
    // probe returns no rows; the existing resource summary sees its Post head.
    if (!query.includes('SELECT ?epoch ?sequence ?hold')) return { results: { bindings: [] } };
    const bindings: NonNullable<SparqlResult['results']>['bindings'] = [{
      epoch: value('epoch'), sequence: value('7'),
      ...(!options.absent ? {
        r: { type: 'uri', value: target }, type: value(options.post ? 'resource' : 'work'),
        head: { type: 'uri', value: actor },
        ...(options.post ? { post: value('true') } : { work: { type: 'uri', value: target } }),
        public: value(String(options.public ?? false)), erased: value(String(options.erased ?? false)),
        label: { ...value('Readable chapter'), 'xml:lang': 'en' },
      } : {}),
    }];
    return { results: { bindings } };
  };
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/composition-disclosure',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    access: { canReadWork: async (_principal: unknown, _actor: string, resource: string) => {
      grants.push(resource); return options.granted ?? false;
    } } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.local/v1/compositions'),
    { actingSubject: actor }, { dataEpoch: 'epoch', sequence: '7' });
  session.principal = { issuer: 'account', subject: 'reader' };
  return { read: compositionTargetReader(session, structureProfileFor('book-composition')),
    queries, grants };
}

test('Book targets disclose granted Post chapters without requiring CreativeWork or MainVersion', async () => {
  const f = fixture({ post: true, granted: true });
  expect(await f.read(target)).toBe(true);
  expect(f.grants).toEqual([target]);
  expect(f.queries[0]).toContain('?r a rv:Post');
});

test('Book targets preserve public Post and Work disclosure without a target grant', async () => {
  for (const post of [true, false]) {
    const f = fixture({ post, public: true });
    expect(await f.read(target)).toBe(true);
    expect(f.grants).toEqual([]);
  }
});

test('Book targets withhold ungranted, erased and absent Posts even when a parent is readable', async () => {
  for (const options of [{}, { erased: true, granted: true }, { absent: true, granted: true }]) {
    const f = fixture({ ...options, post: true });
    expect(await f.read(target)).toBe(false);
    if (options.erased || options.absent) expect(f.grants).toEqual([]);
  }
});

test('Book target disclosure propagates an unavailable owner instead of hiding a readable chapter', async () => {
  await expect(fixture({ post: true, unavailable: true }).read(target)).rejects.toThrow('target graph unavailable');
});
