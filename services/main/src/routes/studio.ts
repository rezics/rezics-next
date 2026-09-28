import { Elysia, t } from 'elysia';
import { ControlDenied, ControlUnavailable } from '../modules/access/topology-control.ts';
import { readStudioWork, readStudioWorks } from '../modules/studio/works.ts';
import { readStudioChapters } from '../modules/studio/chapters.ts';
import { changeAdmittedComposition } from '../modules/structure/change-admitted.ts';
import { derivedId, readCompositionHeader } from '../modules/structure/graph.ts';
import { GRAPHS, iri } from '../modules/work/activate.ts';
import { readAvatar, readId, readUuid, pageFields } from '../modules/work/read-contract.ts';
import { workRead, WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { compositionError } from './compositions.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/me/agents/{agent}/works': { get: { bearer: true } },
  '/v1/me/agents/{agent}/works/{id}': { get: { bearer: true } },
  '/v1/me/agents/{agent}/works/{id}/chapters': { get: { bearer: true } },
  '/v1/works/{id}/content-variants': { get: { bearer: true } },
  '/v1/works/{id}/chapters': { post: { bearer: true, idempotencyKey: true } },
} as const;

const text = t.Object({ contribution: readId, language: t.String(), draftHead: readId,
  publicationHead: t.Nullable(readId), publicationDraft: t.Nullable(readId) });
const submission = t.Object({ id: readUuid, realm: readId, state: t.String(),
  openedAt: t.String(), updatedAt: t.String() });
const item = t.Object({ id: readId, mainVersion: readId, workRevision: readId,
  mainRevision: readId, title: t.Object({ value: t.String(), language: t.String() }),
  relationship: t.Union([t.Literal('authored'), t.Literal('curated')]),
  cover: readAvatar, types: t.Array(t.String()),
  disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]),
  state: t.Union([t.Literal('empty'), t.Literal('draft'), t.Literal('published')]),
  texts: t.Array(text, { maxItems: 200 }), submissions: t.Array(submission, { maxItems: 200 }),
  createdAt: t.String(), updatedAt: t.String() });
const page = t.Object({ items: t.Array(item, { maxItems: 20 }), ...pageFields });
const workType = t.Union([t.Literal('https://schema.org/Book'),
  t.Literal('https://schema.org/DigitalDocument'), t.Literal('https://schema.org/Recipe')]);
const chapterFacts = t.Object({ occurrence: readId, writer: t.Nullable(readId),
  otherIdentity: t.Boolean(), state: t.Nullable(t.Union([t.Literal('empty'), t.Literal('draft'),
    t.Literal('published'), t.Literal('changed')])), target: t.Nullable(readId),
  label: t.Nullable(t.Object({ value: t.String(), language: t.String() })),
  language: t.Nullable(t.String()) });

export function studioRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/me/agents/:agent/works', {
    params: t.Object({ agent: readUuid }),
    query: t.Object({ state: t.Optional(t.Union([t.Literal('empty'), t.Literal('draft'),
      t.Literal('published')])), type: t.Optional(workType),
    view: t.Optional(t.Union([t.Literal('authored'), t.Literal('curated')])),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) },
    { additionalProperties: false }),
    response: { 200: page, ...workReadProblems },
  }, async ({ request, params, query }) => {
    const agent = `https://rezics.com/id/${params.agent}`;
    try {
      return Response.json(await workRead(work, request,
        { actingSubject: agent, limit: query.limit, cursor: query.cursor },
        session => readStudioWorks(session, agent, { state: query.state, type: query.type,
          view: query.view })),
      { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof ControlDenied) return problem(403, 'studio_denied', 'Agent control is unavailable');
      if (error instanceof ControlUnavailable) return problem(503, 'studio_unavailable', 'Agent authority is unavailable');
      return workReadError(error);
    }
  }).get('/v1/me/agents/:agent/works/:id', {
    params: t.Object({ agent: readUuid, id: readUuid }),
    response: { 200: t.Object({ item, sourcePosition: t.Object({ dataEpoch: t.String(),
      sequence: t.String() }) }), ...workReadProblems },
  }, async ({ request, params }) => {
    const agent = `https://rezics.com/id/${params.agent}`;
    const id = `https://rezics.com/id/${params.id}`;
    try {
      return Response.json(await workRead(work, request, { actingSubject: agent },
        session => readStudioWork(session, agent, id)),
      { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof ControlDenied) return problem(403, 'studio_denied', 'Agent control is unavailable');
      if (error instanceof ControlUnavailable) return problem(503, 'studio_unavailable', 'Agent authority is unavailable');
      return workReadError(error);
    }
  }).get('/v1/me/agents/:agent/works/:id/chapters', {
    params: t.Object({ agent: readUuid, id: readUuid }),
    query: t.Object({ cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
      language: t.Optional(t.String({ minLength: 2, maxLength: 35 })) }, { additionalProperties: false }),
    response: { 200: t.Object({ profile: t.Literal('studio-chapters-v1'),
      page: t.Object({ profile: t.Literal('work-contents-v1'), work: readId, version: readId,
        composition: readId, compositionRevision: readId, language: t.Nullable(t.String()),
        items: t.Array(t.Object({ occurrence: readId, parent: readId,
          role: t.Union([t.Literal('group'), t.Literal('chapter')]),
          label: t.Nullable(t.Object({ value: t.String(), language: t.String() })),
          target: t.Nullable(readId), selectedRevision: t.Nullable(t.String()),
          progress: t.Nullable(t.Object({ composition: readId, occurrence: readId,
            selectedRevision: t.String() })),
          availability: t.Union([t.Literal('available'), t.Literal('unavailable')]) }), { maxItems: 20 }),
        ...pageFields }), facts: t.Array(chapterFacts, { maxItems: 20 }) }), ...workReadProblems },
  }, async ({ request, params, query }) => {
    const agent = `https://rezics.com/id/${params.agent}`;
    const book = `https://rezics.com/id/${params.id}`;
    try {
      return Response.json(await workRead(work, request, { actingSubject: agent, cursor: query.cursor },
        session => readStudioChapters(session, agent, book, query)),
      { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof ControlDenied) return problem(403, 'studio_denied', 'Agent control is unavailable');
      if (error instanceof ControlUnavailable) return problem(503, 'studio_unavailable', 'Agent authority is unavailable');
      return workReadError(error);
    }
  }).get('/v1/works/:id/content-variants', {
    params: t.Object({ id: readUuid }),
    query: t.Object({ actingSubject: readId,
      limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
      cursor: t.Optional(t.String({ minLength: 1, maxLength: 300 })) },
    { additionalProperties: false }),
    response: { 200: t.Object({ work: readId,
      items: t.Array(t.Object({ variantId: t.String(),
        language: t.Object({ kind: t.String(), tag: t.Nullable(t.String()),
          originalTag: t.Nullable(t.String()) }), direction: t.String(),
        draftHead: t.Nullable(t.String()), publicationHead: t.Nullable(t.String()),
        eligibilityHead: t.Nullable(t.String()) }), { maxItems: 20 }),
      nextCursor: t.Nullable(t.String()), sourcePosition: t.Object({
        owner: t.Literal('content'), dataEpoch: t.String(), sequence: t.String() }) }),
      ...workReadProblems },
  }, async ({ request, params, query }) => {
    const resource = `https://rezics.com/id/${params.id}`;
    try {
      return Response.json(await workRead(work, request, { actingSubject: query.actingSubject }, async session => {
        if (!session.principal || !work.contentAuthoring) {
          throw new WorkReadUnavailable('Content owner is unavailable');
        }
        if (!work.studioAccess) throw new WorkReadUnavailable('Content authority is unavailable');
        if (!await work.studioAccess.canReadContentVariants(session.principal, query.actingSubject, resource)) {
          throw new WorkReadMissing('Content variants are unavailable');
        }
        const current = await session.query(`SELECT ?work WHERE { GRAPH ${iri(GRAPHS.current)} {
          BIND(${iri(resource)} AS ?work) ?work a schema:CreativeWork . } } LIMIT 2`, 2);
        if (current.length !== 1) throw new WorkReadMissing('Work is unavailable');
        const content = work.contentAuthoring;
        const listed = await content.listVariantHeads(resource, query.cursor ?? '', query.limit ?? 20);
        const heads = listed.items.length ? await session.query(`SELECT ?variant ?publication ?eligibility WHERE {
          VALUES ?variant { ${listed.items.map(item => iri(item.id)).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ${iri(resource)} .
            OPTIONAL { ?variant rv:contentPublicationHead ?publication }
            OPTIONAL { ?variant rv:publicSearchEligibilityHead ?eligibility } }
        } LIMIT ${listed.items.length + 1}`, listed.items.length + 1) : [];
        if (new Set(heads.map(row => row.variant?.value)).size !== heads.length) {
          throw new WorkReadUnavailable('Content variant heads are ambiguous');
        }
        const byVariant = new Map(heads.map(row => [row.variant!.value, row]));
        const after = await content.ownerPosition();
        if (after.dataEpoch !== listed.position.dataEpoch
          || after.sequence !== listed.position.sequence) {
          throw new WorkReadMoved('Content variant page changed');
        }
        if (!await work.studioAccess.canReadContentVariants(session.principal, query.actingSubject, resource)) {
          throw new WorkReadMoved('Content variant authority changed');
        }
        return { work: resource, items: listed.items.map(item => ({ variantId: item.id,
          language: { kind: item.languageKind, tag: item.languageTag,
            originalTag: item.originalLanguageTag }, direction: item.direction,
          draftHead: item.draftHead, publicationHead: byVariant.get(item.id)?.publication?.value ?? null,
          eligibilityHead: byVariant.get(item.id)?.eligibility?.value ?? null })),
        nextCursor: listed.nextCursor, sourcePosition: listed.position };
      }), { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return workReadError(error); }
  }).post('/v1/works/:id/chapters', {
    params: t.Object({ id: readUuid }),
    body: t.Object({ profile: t.Literal('book-chapter-create-v1'),
      title: t.String({ minLength: 1, maxLength: 200 }),
      language: t.String({ minLength: 2, maxLength: 35,
        pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
      direction: t.Union([t.Literal('ltr'), t.Literal('rtl'), t.Literal('none')]),
      parent: readId,
      position: t.Union([t.Literal('first'), t.Literal('last'),
        t.Object({ after: readId }, { additionalProperties: false })]),
      expectedCompositionHead: readId, actingSubject: readId,
    }, { additionalProperties: false }),
    response: { 200: t.Object({ work: readId, mainVersion: readId,
      workRevision: readId, mainRevision: readId, occurrence: readId,
      structure: readId, compositionRevision: readId, variantId: t.String(),
      language: t.String(), direction: t.String(), receipt: t.String(),
      replayed: t.Boolean(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
        dataEpoch: t.String(), sequence: t.String() }) }),
    400: workReadProblems[400], 401: workReadProblems[401],
    403: workReadProblems[403], 404: workReadProblems[404],
    409: workReadProblems[409], 500: workReadProblems[500],
    503: workReadProblems[503] },
  }, async ({ request, params, body }) => {
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
      return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
    }
    const parentWork = `https://rezics.com/id/${params.id}`;
    try {
      const candidates = (await work.environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        PREFIX schema: <https://schema.org/> SELECT ?main ?structure WHERE {
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(parentWork)} a schema:Book ; rv:mainVersion ?main .
          ?structure a rv:Structure ; rv:structureOf ?main ;
            rv:structureProfile rv:BookComposition . }
      } LIMIT 2`)).results?.bindings ?? [];
      if (candidates.length !== 1 || !candidates[0]?.structure || !candidates[0]?.main) {
        return problem(404, 'composition_unavailable', 'Book composition is unavailable');
      }
      const structure = candidates[0].structure.value;
      const header = await readCompositionHeader(work.environment, structure);
      if (!header || header.owner !== parentWork || header.profile !== 'book-composition') {
        return problem(404, 'composition_unavailable', 'Book composition is unavailable');
      }
      const seed = `${parentWork}\0${body.actingSubject}\0${key}\0chapter`;
      const chapter = { work: derivedId(`${seed}\0work`),
        mainVersion: derivedId(`${seed}\0main`),
        workRevision: derivedId(`${seed}\0work-revision`),
        mainRevision: derivedId(`${seed}\0main-revision`),
        title: body.title, language: body.language, direction: body.direction };
      const operation = { op: 'insert' as const, parent: body.parent,
        position: body.position, role: 'chapter' as const, target: chapter.work,
        label: { value: body.title, language: body.language } };
      const result = await changeAdmittedComposition(work.environment, work.account, work.access,
        request, { structure, expectedHead: body.expectedCompositionHead,
          operations: [operation], newWork: chapter, actingSubject: body.actingSubject,
          idempotencyKey: key });
      if (!result.revision || result.chapterWork !== chapter.work
        || result.chapterMainVersion !== chapter.mainVersion
        || result.chapterWorkRevision !== chapter.workRevision
        || result.chapterMainRevision !== chapter.mainRevision) {
        throw new WorkReadUnavailable('Chapter receipt is incomplete');
      }
      const variantId = `urn:rezics:variant:${derivedId(`${seed}\0variant`).slice(-36)}`;
      const occurrence = result.occurrences?.[0] ?? derivedId(`${result.revision}\0occurrence\0${0}`);
      return Response.json({ work: chapter.work, mainVersion: chapter.mainVersion,
        workRevision: chapter.workRevision, mainRevision: chapter.mainRevision,
        occurrence, structure, compositionRevision: result.revision,
        variantId, language: body.language, direction: body.direction,
        receipt: result.receipt, replayed: result.replayed,
        sourcePosition: { datasetId: 'product', dataEpoch: result.dataEpoch,
          sequence: result.sequence } }, { status: 200, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return compositionError(error); }
  });
}
