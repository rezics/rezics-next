import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import { changeAdmittedProtection, decideAdmittedCorrection, proposeAdmittedCorrection, ProtectionDenied }
  from '../modules/protection/admitted.ts';
import { MAX_EDITORIAL_TARGETS, ProtectionIdempotencyConflict, ProtectionInvalid, type ContentProtectionStore,
  type OwnerOutcome } from '../modules/protection/content-store.ts';
import { PROTECTION_CONFLICTS } from '../modules/protection/schema.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

/** The Content owner store is injected by the composition root when Content protection is enabled. */
export type ProtectionDependencies = MainWorkDependencies & { editorialProtection?: ContentProtectionStore };

const NATIVE = '^https://rezics\\.com/id/[0-9a-f-]{36}$';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const VARIANT = '^urn:rezics:variant:[0-9a-f-]{36}$';
const ownerPosition = t.Object({ owner: t.Literal('content'), dataEpoch: t.String(), sequence: t.String() });
const outcome = t.Object({ operation: t.String(), value: t.Unknown(), position: ownerPosition, replayed: t.Boolean() });
const nullableRef = t.Union([t.String(), t.Null()]);
const protectionState = t.Object({ id: t.String(), epoch: t.String(),
  action: t.Union([t.Literal('tighten'), t.Literal('confirm'), t.Literal('relax')]),
  mode: t.Union([t.Literal('open'), t.Literal('review-required')]), ruleRevision: t.String() });
const proposal = t.Object({ proposal: t.String(), proposalRevision: t.String(), revisionNumber: t.Number(),
  predecessor: nullableRef, resourceId: t.String(), variantId: t.String(), baseHead: t.String(),
  baseProtection: nullableRef, ruleRevision: t.String(), candidateRevision: t.String(), candidateDigest: t.String(),
  evidence: t.Array(t.String()), reason: t.String(), agent: nullableRef });
const application = t.Object({ baseHead: t.String(), successorHead: t.String(), protectionHead: nullableRef });
const decision = t.Object({ decision: t.String(), proposalRevision: t.String(),
  outcome: t.Union([t.Literal('approved'), t.Literal('rejected')]), candidateDigest: t.String(),
  independenceProof: nullableRef, evidence: t.Array(t.String()), reason: t.String(), agent: nullableRef,
  application: t.Union([application, t.Null()]) });
const editorialState = t.Object({ resourceId: t.String(), variantId: t.String(), contentHead: nullableRef,
  protection: t.Union([protectionState, t.Null()]),
  effectiveMode: t.Union([t.Literal('open'), t.Literal('review-required')]), ruleRevision: t.String() });
const basis = {
  actingSubject: t.String({ pattern: NATIVE }),
  expectedContentHead: t.String({ pattern: UUID }),
  // Explicit null asserts the absent head; omission is invalid.
  expectedProtectionHead: t.Union([t.String({ pattern: UUID }), t.Null()]),
  expectedRuleRevision: t.String({ minLength: 1, maxLength: 300 }),
  reason: t.String({ minLength: 1, maxLength: 2000 }),
  evidence: t.Array(t.String({ minLength: 1, maxLength: 300 }), { maxItems: 32 }),
};
const writeResponses = { 200: outcome, 201: outcome, ...writeProblems, 404: problemResult(404) };

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9:_./-]{1,128}$/.test(key) ? key : null;
}

/** Owner outcomes map to typed problems; a replay returns the recorded outcome, never a new evaluation. */
function written(result: OwnerOutcome<unknown>): Response {
  if (result.outcome === 'succeeded') {
    return Response.json({ operation: result.operationId, value: result.value, position: result.position,
      replayed: result.replayed }, { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
  }
  const code = result.code!;
  const status = code === 'target_unavailable' ? 404 : code === 'reviewer_not_independent' || code === 'cancelled' ? 403 : 409;
  return Response.json({ type: `https://rezics.com/problems/${code}`, title: 'Protected command was not applied',
    status, code, operation: result.operationId, position: result.position }, {
    status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}

function failed(error: unknown): Response {
  if (error instanceof ProtectionInvalid) return problem(400, 'invalid_protection_request', error.message);
  if (error instanceof ProtectionIdempotencyConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key belongs to a different request');
  }
  if (error instanceof ProtectionDenied) return problem(403, 'authority_denied', 'Authority is not admitted');
  const constraint = (error as { constraint?: string }).constraint;
  if (constraint && constraint in PROTECTION_CONFLICTS) {
    return problem(409, PROTECTION_CONFLICTS[constraint as keyof typeof PROTECTION_CONFLICTS], 'Owner basis changed');
  }
  return commandError(error);
}

export function protectionRoutes(work: ProtectionDependencies) {
  const unavailable = () => problem(503, 'protection_unavailable', 'Content protection is unavailable');
  const readable = async (request: Request, actingSubject: string, resourceId: string) => {
    const principal = await work.account.verify(request, ['work:read']);
    return work.access.canReadWork(principal, actingSubject, resourceId);
  };
  return new Elysia()
    .post('/v1/editorial-protections', {
      body: t.Object({ profile: t.Literal('content-draft-protection-v1'),
        resourceId: t.String({ pattern: NATIVE }), variantId: t.String({ pattern: VARIANT }),
        action: t.Union([t.Literal('tighten'), t.Literal('confirm'), t.Literal('relax')]), ...basis,
      }, { additionalProperties: false }),
      response: writeResponses,
    }, async ({ request, body }) => {
      const store = work.editorialProtection;
      if (!store) return unavailable();
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        return written(await changeAdmittedProtection(store, work.account, work.access, request,
          { ...body, idempotencyKey: key }));
      } catch (error) { return failed(error); }
    })
    .post('/v1/corrections', {
      body: t.Object({ profile: t.Literal('content-draft-correction-v1'),
        resourceId: t.String({ pattern: NATIVE }), variantId: t.String({ pattern: VARIANT }),
        body: t.String({ minLength: 1, maxLength: 65536 }), predecessor: t.Union([t.String({ pattern: UUID }), t.Null()]),
        ...basis }, { additionalProperties: false }),
      response: writeResponses,
    }, async ({ request, body }) => {
      const store = work.editorialProtection;
      if (!store) return unavailable();
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        return written(await proposeAdmittedCorrection(store, work.account, work.access, request,
          { ...body, idempotencyKey: key }));
      } catch (error) { return failed(error); }
    })
    .post('/v1/corrections/:proposalRevision/decisions', {
      params: t.Object({ proposalRevision: t.String({ pattern: UUID }) }),
      body: t.Object({ profile: t.Literal('content-draft-correction-decision-v1'),
        outcome: t.Union([t.Literal('approved'), t.Literal('rejected')]),
        expectedCandidateDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
        // The first profile has one terminal decision per proposal revision.
        expectedDecisionHead: t.Null(), ...basis }, { additionalProperties: false }),
      response: writeResponses,
    }, async ({ request, body, params }) => {
      const store = work.editorialProtection;
      if (!store) return unavailable();
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        return written(await decideAdmittedCorrection(store, work.account, work.access, request,
          { ...body, proposalRevision: params.proposalRevision, idempotencyKey: key }));
      } catch (error) { return failed(error); }
    })
    .get('/v1/corrections/:proposalRevision', {
      params: t.Object({ proposalRevision: t.String({ pattern: UUID }) }),
      query: t.Object({ actingSubject: t.String({ pattern: NATIVE }) }),
      response: { 200: t.Object({ proposal, decision: t.Union([decision, t.Null()]),
        candidateAvailable: t.Boolean() }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      const store = work.editorialProtection;
      if (!store) return unavailable();
      try {
        const record = await store.readCorrection(params.proposalRevision);
        // An undisclosed target and a missing proposal are indistinguishable.
        if (!record || !await readable(request, query.actingSubject, record.proposal.resourceId)) {
          return problem(404, 'correction_not_found', 'Correction is not available');
        }
        return Response.json(record, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return failed(error); }
    })
    .get('/v1/corrections', {
      query: t.Object({ target: t.String({ pattern: VARIANT }), resourceId: t.String({ pattern: NATIVE }),
        actingSubject: t.String({ pattern: NATIVE }), cursor: t.Optional(t.String({ maxLength: 200 })) }),
      response: { 200: t.Object({ items: t.Array(proposal, { maxItems: MAX_EDITORIAL_TARGETS }), next: nullableRef }),
        ...authorizedReadProblems },
    }, async ({ request, query }) => {
      const store = work.editorialProtection;
      if (!store) return unavailable();
      try {
        if (!await readable(request, query.actingSubject, query.resourceId)) {
          return problem(404, 'correction_not_found', 'Correction is not available');
        }
        const [state] = await store.editorialStates([query.target]);
        if (!state || state.resourceId !== query.resourceId) return problem(404, 'correction_not_found', 'Correction is not available');
        let after: { createdAt: string; id: string } | null = null;
        if (query.cursor) {
          try {
            const decoded: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
            if (!decoded || typeof decoded !== 'object' || !('target' in decoded)
              || decoded.target !== query.target || !('createdAt' in decoded)
              || typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt))
              || !('id' in decoded) || typeof decoded.id !== 'string'
              || !new RegExp(UUID).test(decoded.id)) throw new Error('invalid cursor');
            after = { createdAt: decoded.createdAt, id: decoded.id };
          }
          catch { return problem(400, 'invalid_cursor', 'Cursor is invalid'); }
        }
        const page = await store.listCorrections(query.target, after);
        return Response.json({ items: page.items, next: page.next
          ? Buffer.from(JSON.stringify({ target: query.target, ...page.next })).toString('base64url') : null },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return failed(error); }
    })
    .post('/v1/editorial-state-queries', {
      body: t.Object({ actingSubject: t.String({ pattern: NATIVE }),
        targets: t.Array(t.Object({ resourceId: t.String({ pattern: NATIVE }), variantId: t.String({ pattern: VARIANT }) },
          { additionalProperties: false }), { minItems: 1, maxItems: MAX_EDITORIAL_TARGETS }) },
      { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(t.Union([
        t.Object({ resourceId: t.String(), variantId: t.String(), availability: t.Literal('available'), state: editorialState }),
        t.Object({ resourceId: t.String(), variantId: t.String(), availability: t.Literal('unavailable') }),
      ]), { maxItems: MAX_EDITORIAL_TARGETS }) }), ...authorizedReadProblems },
    }, async ({ request, body }) => {
      const store = work.editorialProtection;
      if (!store) return unavailable();
      try {
        const resources = [...new Set(body.targets.map(item => item.resourceId))];
        const allowed = new Set<string>();
        for (const resource of resources) if (await readable(request, body.actingSubject, resource)) allowed.add(resource);
        const states = new Map((await store.editorialStates([...new Set(body.targets.map(item => item.variantId))]))
          .map(state => [state.variantId, state]));
        // Each requested entry keeps its own availability; nothing defaults to open.
        return Response.json({ items: body.targets.map(item => {
          const state = states.get(item.variantId);
          return allowed.has(item.resourceId) && state?.resourceId === item.resourceId
            ? { ...item, availability: 'available', state } : { ...item, availability: 'unavailable' };
        }) }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return failed(error); }
    });
}
