import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { ModProfileInvalid, ModResolutionConflict, ModResolutionUnavailable }
  from '../modules/package/mod-resolution.ts';
import { MOD_RELEASE_COST, modCompatibility, modReleaseChannel } from '../modules/package/mod-release.ts';
import { GRAPHS, iri } from '../modules/work/activate.ts';
import { publicWork, workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupUuid } from './shared.ts';

const ecosystem = t.Union(['fabric', 'forge', 'neoforge', 'modrinth', 'curseforge',
  'nexus', 'steam'].map(value => t.Literal(value)));
const capture = t.Object({ identity: t.String({ minLength: 1, maxLength: 160 }),
  surface: t.String({ minLength: 1, maxLength: 160 }),
  status: t.Union([t.Literal('observed'), t.Literal('inaccessible')]),
  bytesBase64: t.Nullable(t.String({ maxLength: 87_384 })),
  sha256: t.Nullable(t.String({ pattern: '^[0-9a-f]{64}$' })),
  sourceUrl: t.Optional(t.String({ format: 'uri', maxLength: 512 })),
  httpStatus: t.Optional(t.Integer({ minimum: 100, maximum: 599 })),
  nestedOf: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  nestedPath: t.Optional(t.String({ minLength: 1, maxLength: 164 })),
}, { additionalProperties: false });
const requestSchema = t.Object({ profile: t.Union([t.Literal('mod-native-capture-v1'),
  t.Literal('mod-native-capture-v2')]),
  ecosystem, side: t.Union([t.Literal('CLIENT'), t.Literal('SERVER')]),
  runtime: t.Optional(t.Object({ loaderVersion: t.String({ maxLength: 32 }),
    gameVersion: t.String({ maxLength: 32 }),
    features: t.Optional(t.Object({ openGLVersion: t.Optional(t.String({ maxLength: 32 })),
      javaVersion: t.Optional(t.String({ maxLength: 32 })) }, { additionalProperties: false })),
  }, { additionalProperties: false })),
  root: t.String({ minLength: 1, maxLength: 160 }),
  captures: t.Array(capture, { maxItems: 33 }),
}, { additionalProperties: false });
const relation = t.Object({ from: t.String(), to: t.String(), kind: t.String(),
  strength: t.Union(['hard', 'advisory', 'metadata', 'embedded', 'collection']
    .map(value => t.Literal(value))), range: t.Nullable(t.Union([t.String(),
    t.Array(t.String())])), side: t.Nullable(t.String()) });
const issue = t.Object({ source: t.String(), target: t.Nullable(t.String()), kind: t.String() });
const outcome = t.Object({ provenance: t.Literal('caller-supplied-captures'),
  selection: t.Union(['valid', 'unsatisfiable',
  'incomplete-source-data', 'unsupported-semantics', 'budget-exhausted']
  .map(value => t.Literal(value))),
  ordering: t.Union([t.Literal('valid'), t.Literal('cycle'), t.Literal('not-evaluated')]),
  relations: t.Array(relation), issues: t.Array(issue), independentDownloads: t.Array(t.String()),
  coverage: t.Array(t.Object({ identity: t.String(), surface: t.String(),
    status: t.Union([t.Literal('observed'), t.Literal('inaccessible')]),
    sha256: t.Nullable(t.String()), sourceUrl: t.Optional(t.String()),
    httpStatus: t.Optional(t.Number()) })),
  cost: t.Object({ inputBytes: t.Number(), captures: t.Number(), relations: t.Number(),
    comparisons: t.Number() }),
});
const receipt = t.Object({ profile: t.Union([t.Literal('mod-native-capture-receipt-v1'),
  t.Literal('mod-native-capture-receipt-v2')]),
  resolution: t.String(), requestDigest: t.String(), request: requestSchema,
  outcome, createdAt: t.String() });
const written = t.Object({ resolution: receipt, replayed: t.Boolean() });
const publicCard = t.Object({ profile: t.Literal('mod-work-card-v1'), game: t.Literal('Minecraft'),
  gameVersions: t.Array(t.String({ maxLength: 32 }), { maxItems: 1 }),
  loaders: t.Array(t.Union([t.Literal('Fabric'), t.Literal('Forge'), t.Literal('NeoForge')]),
    { maxItems: 1 }), latestRelease: t.Nullable(t.String({ maxLength: 64 })), capturedAt: t.String() });
const binding = t.Object({ work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
  actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
  /** The owner's notes for this release, shown with it as plain text. */
  changelog: t.Optional(t.String({ maxLength: MOD_RELEASE_COST.changelogCharacters })) },
{ additionalProperties: false });
const loader = t.Union([t.Literal('Fabric'), t.Literal('Forge'), t.Literal('NeoForge')]);
const release = t.Object({ profile: t.Literal('mod-release-v1'),
  /** Null for a release disclosed before its native ID, environment and dependencies were. */
  mod: t.Nullable(t.Object({ id: t.String({ maxLength: 160 }),
    ecosystem: t.Union([t.Literal('fabric'), t.Literal('forge'), t.Literal('neoforge')]) })),
  version: t.Nullable(t.String({ maxLength: 64 })), game: t.Literal('Minecraft'),
  gameVersions: t.Array(t.String({ maxLength: 32 }), { maxItems: 16 }), loaders: t.Array(loader, { maxItems: 3 }),
  environment: t.Nullable(t.Union([t.Literal('client'), t.Literal('server'), t.Literal('client-and-server')])),
  dependencies: t.Nullable(t.Array(t.Object({ id: t.String({ maxLength: 160 }),
    requirement: t.Union([t.Literal('required'), t.Literal('optional'), t.Literal('incompatible'),
      t.Literal('embedded')]),
    range: t.Nullable(t.String({ maxLength: MOD_RELEASE_COST.rangeCharacters })),
    side: t.Nullable(t.Union([t.Literal('client'), t.Literal('server')])) }),
  { maxItems: MOD_RELEASE_COST.dependencies })),
  changelog: t.Nullable(t.String({ maxLength: MOD_RELEASE_COST.changelogCharacters })),
  capturedAt: t.String(), publishedAt: t.String(),
  channel: t.Nullable(t.Union([t.Literal('release'), t.Literal('beta'), t.Literal('alpha')])) });
const releasePage = t.Object({ profile: t.Literal('mod-releases-v1'), work: t.String(),
  items: t.Array(release, { maxItems: MOD_RELEASE_COST.pageSize }), nextCursor: t.Nullable(t.String()) });
const releaseQuery = t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: MOD_RELEASE_COST.pageSize })),
  cursor: t.Optional(t.String({ maxLength: 256 })) }, { additionalProperties: false });
const exactQuery = t.Object({ game: t.Literal('Minecraft'),
  gameVersion: t.String({ pattern: '^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$' }), loader,
  side: t.Union([t.Literal('client'), t.Literal('server')]) }, { additionalProperties: false });
const exactResult = t.Object({ profile: t.Literal('mod-exact-compatibility-v1'),
  state: t.Union([t.Literal('compatible'), t.Literal('stale'), t.Literal('unknown'), t.Literal('incompatible')]),
  release: t.Nullable(t.Object({ version: t.Nullable(t.String({ maxLength: 64 })), publishedAt: t.String(),
    channel: t.Nullable(t.Union([t.Literal('release'), t.Literal('beta'), t.Literal('alpha')])),
    dependencies: release.properties.dependencies })) });

/** A release page cursor: the last release's stored time and key, never a receipt id. */
const encodeCursor = (after: { boundAt: string; key: string }) =>
  Buffer.from(JSON.stringify([after.boundAt, after.key])).toString('base64url');
function decodeCursor(cursor: string): { boundAt: string; key: string } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
      && value[0].length <= 64 && !Number.isNaN(Date.parse(value[0].replace(' ', 'T'))) && value[1].length <= 256) {
      return { boundAt: value[0], key: value[1] };
    }
  } catch { /* not a cursor this route issued */ }
  return null;
}

export const openApiOperations = {
  '/v1/package-resolutions/mods': { post: { exposure: 'platform:developer-extras', bearer: true, idempotencyKey: true } },
  '/v1/package-resolutions/mods/{resolution}': { get: { exposure: 'platform:developer-extras', bearer: true } },
  '/v1/package-resolutions/mods/{resolution}/work-binding': {
    post: { exposure: 'platform:developer-extras', bearer: true, idempotencyKey: true } },
  '/v1/mod-compatibility/{work}': { get: { exposure: 'platform:developer-extras', bearer: false } },
  '/v1/mod-compatibility/{work}/exact': { get: { exposure: 'platform:developer-extras', bearer: false } },
  '/v1/mod-releases/{work}': { get: { exposure: 'platform:developer-extras', bearer: false } },
} as const;

async function publicModWork(work: MainWorkDependencies, request: Request, id: string): Promise<boolean> {
  return workRead(work, new Request(request.url), {}, async session => {
    const rows = await session.query(`SELECT ?work WHERE {
      BIND(${iri(id)} AS ?work)
      GRAPH ${iri(GRAPHS.current)} { ?work a rv:ModPackage ; rv:mainVersion ?main . }
      ${publicWork('?work', '?main')}
    } LIMIT 2`, 2);
    return rows.length === 1;
  });
}

function modError(error: unknown): Response {
  if (error instanceof ModProfileInvalid) return problem(422, 'invalid_mod_capture', error.message);
  if (error instanceof ModResolutionConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof ModResolutionUnavailable) return problem(503, 'mod_resolution_unavailable',
    'Stored mod capture is unavailable');
  return commandError(error);
}

/** POST: one Account and Access check, bounded O(C·B+C²+R) profile, one insert and indexed read.
 * GET: one Account and Access check, one indexed row and bounded revalidation.
 * Public reads: one graph check that the Work is a public mod, then one indexed page. */
export function packageModRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/package-resolutions/mods', {
      body: requestSchema,
      response: { 200: written, 201: written, ...writeProblems, 422: problemResult(422) },
    }, async ({ request, body }) => {
      try {
        if (!work.packageModResolutions) return problem(503, 'mod_resolution_unavailable',
          'Mod resolution owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:resolve']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageModResolutions.resolve(principalId, key, body);
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return modError(error); }
    })
    .get('/v1/package-resolutions/mods/:resolution', {
      params: t.Object({ resolution: groupUuid }),
      response: { 200: receipt, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.packageModResolutions) return problem(503, 'mod_resolution_unavailable',
          'Mod resolution owner is unavailable');
        const principal = await work.account.verify(request, ['package:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Package principal is inactive');
        const result = await work.packageModResolutions.read(principalId, params.resolution);
        if (!result) return problem(404, 'mod_resolution_missing', 'Mod resolution is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return modError(error); }
    })
    .post('/v1/package-resolutions/mods/:resolution/work-binding', {
      params: t.Object({ resolution: groupUuid }), body: binding,
      response: { 200: publicCard, 201: publicCard, ...writeProblems, 422: problemResult(422) },
    }, async ({ request, params, body }) => {
      try {
        const store = work.packageModResolutions;
        if (!store || !work.access.withWorkEditAuthority) return problem(503, 'mod_resolution_unavailable',
          'Mod binding owner is unavailable');
        if (!request.headers.get('idempotency-key')) return problem(400, 'invalid_idempotency_key',
          'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['package:resolve', 'work:edit']);
        if (!await publicModWork(work, request, body.work)) return problem(404, 'work_unavailable',
          'Public mod Work is unavailable');
        const card = await work.access.withWorkEditAuthority(principal, body.actingSubject, body.work,
          proof => store.bind(proof.principalId, params.resolution, body.work, body.changelog ?? null));
        return Response.json(card, { status: 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return modError(error); }
    })
    .get('/v1/mod-compatibility/:work', {
      params: t.Object({ work: groupUuid }),
      response: { 200: publicCard, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        const store = work.packageModResolutions;
        if (!store) return problem(503, 'mod_resolution_unavailable', 'Mod binding owner is unavailable');
        const id = `https://rezics.com/id/${params.work}`;
        if (!await publicModWork(work, request, id)) return problem(404, 'work_unavailable',
          'Public mod Work is unavailable');
        const card = (await store.readCards([id])).get(id);
        return card ? Response.json(card, { headers: { 'cache-control': 'no-store' } })
          : problem(404, 'mod_compatibility_missing', 'No public mod compatibility is bound');
      } catch (error) { return modError(error); }
    })
    /** O(R) indexed rows for one Work, R ≤ 128; the store refuses a larger history. */
    .get('/v1/mod-compatibility/:work/exact', {
      params: t.Object({ work: groupUuid }), query: exactQuery,
      response: { 200: exactResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const store = work.packageModResolutions;
        if (!store) return problem(503, 'mod_resolution_unavailable', 'Mod compatibility owner is unavailable');
        const id = `https://rezics.com/id/${params.work}`;
        if (!await publicModWork(work, request, id)) return problem(404, 'work_unavailable',
          'Public mod Work is unavailable');
        const releases = (await store.readBrowseListings([id])).get(id)?.releases ?? [];
        const result = modCompatibility(releases, { gameVersions: [query.gameVersion], loaders: [query.loader],
          environments: [query.side] });
        return Response.json({ profile: 'mod-exact-compatibility-v1', state: result.state,
          release: result.release ? { version: result.release.version, publishedAt: result.release.publishedAt,
            channel: modReleaseChannel(result.release.version), dependencies: result.release.dependencies } : null },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return modError(error); }
    })
    .get('/v1/mod-releases/:work', {
      params: t.Object({ work: groupUuid }), query: releaseQuery,
      response: { 200: releasePage, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const store = work.packageModResolutions;
        if (!store) return problem(503, 'mod_resolution_unavailable', 'Mod release owner is unavailable');
        const id = `https://rezics.com/id/${params.work}`;
        const after = query.cursor ? decodeCursor(query.cursor) : undefined;
        if (after === null) return problem(400, 'invalid_cursor', 'Mod release cursor is invalid');
        if (!await publicModWork(work, request, id)) return problem(404, 'work_unavailable',
          'Public mod Work is unavailable');
        const page = await store.readReleases(id, query.limit ?? MOD_RELEASE_COST.pageSize, after);
        return Response.json({ profile: 'mod-releases-v1', work: id, items: page.items,
          nextCursor: page.next ? encodeCursor(page.next) : null }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return modError(error); }
    });
}
