import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { createMainApp, type MainApp, type MainWorkDependencies } from '../src/app.ts';
import { exactWorkRevision, pendingOperation, publicQueryResult, workResult } from '../src/api-contract.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';

type Assert<Condition extends true> = Condition;
type Routes = MainApp['~Routes'];
type WorkPost = Routes['v1']['works']['post'];
type RevisionGet = Routes['v1']['revisions'][':revision']['get'];
type QueryPost = Routes['v1']['queries']['post'];
type _WorkInput = Assert<WorkPost['body']['profile'] extends 'metadata-only-v1' ? true : false>;
type _WorkCreated = Assert<201 extends keyof WorkPost['response'] ? true : false>;
type _WorkReplayed = Assert<200 extends keyof WorkPost['response'] ? true : false>;
type _WorkPending = Assert<202 extends keyof WorkPost['response'] ? true : false>;
type _WorkCreatedShape = Assert<WorkPost['response'][201] extends {
  work: string; sourcePosition: { sequence: string }; replayed: boolean
} ? true : false>;
type _WorkPendingShape = Assert<WorkPost['response'][202] extends {
  status: 'reconciling'; operationId: string
} ? true : false>;
type _RevisionPath = Assert<RevisionGet['params']['revision'] extends string ? true : false>;
type _RevisionRead = Assert<200 extends keyof RevisionGet['response'] ? true : false>;
type _RevisionShape = Assert<RevisionGet['response'][200] extends {
  revision: string; title: string; language: 'en'
} ? true : false>;
type _QueryInput = Assert<'public-main-phrase-v1' extends QueryPost['body']['profile'] ? true : false>;
type _QueryBudget = Assert<422 extends keyof QueryPost['response'] ? true : false>;
type _QueryShape = Assert<QueryPost['response'][200] extends {
  complete: true; results: unknown[]
} ? true : false>;

const id = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const position = { datasetId: 'product', dataEpoch: 'epoch', sequence: '42' };

describe('Main typed route contracts', () => {
  test('successful, pending and public query envelopes validate', () => {
    expect(Value.Check(workResult, { work: id, mainVersion: id, workRevision: id,
      mainRevision: id, sourcePosition: position, replayed: false })).toBe(true);
    expect(Value.Check(pendingOperation, { operationId: id, status: 'reconciling',
      phase: 'graph-outcome', result: null,
      retry: { allowed: true, afterMs: 1000 } })).toBe(true);
    expect(Value.Check(exactWorkRevision, { revision: id, work: id, operation: id,
      mainVersion: id, title: 'Work', language: 'en', sourcePosition: position })).toBe(true);
    expect(Value.Check(publicQueryResult, { contractVersion: '1', resultGrain: 'mainVersion',
      context: 'main-version-default', complete: true, population: 0,
      indexGeneration: 'index', total: 0, results: [], sourcePosition: position })).toBe(true);
    const realm = { kind: 'realm-local', id } as const;
    const query = { contractVersion: '1', resultGrain: 'mainVersion',
      complete: true, population: 0, indexGeneration: 'index',
      total: 0, results: [], sourcePosition: position };
    expect(Value.Check(publicQueryResult, { ...query, context: realm })).toBe(true);
    expect(Value.Check(publicQueryResult, { ...query,
      profile: 'public-main-classified-phrase-v1',
      context: 'main-version-default', classificationSense: id })).toBe(true);
    expect(Value.Check(publicQueryResult, { ...query,
      profile: 'public-realm-classified-phrase-v1',
      context: realm, classificationSense: id })).toBe(true);
    expect(Value.Check(publicQueryResult, { ...query,
      profile: 'public-realm-classified-rated-phrase-v1', context: realm,
      classificationSense: id, ratingPopulation: 0,
      ratingCriterion: { context: id, minimumMeanTimes10: 70,
        policy: 'latest-per-rater-mean' } })).toBe(true);
    expect(Value.Check(publicQueryResult, { ...query, total: 1,
      profile: 'public-realm-classified-rated-phrase-v1', context: realm,
      classificationSense: id, ratingPopulation: 1,
      ratingCriterion: { context: id, minimumMeanTimes10: 70,
        policy: 'latest-per-rater-mean' },
      results: [{ matchUnit: id, work: id, mainVersion: id,
        contribution: id, revision: id, selection: id, language: 'en',
        reason: 'realm-adoption', score: 1,
        classification: { sense: id, decision: id, application: id,
          source: 'local', sourceContext: id },
        rating: { context: id, count: 1, sum: 7, mean: 7,
          precision: { kind: 'exact-rational', numerator: 7, denominator: 1 } } }],
    })).toBe(true);
    expect(Value.Check(publicQueryResult, { ...query,
      profile: 'public-main-classified-phrase-v1', context: 'main-version-default' })).toBe(false);
  });

  test('registered routes reject invalid inputs with the existing problem response', async () => {
    // Validation precedes all external dependencies for these requests.
    const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'),
      {} as MainWorkDependencies);
    const send = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body) }));
    const work = await send('/v1/works', { profile: 'metadata-only-v1', title: '',
      actingSubject: id });
    expect(work.status).toBe(400);
    expect((await work.json() as { code: string }).code).toBe('invalid_request');
    const missingKey = await send('/v1/works', { profile: 'metadata-only-v1',
      title: 'Work', actingSubject: id });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json() as { code: string }).code).toBe('invalid_idempotency_key');
    const query = await send('/v1/queries', { profile: 'public-main-phrase-v1',
      phrase: 'x', language: null });
    expect(query.status).toBe(400);
    expect((await query.json() as { code: string }).code).toBe('invalid_request');
    const revision = await app.handle(new Request('http://localhost/v1/revisions/invalid'
      + `?actingSubject=${encodeURIComponent(id)}`));
    expect(revision.status).toBe(400);
    expect((await revision.json() as { code: string }).code).toBe('invalid_request');
  });
});
