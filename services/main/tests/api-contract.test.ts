import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Value } from 'typebox/value';
import type { MainApp } from '@rezics/main/app';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { exactWorkRevision, pendingOperation, publicQueryResult, workResult } from '../src/api-contract.ts';
import { exactContentRevision } from '../src/api-responses.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';

type Assert<Condition extends true> = Condition;
type Routes = MainApp['~Routes'];
type WorkPost = Routes['v1']['works']['post'];
type RevisionGet = Routes['v1']['revisions'][':revision']['get'];
type ContentRevisionGet = Routes['v1']['content-revisions'][':revision']['get'];
type ContentDraftPost = Routes['v1']['content-drafts']['post'];
type QueryPost = Routes['v1']['queries']['post'];
type TranslationPost = Routes['v1']['translation-links']['post'];
type TranslationGet = Routes['v1']['main-versions'][':mainVersion']['revisions'][':revision']['translation-links']['get'];
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
type _ContentRevisionShape = Assert<ContentRevisionGet['response'][200] extends {
  reference: { owner: 'content'; revisionId: string; byteDigest: string };
  serializedJson: string; body: Record<string, unknown>
} ? true : false>;
type _ContentDraftCreated = Assert<201 extends keyof ContentDraftPost['response'] ? true : false>;
type _ContentDraftShape = Assert<ContentDraftPost['response'][201] extends {
  resourceId: string; revisionId: string; sourcePosition: { owner: 'content'; sequence: string }
} ? true : false>;
type _QueryInput = Assert<'public-main-phrase-v1' extends QueryPost['body']['profile'] ? true : false>;
type _ContentQueryInput = Assert<'public-content-phrase-v1' extends QueryPost['body']['profile'] ? true : false>;
type _QueryBudget = Assert<422 extends keyof QueryPost['response'] ? true : false>;
type _QueryShape = Assert<QueryPost['response'][200] extends {
  complete: true; results: unknown[]
} ? true : false>;
type _TranslationInput = Assert<TranslationPost['body']['sourceMainRevision'] extends string | null ? true : false>;
type _TranslationWrite = Assert<TranslationPost['response'][201] extends {
  sourceVersionStatus: 'exact' | 'unresolved'; sourceMainRevision: string | null;
  authorizationScope: string | null; receipt: string
} ? true : false>;
type _TranslationRead = Assert<TranslationGet['response'][200] extends {
  complete: true; links: unknown[]
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
    expect(Value.Check(exactContentRevision, { reference: {
      owner: 'content', resourceId: id, variantId: 'urn:rezics:variant:test',
      revisionId: id, format: 'rezics-content-json-v1', model: 'content-shape-v1',
      byteDigest: 'a'.repeat(64), byteLength: 13,
      language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-hans' },
      direction: 'ltr', sourceRevision: null, predecessor: null,
      provenance: { author: 'test' },
    }, serializedJson: '{"body":"ok"}', body: { body: 'ok' } })).toBe(true);
    expect(Value.Check(publicQueryResult, { contractVersion: '1', resultGrain: 'mainVersion',
      context: 'main-version-default', complete: true, population: 0,
      indexGeneration: 'index', total: 0, results: [], sourcePosition: position })).toBe(true);
    const realm = { kind: 'realm-local', id } as const;
    const query = { contractVersion: '1', resultGrain: 'mainVersion',
      complete: true, population: 0, indexGeneration: 'index',
      total: 0, results: [], sourcePosition: position };
    expect(Value.Check(publicQueryResult, { ...query, context: realm })).toBe(true);
    expect(Value.Check(publicQueryResult, { contractVersion: '1',
      profile: 'public-content-phrase-v1', resultGrain: 'content-variant', complete: true,
      population: 1, total: 1, results: [{ matchUnit: id, resource: id,
        variant: id, revision: id, publicationDecision: id, language: 'zh', score: 1 }],
      graphPosition: { dataEpoch: 'graph', sequence: '7' },
      contentPosition: { owner: 'content', dataEpoch: 'content', sequence: '2' },
      indexGeneration: 'index' })).toBe(true);
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
    const contentQuery = await send('/v1/queries', { profile: 'public-content-phrase-v1',
      phrase: 'x', language: null });
    expect(contentQuery.status).toBe(400);
    const missingContent = await send('/v1/queries', { profile: 'public-content-phrase-v1',
      phrase: 'needle', language: null });
    expect(missingContent.status).toBe(503);
    expect((await missingContent.json() as { code: string }).code).toBe('content_projection_unavailable');
    const revision = await app.handle(new Request('http://localhost/v1/revisions/invalid'
      + `?actingSubject=${encodeURIComponent(id)}`));
    expect(revision.status).toBe(400);
    expect((await revision.json() as { code: string }).code).toBe('invalid_request');
    const rating = await send('/v1/rating-observations', { profile: 'realm-standing-rating-observation-v1' });
    expect(rating.status).toBe(400);
    const space = await app.handle(new Request('http://localhost/v1/spaces/invalid'));
    expect(space.status).toBe(400);
  });

  test('generated public OpenAPI lists every route with success and problem schemas', () => {
    const spec = JSON.parse(readFileSync(resolve(import.meta.dir,
      '../../../generated/openapi/main/public.json'), 'utf8')) as {
      paths: Record<string, Record<string, { responses: Record<string,
        { content: Record<string, { schema: unknown }> }>; security?: unknown;
        parameters?: { name: string; in: string }[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(spec.paths)).toHaveLength(32);
    expect(Object.keys(spec.paths).every(path => path.startsWith('/v1/'))).toBe(true);
    expect(spec.paths['/v1/main-versions/{mainVersion}/native-variants']?.get).toBeDefined();
    expect(spec.paths['/v1/me/main-versions/{mainVersion}/variant-preference']?.put).toBeDefined();
    expect(spec.paths['/v1/me/main-versions/{mainVersion}/selection']?.get).toBeDefined();
    expect(spec.paths['/v1/translation-links']?.post).toBeDefined();
    expect(spec.paths['/v1/main-versions/{mainVersion}/revisions/{revision}/translation-links']?.get)
      .toBeDefined();
    for (const methods of Object.values(spec.paths)) for (const operation of Object.values(methods)) {
      const statuses = Object.keys(operation.responses);
      expect(statuses.some(status => status === '200' || status === '201')).toBe(true);
      expect(statuses.some(status => Number(status) >= 400)).toBe(true);
      for (const [status, result] of Object.entries(operation.responses)) {
        const mediaType = Number(status) >= 400 ? 'application/problem+json' : 'application/json';
        expect(result.content[mediaType]?.schema).toBeDefined();
      }
    }
    const create = spec.paths['/v1/works']!.post!;
    expect(create.security).toEqual([{ bearerAuth: [] }]);
    expect(create.parameters?.some(parameter => parameter.name === 'Idempotency-Key'
      && parameter.in === 'header')).toBe(true);
    const translation = spec.paths['/v1/translation-links']!.post!;
    expect(translation.security).toEqual([{ bearerAuth: [] }]);
    expect(translation.parameters?.some(parameter => parameter.name === 'Idempotency-Key'
      && parameter.in === 'header')).toBe(true);
    expect(spec.paths['/v1/queries']!.post!.security).toBeUndefined();
    expect(spec.paths['/v1/content-revisions/{revision}']!.get!.security)
      .toEqual([{ bearerAuth: [] }]);
    const draft = spec.paths['/v1/content-drafts']!.post!;
    expect(draft.security).toEqual([{ bearerAuth: [] }]);
    expect(draft.parameters?.some(parameter => parameter.name === 'Idempotency-Key'
      && parameter.in === 'header')).toBe(true);
    expect(spec.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
  });
});
