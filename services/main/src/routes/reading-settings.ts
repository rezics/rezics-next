import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { InvalidReadingSettings, ReadingSettingsConflict, StaleReadingSettings }
  from '../modules/reading-settings/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const id = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const settings = {
  fontSize: t.Union([t.Literal(15), t.Literal(17), t.Literal(19), t.Literal(22), t.Literal(25)]),
  lineWidth: t.Union([t.Literal('narrow'), t.Literal('medium'), t.Literal('wide')]),
  typeface: t.Union([t.Literal('serif'), t.Literal('sans')]), paragraphIndent: t.Boolean(),
  theme: t.Union([t.Literal('system'), t.Literal('light'), t.Literal('dark')]),
  cjkSpacing: t.Union([t.Literal('auto'), t.Literal('none')]),
  cjkPunctuation: t.Union([t.Literal('standard'), t.Literal('strict')]),
};
const response = t.Object({ profile: t.Literal('reader-settings-v1'), ...settings,
  version: t.Integer({ minimum: 0 }), replayed: t.Optional(t.Boolean()) });
const errors = { 400: problemResult(400), 401: problemResult(401), 403: problemResult(403),
  409: problemResult(409), 500: problemResult(500), 503: problemResult(503) };
const noStore = { 'cache-control': 'private, no-store' };

export const openApiOperations = {
  '/v1/reader/settings': { get: { exposure: 'public', bearer: true }, put: { exposure: 'public', bearer: true, idempotencyKey: true } },
} as const;

function failure(error: unknown): Response {
  if (error instanceof InvalidReadingSettings) return problem(400, 'invalid_reader_settings', error.message);
  if (error instanceof StaleReadingSettings) return problem(409, 'stale_reader_settings', error.message);
  if (error instanceof ReadingSettingsConflict) return problem(409, 'reader_settings_conflict', error.message);
  return commandError(error);
}

/** One principal settings row; one baseline person-Agent check per request. */
export function readingSettingsRoutes(work: MainWorkDependencies) {
  const reader = async (request: Request, actingSubject: string) => {
    const principal = await work.account.verify(request, ['work:read']);
    if (!work.access.canReadAsBaselineMember
      || !await work.access.canReadAsBaselineMember(principal, actingSubject)) {
      return null;
    }
    return principal;
  };
  return new Elysia()
    .get('/v1/reader/settings', { query: t.Object({ actingSubject: id }, { additionalProperties: false }),
      response: { 200: response, ...errors },
    }, async ({ request, query }) => {
      if (!work.readingSettings) return problem(503, 'reader_settings_unavailable', 'Reader settings are unavailable');
      try {
        const principal = await reader(request, query.actingSubject);
        if (!principal) return problem(403, 'reader_settings_denied', 'Reader settings are unavailable');
        return Response.json(await work.readingSettings.read(principal), { headers: noStore });
      } catch (error) { return failure(error); }
    })
    .put('/v1/reader/settings', { body: t.Object({ actingSubject: id,
      expectedVersion: t.Integer({ minimum: 0 }), ...settings }, { additionalProperties: false }),
    response: { 200: response, ...errors },
    }, async ({ request, body }) => {
      if (!work.readingSettings) return problem(503, 'reader_settings_unavailable', 'Reader settings are unavailable');
      const key = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
      }
      try {
        const principal = await reader(request, body.actingSubject);
        if (!principal) return problem(403, 'reader_settings_denied', 'Reader settings are unavailable');
        const { actingSubject: _actingSubject, expectedVersion, ...value } = body;
        return Response.json(await work.readingSettings.write(principal, value, expectedVersion, key),
          { headers: noStore });
      } catch (error) { return failure(error); }
    });
}
