import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadUnavailable } from '../modules/work/read-session.ts';
import { readWorkBasis, fenceWorkBasis } from '../modules/work/read-header.ts';
import { readWorkRealization } from '../modules/realization/read.ts';
import { readWorkRelease } from '../modules/release/read.ts';
import { parseStoredRelease } from '../modules/release/schema.ts';
import { GRAPHS, iri } from '../modules/work/activate.ts';
import { InvalidContentLanguages, recordedLanguageTag } from '../modules/release/languages.ts';
import { SessionDenied } from '../modules/session/contract.ts';
import { editionChoice, editionPreference, InvalidEditionPreference, StaleEditionPreference,
  EditionPreferenceConflict } from '../modules/session/preference-contract.ts';
import { readSeriesProgress } from '../modules/session/series-read.ts';
import { seriesSummary } from '../modules/session/series-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { problem } from './problems.ts';

const headers = { 'cache-control': 'private, no-store' };
export const openApiOperations = {
  '/v1/me/progress-summaries/{resource}': { get: { bearer: true } },
  '/v1/me/edition-preferences/{work}': { get: { bearer: true }, put: { bearer: true, idempotencyKey: true } },
} as const;
function failure(error: unknown) {
  if (error instanceof SessionDenied) return problem(403, 'progress_denied', error.message);
  if (error instanceof InvalidEditionPreference || error instanceof InvalidContentLanguages) {
    return problem(400, 'invalid_edition_preference', error.message);
  }
  if (error instanceof StaleEditionPreference) return Response.json({
    ...{ type: 'https://rezics.com/problems/stale_edition_preference', title: error.message, status: 409,
      code: 'stale_edition_preference' }, current: error.current },
  { status: 409, headers: { ...headers, 'content-type': 'application/problem+json' } });
  if (error instanceof EditionPreferenceConflict) return problem(409, 'edition_preference_conflict', error.message);
  if (error && typeof error === 'object' && 'code' in error
    && ['55P03', '57014', '40P01'].includes(String(error.code))) {
    return problem(503, 'progress_unavailable', 'Reader state is busy; retry with the same Idempotency-Key');
  }
  return workReadError(error);
}
export function progressSummariesRoutes(work: MainWorkDependencies) {
  const own = async (request: Request, agent: string) => {
    const principal = await work.account.verify(request, ['work:read']);
    if (!await work.access.canReadAsBaselineMember?.(principal, agent)) {
      throw new SessionDenied('Progress and preferences are private to the principal’s own Person');
    }
    return { principal, agent };
  };
  return new Elysia()
    .get('/v1/me/progress-summaries/:resource', { params: t.Object({ resource: readUuid }),
      query: t.Object({ actingSubject: readId, language: t.Optional(readLanguage), parent: t.Optional(readId),
        after: t.Optional(t.String({ maxLength: 2048 })), sessionCursor: t.Optional(t.String({ maxLength: 2048 })),
        releaseCursor: t.Optional(t.String({ maxLength: 2048 })) }, { additionalProperties: false }),
      response: { 200: seriesSummary, ...workReadProblems } }, async ({ request, params, query }) => {
      try {
        const owner = await own(request, query.actingSubject);
        const result = await workRead(work, request, query,
          session => readSeriesProgress(session, owner, `https://rezics.com/id/${params.resource}`, query));
        await own(request, query.actingSubject);
        return Response.json(result, { headers });
      } catch (error) { return failure(error); }
    })
    .get('/v1/me/edition-preferences/:work', { params: t.Object({ work: readUuid }),
      query: t.Object({ actingSubject: readId }, { additionalProperties: false }),
      response: { 200: t.Nullable(editionPreference), ...workReadProblems } }, async ({ request, params, query }) => {
      try {
        if (!work.editionPreferences) throw new WorkReadUnavailable('Edition preferences are unavailable');
        const owner = await own(request, query.actingSubject);
        const resource = `https://rezics.com/id/${params.work}`;
        const result = await workRead(work, request, query, async session => {
          const basis = await readWorkBasis(session, resource);
          const value = await work.editionPreferences!.read(owner, resource);
          await fenceWorkBasis(session, basis);
          return value;
        });
        await own(request, query.actingSubject);
        return Response.json(result, { headers });
      } catch (error) { return failure(error); }
    })
    .put('/v1/me/edition-preferences/:work', { params: t.Object({ work: readUuid }),
      body: t.Object({ actingSubject: readId, expectedVersion: t.Integer({ minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER - 1 }), ...editionChoice.properties }, { additionalProperties: false }),
      response: { 200: t.Object({ ...editionPreference.properties, replayed: t.Boolean() }),
        ...workReadProblems, 409: t.Object({ ...problemResult(409).properties, current: t.Optional(t.Nullable(editionPreference)) }) } },
    async ({ request, params, body }) => {
      try {
        if (!work.editionPreferences) throw new WorkReadUnavailable('Edition preferences are unavailable');
        const owner = await own(request, body.actingSubject);
        const resource = `https://rezics.com/id/${params.work}`;
        const language = recordedLanguageTag(body.language);
        if (language === 'zxx' || language === 'und') throw new InvalidEditionPreference('Choose a realization language');
        await workRead(work, request, { actingSubject: body.actingSubject }, async session => {
          await readWorkBasis(session, resource);
          if (!body.edition) return;
          if (body.edition.kind === 'realization') {
            const selected = await readWorkRealization(session, resource, body.edition.resource, body.edition.revision);
            if (recordedLanguageTag(selected.language) !== language) throw new InvalidEditionPreference('Edition must pin this Work in the chosen language');
          } else {
            // Current disclosure applies; intent keeps its exact retained pin.
            // Replaying after an imprint correction must still succeed.
            await readWorkRelease(session, resource, body.edition.resource);
            const rows = await session.query(`SELECT ?state WHERE { GRAPH ${iri(GRAPHS.revisions)} {
              ${iri(body.edition.revision)} a rv:ReleaseRevision ; rv:component ${iri(body.edition.resource)} ; rv:releaseState ?state
            } } LIMIT 2`, 1);
            const pinned = rows[0]?.state ? parseStoredRelease(rows[0].state.value) : null;
            const matches = pinned?.profile === 'release-v2'
              ? pinned.resolvedCoverage.some(entry => entry.work === resource && recordedLanguageTag(entry.language) === language)
              : pinned?.work === resource && pinned.contentLanguages.some(tag => recordedLanguageTag(tag) === language);
            if (!matches) {
              throw new InvalidEditionPreference('Edition must pin this Work in the chosen language');
            }
          }
        });
        const result = await work.editionPreferences.write(owner, resource, { language, edition: body.edition },
          body.expectedVersion, request.headers.get('idempotency-key') ?? '',
          async () => { await own(request, body.actingSubject); });
        return Response.json(result, { headers });
      } catch (error) { return failure(error); }
    });
}
