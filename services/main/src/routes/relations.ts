import { transportResponses } from '../transport-responses.ts';
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
import { allocatedParticipation, attributedParticipation, relationAttributionSupport, relationSourceIdentity } from '../modules/relation/v2-contract.ts';
import { relationAttributionVerifier } from '../modules/relation/attribution.ts';
import { readAttributedOccurrence, validateAttributedOccurrence } from '../modules/relation/v2-read.ts';
import { InvalidParticipationAttribution, UnsupportedRelationModel } from '../modules/relation/v2-schema.ts';
import { SemanticChangeRejected } from '../modules/semantic/command.ts';
import { associationEvidenceQuery, associationEvidenceResult, associationEvidenceStale } from '../modules/relation/evidence-contract.ts';
import { associationEvidenceFailure, executeAssociationEvidence } from '../modules/relation/evidence.ts';

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
const relationWriteV2 = t.Object({ ...relationWrite.properties, profile: t.Literal('relation-change-v2'),
  modelGeneration: t.String(), manifest: t.String(), participations: t.Array(allocatedParticipation, { maxItems: 64 }) });
const relationReadV2 = t.Object({ ...relationRead.properties, profile: t.Literal('relation-change-v2'),
  modelGeneration: t.String(), manifest: t.String(), operation: native, receipt: t.String(),
  definition: t.Object({ ...relationRead.properties.definition.properties,
    modelRevision: t.Optional(t.String()), association: t.Optional(t.Object({ kind: t.Union([t.Literal('appearance'), t.Literal('credit')]),
      workRole: t.String(), subjectRoles: t.Array(t.String(), { maxItems: 15 }) }, { additionalProperties: false })) }),
  participations: t.Array(t.Object({ ...relationRead.properties.participations.items.properties,
    sourceIdentity: t.Optional(relationSourceIdentity), attributionSupports: t.Array(relationAttributionSupport, { maxItems: 16 }) }), { maxItems: 64 }),
  attributionProofs: t.Array(t.Object({ participation: native, proof: t.Unknown() }), { maxItems: 1024 }) });
const relationV1Input = t.Object({ profile: t.Literal('relation-change-v1'), occurrence: t.Optional(native),
  expectedHead: t.Nullable(native), definition: native,
  participations: t.Array(t.Object({ role: t.String({ maxLength: 32 }), participant: t.Record(t.String(), t.Unknown()),
    position: t.Optional(t.Integer()), creditedName: t.Optional(creditedName) }, { additionalProperties: false }), { maxItems: 64 }),
  evidence: t.Optional(t.String({ maxLength: 2048 })),
  revealedAt: t.Optional(t.Object({ work: native, occurrence: native }, { additionalProperties: false })),
  applicability: t.Optional(t.Array(native, { maxItems: 8 })),
  lifecycle: t.Optional(t.Union([t.Literal('active'), t.Literal('retired')])), actingSubject: native }, { additionalProperties: false });
const relationV2Input = t.Object({ ...relationV1Input.properties, profile: t.Literal('relation-change-v2'),
  participations: t.Array(attributedParticipation, { minItems: 1, maxItems: 64 }) }, { additionalProperties: false });
const relationProfileProblem = t.Object({ ...problemResult(409).properties, code: t.Literal('unsupported_model_revision'),
  modelRevision: t.String(), schema: t.String() });

function relationError(error: unknown, reading = false): Response {
  if (error instanceof InvalidParticipationAttribution) return problem(422, 'invalid_participation_attribution', error.message);
  if (error instanceof UnsupportedRelationModel) return Response.json({ type: 'https://rezics.com/problems/unsupported_model_revision',
    status: 409, code: 'unsupported_model_revision', title: error.message, modelRevision: error.modelRevision, schema: error.schema },
  { status: 409, headers: { 'cache-control': 'no-store', 'content-type': 'application/problem+json' } });
  if (reading && error instanceof SemanticChangeRejected && error.code === 'unavailable-reference') {
    return problem(404, 'relation_unavailable', 'Relation occurrence is unavailable');
  }
  return semanticError(error);
}

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
  '/v1/relations/{id}/revisions/{revision}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
} as const;

export function relationRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const exact = async (request: Request, actingSubject: string, occurrence: string, revision?: string,
    profile?: 'relation-change-v2') => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    const principal = await work.account.verify(request, [SEMANTIC_READ_SCOPE]);
    if (!await canReadSemantic(work.access, principal, actingSubject, occurrence)) return null;
    return readingPositionRead(work, request, principal, actingSubject, async (boundary, session) => {
    const head = revision ?? (await readCurrentOccurrence(work.environment, occurrence))?.head;
    if (!head) return null;
    const read = await readExactOccurrence(work.environment, occurrence, head);
    if (!read) return null;
    if (read.state.profile && !profile || profile && !read.state.profile) throw new UnsupportedRelationModel();
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
    const result = { profile: 'relation-change-v1' as const, occurrence, revision: read.revision,
      predecessor: read.predecessor, lifecycle: read.state.lifecycle,
      definition: { revision: definition.revision, definition: definition.definition, lifecycle: definition.lifecycle,
        roles: definition.roles.map(role => ({ ...role, key: definition.roleKeys[role.role] })),
        star: definition.star ?? null },
      participations: await disclosedRelationParticipations(work.environment, read.state.participations,
        participants, definition.roleKeys, disclosureViewer(principal, actingSubject)),
      applicability: read.state.applicability.filter(ref => disclosed.has(ref)), sourcePosition: read.sourcePosition };
    if (!profile) return result;
    const owned = await readAttributedOccurrence(work.environment, occurrence, head);
    if (result.participations.some(item => item.availability === 'unavailable'
      || item.creditedName && 'status' in item.creditedName)
      || read.state.applicability.some(ref => !disclosed.has(ref))) return null;
    const check = () => validateAttributedOccurrence(work.environment, owned, definition,
      relationAttributionVerifier(work.relationAttribution, principal, actingSubject));
    const attribution = await check();
    session.observeDependency(`relation-attribution:${occurrence}:${head}`, attribution, check);
    // Source and credit support identities are disclosed by their actual owner
    // above; treating SQL support identities as graph records would invent an owner.
    const decisions = await session.disclosure([occurrence, head].map(resource => ({ owner: 'graph', resource, component: 'record' })));
    if (decisions.some(value => value !== 'visible')) return null;
    return { ...result, profile, modelGeneration: owned.modelGeneration, manifest: owned.manifest, operation: owned.operation,
      receipt: owned.receipt, definition: { ...result.definition, ...(definition.modelRevision ? { modelRevision: definition.modelRevision } : {}),
        ...(definition.association ? { association: definition.association } : {}) },
      participations: result.participations.map((item, index) => ({ ...item,
        role: owned.state.participations[index]!.role,
        ...(owned.state.participations[index]!.sourceIdentity ? { sourceIdentity: owned.state.participations[index]!.sourceIdentity } : {}),
        attributionSupports: owned.state.participations[index]!.attributionSupports ?? [] })),
      attributionProofs: owned.state.attributionProofs!.map(({ participation, proof }) => {
        const { validationToken: _token, ...retained } = proof;
        return { participation, proof: retained };
      }) };
    });
  };
  return new Elysia()
    .post('/v1/relations/changes', {
      body: t.Union([relationV1Input, relationV2Input]),
      response: transportResponses(openApiOperations["/v1/relations/changes"].post, { 200: t.Union([relationWrite, relationWriteV2]),
        201: t.Union([relationWrite, relationWriteV2]), 202: pendingOperation, ...writeProblems,
        409: t.Union([problemResult(409), relationProfileProblem]),
        404: problemResult(404), 422: problemResult(422) }, 'POST'),
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
          ...(body.profile === 'relation-change-v2' ? { attribution: relationAttributionVerifier(work.relationAttribution, principal, body.actingSubject) } : {}),
          input: { ...(body.profile === 'relation-change-v2' ? { profile: body.profile } : {}),
            ...(body.evidence === undefined ? {} : { evidence: body.evidence }), definition: body.definition, participations: body.participations,
            ...(body.revealedAt ? { revealedAt: body.revealedAt } : {}),
            ...(body.applicability ? { applicability: body.applicability } : {}),
            ...(body.lifecycle ? { lifecycle: body.lifecycle } : {}) },
          actingSubject: body.actingSubject, idempotencyKey }, work.platformAccess);
        if (body.profile === 'relation-change-v2') {
          return readingPositionRead(work, request, principal, body.actingSubject, async (_boundary, session) => {
            const owned = await readAttributedOccurrence(work.environment, result.occurrence, result.revision);
            if (!definition) return problem(503, 'association_admission_unavailable', 'Exact authored relation definition is unavailable');
            const check = () => validateAttributedOccurrence(work.environment, owned, definition,
              relationAttributionVerifier(work.relationAttribution, principal, body.actingSubject));
            session.observeDependency(`relation-attribution:${result.occurrence}:${result.revision}`, await check(), check);
            return Response.json({ profile: body.profile, occurrence: result.occurrence, revision: result.revision,
              predecessor: result.predecessor, receipt: owned.receipt, sourcePosition: owned.sourcePosition, replayed: result.replayed,
              modelGeneration: owned.modelGeneration, manifest: owned.manifest,
              participations: owned.state.participations.map(({ iri: id, node: _node, ...item }) => ({ ...item, id,
                attributionSupports: item.attributionSupports ?? [] })) },
            { status: result.replayed || body.occurrence ? 200 : 201, headers: { 'cache-control': 'no-store' } });
          });
        }
        return Response.json({ profile: 'relation-change-v1', occurrence: result.occurrence, revision: result.revision,
          predecessor: result.predecessor, receipt: result.receipt, sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence }, replayed: result.replayed },
        { status: body.occurrence ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return relationError(error); }
    })
    .get('/v1/relations/:id', {
      params: t.Object({ id: groupUuid }),
      query: t.Object({ actingSubject: native, position: readingPositionQuery, profile: t.Optional(t.Literal('relation-change-v2')) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/relations/{id}"].get, { 200: t.Union([relationRead, relationReadV2]), ...authorizedReadProblems,
        409: t.Union([problemResult(409), relationProfileProblem]) }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const read = await exact(request, query.actingSubject, `https://rezics.com/id/${params.id}`, undefined, query.profile);
        if (!read) return problem(404, 'relation_unavailable', 'Relation occurrence is unavailable');
        return Response.json(read, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return relationError(error, true); }
    })
    .get('/v1/relations/:id/revisions/:revision', {
      params: t.Object({ id: groupUuid, revision: groupUuid }),
      query: t.Union([t.Object({ actingSubject: native, position: readingPositionQuery,
        profile: t.Optional(t.Literal('relation-change-v2')) }, { additionalProperties: false }), associationEvidenceQuery]),
      response: transportResponses(openApiOperations["/v1/relations/{id}/revisions/{revision}"].get, {
        200: t.Union([relationRead, relationReadV2, associationEvidenceResult]), ...authorizedReadProblems,
        400: problemResult(400), 409: t.Union([problemResult(409), relationProfileProblem, associationEvidenceStale]) }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        if (query.profile === 'association-evidence-v1') return await executeAssociationEvidence(work, request,
          `https://rezics.com/id/${params.id}`, `https://rezics.com/id/${params.revision}`, query);
        const read = await exact(request, query.actingSubject, `https://rezics.com/id/${params.id}`,
          `https://rezics.com/id/${params.revision}`, query.profile);
        if (!read) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        return Response.json(read, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (query.profile === 'association-evidence-v1') return associationEvidenceFailure(error) ?? relationError(error, true);
        return relationError(error, true);
      }
    });
}
