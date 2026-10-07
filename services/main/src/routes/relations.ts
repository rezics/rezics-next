import { Elysia, t } from 'elysia';
import { relationStar } from './lexicon.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { readCurrentOccurrence, readExactDefinition, readExactOccurrence, relationRevelation } from '../modules/relation/change.ts';
import { admittedRelationChange, canReadSemantic, referenceReader, SEMANTIC_READ_SCOPE } from '../modules/semantic/admitted.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { semanticError } from './semantic.ts';
import { admittedWorkRelationChange } from '../modules/relation/work-authority.ts';
import { discloseInventory } from '../modules/disclosure/read.ts';
import { disclosureViewer } from '../modules/disclosure/viewer.ts';
import type { WorkActivationEnvironment } from '../modules/work/activate.ts';
import type { Participation } from '../modules/relation/schema.ts';
import type { Viewer } from '../modules/suitability/policy.ts';
import { semanticReaderOnly, systemDisclosure, targetDisclosed } from '../modules/target/disclosed-references.ts';
import { withheldReadName } from '../modules/work/read-contract.ts';
import { groupUuid } from './shared.ts';
import { readingPositionRead } from '../modules/reading-position/read.ts';
import { readingPositionQuery } from './reading-positions.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const position = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() });
const relationWrite = t.Object({ profile: t.Literal('relation-change-v1'), occurrence: t.String(),
  revision: t.String(), predecessor: t.Nullable(t.String()), receipt: t.String(), sourcePosition: position,
  replayed: t.Boolean() });
const creditedName = t.Object({ lexical: t.String({ minLength: 1, maxLength: 200 }),
  language: t.String({ minLength: 2, maxLength: 35 }) }, { additionalProperties: false });
const creditedNameRead = t.Union([creditedName, withheldReadName]);
const relationRead = t.Object({ profile: t.Literal('relation-change-v1'), occurrence: t.String(),
  revision: t.String(), predecessor: t.Nullable(t.String()), lifecycle: t.String(),
  definition: t.Object({ revision: t.String(), definition: t.String(), lifecycle: t.String(),
    roles: t.Array(t.Unknown()), star: t.Nullable(relationStar) }),
  participations: t.Array(t.Object({ participation: t.String(), role: t.String(), participant: t.Unknown(),
    position: t.Optional(t.Integer()), creditedName: t.Optional(creditedNameRead), availability: t.String() })),
  applicability: t.Array(t.String()), sourcePosition: position });

/** Participant readability and the credited name are separate. A readable resource participant
 * keeps its identity when the name policy withholds the name; an external credit has no person owner.
 * The bounded name inventory resolves Agent owners; other resources use ordinary disclosure. */
export async function disclosedRelationParticipations(
  environment: WorkActivationEnvironment,
  participations: readonly (Participation & { iri: string })[],
  participants: ReadonlySet<string>, roleKeys: Readonly<Record<string, string>>, viewer: Viewer,
) {
  const candidates = [...new Set(participations.flatMap(item =>
    item.participant.kind === 'resource' && item.creditedName && participants.has(item.participant.ref)
      ? [item.participant.ref] : []))];
  const names = await discloseInventory(environment, candidates.map(resource => ({
    owner: 'graph' as const, resource, component: 'name' as const,
  })), viewer, 'read');
  const visible = new Set(candidates.filter((_, index) => names[index] === 'visible'));
  return participations.map(item => {
    const availability = item.participant.kind === 'external' ? 'external' as const
      : item.participant.kind === 'resource' && participants.has(item.participant.ref) ? 'available' as const
      : 'unavailable' as const;
    const credited = !item.creditedName || availability === 'unavailable' ? undefined
      : item.participant.kind !== 'resource' || visible.has(item.participant.ref) ? item.creditedName
        : { reference: item.participant.ref, status: 'unavailable' as const };
    return { participation: item.iri, role: roleKeys[item.role] ?? item.role,
      participant: availability === 'unavailable' ? { kind: 'unavailable-reference' as const } : item.participant,
      ...(item.position === undefined ? {} : { position: item.position }),
      ...(credited ? { creditedName: credited } : {}), availability };
  });
}

export const openApiOperations = {
  '/v1/relations/changes': { post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/relations/{id}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
  '/v1/relations/{id}/revisions/{revision}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: true } },
} as const;

export function relationRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const exact = async (request: Request, actingSubject: string, occurrence: string, revision?: string) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    const principal = await work.account.verify(request, [SEMANTIC_READ_SCOPE]);
    if (!await canReadSemantic(work.access, principal, actingSubject, occurrence)) return null;
    return readingPositionRead(work, request, principal, actingSubject, async boundary => {
    const head = revision ?? (await readCurrentOccurrence(work.environment, occurrence))?.head;
    if (!head) return null;
    const read = await readExactOccurrence(work.environment, occurrence, head);
    if (!read) return null;
    // The occurrence pins its exact DefinitionRef; a later retirement never retargets it.
    const semanticReadable = referenceReader(work.access, principal, actingSubject);
    const canRead = async (ref: string) => await semanticReadable(ref) && (await boundary.visible([ref])).has(ref);
    // Only identities reach role members and participant references. Private names are gated separately.
    // Concepts may be public through the target reader without a semantic read grant.
    const disclose = async (references: readonly string[]) => {
      const disclosedByTarget = await targetDisclosed(work.environment,
        { access: work.access, principal, actingSubject }, references);
      const admittedByReader = await semanticReaderOnly(canRead)(
        references.filter(ref => !disclosedByTarget.has(ref)));
      return new Set([...disclosedByTarget, ...admittedByReader]);
    };
    const definition = await readExactDefinition(work.environment, read.state.definition, disclose, canRead);
    if (!definition) return null;
    const disclosed = await boundary.visible([occurrence, definition.definition, ...read.state.applicability]);
    if (!disclosed.has(occurrence) || !disclosed.has(definition.definition)) return null;
    const resourceRefs = read.state.participations.flatMap(item =>
      item.participant.kind === 'resource' ? [item.participant.ref] : []);
    const participants = await disclose(resourceRefs);
    return { profile: 'relation-change-v1' as const, occurrence, revision: read.revision,
      predecessor: read.predecessor, lifecycle: read.state.lifecycle,
      definition: { revision: definition.revision, definition: definition.definition, lifecycle: definition.lifecycle,
        roles: definition.roles.map(role => ({ ...role, key: definition.roleKeys[role.role] })),
        star: definition.star ?? null },
      participations: await disclosedRelationParticipations(work.environment, read.state.participations,
        participants, definition.roleKeys, disclosureViewer(principal, actingSubject)),
      applicability: read.state.applicability.filter(ref => disclosed.has(ref)), sourcePosition: read.sourcePosition };
    });
  };
  return new Elysia()
    .post('/v1/relations/changes', {
      body: t.Object({ profile: t.Literal('relation-change-v1'), occurrence: t.Optional(native),
        expectedHead: t.Nullable(native), definition: native,
        participations: t.Array(t.Object({ role: t.String({ maxLength: 32 }), participant: t.Record(t.String(), t.Unknown()),
          position: t.Optional(t.Integer()), creditedName: t.Optional(creditedName) },
          { additionalProperties: false }), { maxItems: 64 }),
        evidence: t.Optional(t.String({ maxLength: 2048 })),
        revealedAt: t.Optional(t.Object({ work: native, occurrence: native }, { additionalProperties: false })),
        applicability: t.Optional(t.Array(native, { maxItems: 8 })),
        lifecycle: t.Optional(t.Union([t.Literal('active'), t.Literal('retired')])), actingSubject: native },
      { additionalProperties: false }),
      response: { 200: relationWrite, 201: relationWrite, 202: pendingOperation, ...writeProblems,
        404: problemResult(404), 422: problemResult(422) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const principal = await work.account.verify(request, ['work:edit']);
        const readable = referenceReader(work.access, principal, body.actingSubject);
        // Only the write path (`workSubjectRole`) is read here; no role member reaches a response.
        const definition = await readExactDefinition(work.environment, body.definition, systemDisclosure);
        const change = definition?.workSubjectRole ? admittedWorkRelationChange : admittedRelationChange;
        const result = await change(work.environment, work.account, work.access, request, {
          ...(body.occurrence ? { occurrence: body.occurrence } : {}), expectedHead: body.expectedHead,
          ...(body.revealedAt ? { beforeCommit: relationRevelation(work.environment, work.readingPositions, body.revealedAt) } : {}),
          canReadConflict: async ref => await readable(ref) && await readingPositionRead(work, request, principal,
            body.actingSubject, async boundary => (await boundary.visible([ref])).has(ref)),
          input: { ...(body.evidence === undefined ? {} : { evidence: body.evidence }), definition: body.definition, participations: body.participations,
            ...(body.revealedAt ? { revealedAt: body.revealedAt } : {}),
            ...(body.applicability ? { applicability: body.applicability } : {}),
            ...(body.lifecycle ? { lifecycle: body.lifecycle } : {}) },
          actingSubject: body.actingSubject, idempotencyKey }, work.platformAccess);
        return Response.json({ profile: 'relation-change-v1', occurrence: result.occurrence, revision: result.revision,
          predecessor: result.predecessor, receipt: result.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence }, replayed: result.replayed },
        { status: body.occurrence ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/relations/:id', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: native, position: readingPositionQuery }, { additionalProperties: false }),
      response: { 200: relationRead, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const read = await exact(request, query.actingSubject, `https://rezics.com/id/${params.id}`);
        if (!read) return problem(404, 'relation_unavailable', 'Relation occurrence is unavailable');
        return Response.json(read, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    })
    .get('/v1/relations/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: native, position: readingPositionQuery }, { additionalProperties: false }),
      response: { 200: relationRead, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const read = await exact(request, query.actingSubject, `https://rezics.com/id/${params.id}`,
          `https://rezics.com/id/${params.revision}`);
        if (!read) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        return Response.json(read, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return semanticError(error); }
    });
}
