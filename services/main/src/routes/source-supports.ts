import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { authorCreditBody, authorCreditSupportResult, authorCreditWriteResult,
  nativeAuthorCreditResult } from '../modules/source/author-credit-schema.ts';
import { readAuthorCredit } from '../modules/work/author-credit.ts';
import { readAuthorCreditRetirement, retireAuthorCredit } from '../modules/work/author-credit-retirement.ts';
import { readTitleControl } from '../modules/work/title-control.ts';
import { FieldWithdrawalConflict, FieldWithdrawalInvalid, FieldWithdrawalPending,
  FieldWithdrawalUnavailable } from '../modules/source/withdrawal.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { groupAgent, groupUuid, sourceRightsEvidence, titleControlBasis } from './shared.ts';

export const openApiOperations = {
  '/v1/works/{id}/author-credits/{credit}/retirements': { post: { bearer: true, idempotencyKey: true } },
  '/v1/works/{id}/author-credits/{credit}/retirement': { get: { bearer: true } },
  '/v1/sources/supports/{support}': { get: { bearer: true } },
  '/v1/sources/field-supports/{support}': { get: { bearer: true } },
  '/v1/sources/field-supports': { post: { bearer: true, idempotencyKey: true } },
  '/v1/sources/withdrawals': { post: { bearer: true, idempotencyKey: true } },
};

const fieldWithdrawal = t.Object({ profile: t.Literal('source-field-withdrawal-v1'),
  state: t.Literal('withdrawn'), withdrawal: t.String(), support: t.String(),
  supportIdentity: t.String(), reason: t.String(), createdAt: t.String(), nativeEffect: t.Literal('none') });
const fieldSupport = t.Object({ profile: t.Literal('source-field-support-v1'),
  state: t.Union([t.Literal('recorded'), t.Literal('withdrawn')]), support: t.String(),
  supportIdentity: t.String(), target: t.String(), slot: t.String(), occurrence: t.Nullable(t.String()),
  context: t.String(), sourceRecord: t.String(), conversion: t.String(), mappingRevision: t.String(),
  grain: t.String(), sourceField: t.String(), sourceOccurrence: t.Nullable(t.String()),
  valueDigest: t.String(), nativeRevision: t.Nullable(t.String()), graphReceipt: t.Nullable(t.String()),
  headGuarantee: t.Union([t.Literal('transaction-guarded'), t.Literal('verified-before-commit')]),
  outcome: t.Union([t.Literal('applied'), t.Literal('attached'), t.Literal('returned')]),
  createdAt: t.String(), withdrawal: t.Nullable(fieldWithdrawal) });

const creditRetirement = t.Object({ profile: t.Literal('work-author-credit-retirement-v1'),
  state: t.Literal('retired'), retirement: t.String(), work: t.String(), credit: t.String(),
  revision: t.String(), workHead: t.String(), reason: t.String(), admissionId: t.String(),
  requestDigest: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

function fieldError(error: unknown): Response {
  if (error instanceof FieldWithdrawalInvalid) return problem(400, 'invalid_source_withdrawal', 'Field withdrawal is invalid');
  if (error instanceof FieldWithdrawalPending) return problem(409, 'source_support_pending', 'Field support needs reconciliation');
  if (error instanceof FieldWithdrawalConflict) return problem(409, 'source_support_changed', 'Field support changed');
  if (error instanceof FieldWithdrawalUnavailable) return problem(503, 'source_support_unavailable', 'Field support evidence is unavailable');
  return commandError(error);
}

const titleSourceBasis = t.Object({ binding: t.String(), record: t.String(), observation: t.String(),
  conversion: t.String(), proposal: t.String(), mapping: t.Literal('open-library-work-map-v1'), initialHead: t.String() });

const titleControlState = t.Object({ work: t.String(), contentHead: t.String(), basis: titleControlBasis,
  mode: t.Union([t.Literal('unestablished'), t.Literal('source-managed'), t.Literal('human-controlled')]),
  source: t.Nullable(titleSourceBasis) });

const titleControlReturnResult = t.Object({ work: t.String(), contentHead: t.String(), control: t.String(),
  replayed: t.Boolean(), receipt: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

const sourceTitleApplicationResult = t.Object({
  profile: t.Literal('native-work-source-title-application-v1'),
  state: t.Literal('applied'), application: t.String(), work: t.String(),
  proposal: t.String(), sourceRecord: t.String(), title: t.String(),
  predecessor: t.String(), workRevision: t.String(), receipt: t.String(),
  sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }),
  rightsStatus: t.Literal('undetermined'), createdAt: t.String(),
});

const sourceSupportWithdrawalResult = t.Object({
  profile: t.Literal('native-work-source-support-withdrawal-v1'), state: t.Literal('withdrawn'),
  withdrawal: t.String(), binding: t.String(), work: t.String(), supportIdentity: t.String(),
  proposal: t.String(), workRevision: t.String(), receipt: t.String(),
  adoptionReceipt: t.String(), adoptedAtRevision: t.String(), reason: t.String(), createdAt: t.String(),
});

const sourceSupportWithdrawalWriteResult = t.Object({ withdrawal: sourceSupportWithdrawalResult,
  replayed: t.Boolean() });

const sourceSupportResult = t.Object({
  profile: t.Literal('native-work-source-support-v1'),
  state: t.Union([t.Literal('recorded'), t.Literal('withdrawn')]),
  work: t.String(), field: t.Literal('title'), sourceValue: t.String(),
  sourceRecord: t.String(), sourceObservation: t.String(),
  sourceConversion: t.String(), sourceProposal: t.String(),
  sourceGraphReceipt: t.String(), binding: t.String(), adoptionReceipt: t.String(),
  adoptedAtRevision: t.String(), currentHead: t.String(),
  appliedRevisionIsHead: t.Boolean(), rightsEvidence: sourceRightsEvidence,
  supportIdentity: t.String(), latestApplication: t.Nullable(sourceTitleApplicationResult),
  withdrawal: t.Nullable(sourceSupportWithdrawalResult),
  rightsStatus: t.Literal('undetermined'),
});

const sourceRefreshAssessmentResult = t.Object({
  profile: t.Literal('native-work-source-refresh-assessment-v1'),
  state: t.Literal('assessed'), work: t.String(), record: t.String(),
  adoptedProposal: t.String(), candidateProposal: t.String(),
  adoptedConversion: t.String(), candidateConversion: t.String(),
  adoptedTitle: t.String(), candidateTitle: t.String(),
  sourceTitleChanged: t.Boolean(), representationChanged: t.Boolean(),
  adoptedRevision: t.String(), currentHead: t.String(),
  targetHeadChanged: t.Boolean(), rightsStatus: t.Literal('undetermined'),
});

const sourceAttachmentResult = t.Object({
  profile: t.Literal('native-work-source-title-attachment-v2'), state: t.Literal('attached'),
  binding: t.String(), supportIdentity: t.String(), originalBinding: t.String(), work: t.String(),
  proposal: t.String(), sourceRecord: t.String(), sourceObservation: t.String(),
  sourceConversion: t.String(), sourceGraphReceipt: t.String(), title: t.String(),
  titleLanguage: t.Literal('en'), verifiedHead: t.String(),
  headGuarantee: t.Literal('verified-before-commit'),
  authority: t.Object({ principalId: t.String(), principalEpoch: t.String(),
    actingSubject: t.String(), subjectGeneration: t.String(), scope: t.String(), action: t.Literal('work.edit'),
    authorityEpoch: t.String(), recoveryGeneration: t.String(), representationId: t.String(),
    representationGeneration: t.String(), grantId: t.String(), grantGeneration: t.String(), validUntil: t.String() }),
  rightsEvidence: sourceRightsEvidence, rightsStatus: t.Literal('undetermined'), createdAt: t.String(),
});

const sourceAttachmentWriteResult = t.Object({ attachment: sourceAttachmentResult, replayed: t.Boolean() });

const sourceAttachmentWithdrawalResult = t.Object({
  profile: t.Literal('native-work-source-support-withdrawal-v2'), state: t.Literal('withdrawn'),
  withdrawal: t.String(), binding: t.String(), supportIdentity: t.String(), work: t.String(),
  proposal: t.String(), verifiedHead: t.String(), reason: t.String(), createdAt: t.String(),
});

const sourceSupportEntryResult = t.Union([
  t.Object({ kind: t.Literal('adoption'), support: sourceSupportResult }),
  t.Object({ kind: t.Literal('attachment'), support: t.Object({
    profile: t.Literal('native-work-source-title-support-v2'),
    state: t.Union([t.Literal('recorded'), t.Literal('withdrawn')]),
    attachment: sourceAttachmentResult, currentHead: t.String(), verifiedRevisionIsHead: t.Boolean(),
    withdrawal: t.Nullable(sourceAttachmentWithdrawalResult),
  }) }),
]);

const anySupportResult = t.Union([fieldSupport, sourceSupportEntryResult,
  t.Object({ kind: t.Literal('author-credit'), support: authorCreditSupportResult })]);

async function readAnySupport(work: MainWorkDependencies, principalId: string, support: string) {
  if (!work.sourceFieldWithdrawals) return null;
  const field = await work.sourceFieldWithdrawals.read(principalId, support);
  if (field) return field;
  const native = await work.sourceFieldWithdrawals.locateNative(principalId, support);
  if (!native) return null;
  if (native.kind === 'author-credit') {
    const credit = await work.sourceAuthorCredits?.read(principalId, support.split('/').at(-1)!);
    return credit ? { kind: 'author-credit' as const, support: credit } : null;
  }
  const binding = support.startsWith('https://') ? support : `https://rezics.com/id/${support}`;
  return work.sourceAttachments?.readBinding(principalId, native.work, binding) ?? null;
}

const sourceSupportCollectionResult = t.Object({ profile: t.Literal('native-work-source-supports-v2'),
  work: t.String(), currentHead: t.String(), supports: t.Array(sourceSupportEntryResult, { minItems: 1, maxItems: 2 }) });

const sourcePerBindingWithdrawalResult = t.Union([
  t.Object({ kind: t.Literal('adoption'), withdrawal: sourceSupportWithdrawalResult, replayed: t.Boolean() }),
  t.Object({ kind: t.Literal('attachment'), withdrawal: sourceAttachmentWithdrawalResult, replayed: t.Boolean() }),
]);

const sourceTitleApplicationWriteResult = t.Object({ application: sourceTitleApplicationResult,
  replayed: t.Boolean() });

export function sourceSupportRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/sources/field-supports', {
      body: t.Object({ profile: t.Literal('source-field-support-attachment-v1'),
        target: groupAgent, slot: t.String({ minLength: 1, maxLength: 200 }),
        occurrence: t.Nullable(groupAgent), context: t.String({ minLength: 1, maxLength: 100 }),
        sourceRecord: groupAgent, conversion: groupAgent,
        grain: t.String({ minLength: 1, maxLength: 64 }),
        sourceField: t.String({ minLength: 1, maxLength: 200 }),
        sourceOccurrence: t.Nullable(t.String({ maxLength: 100 })),
        sourcePointer: t.String({ minLength: 1, maxLength: 200 }),
        expectedHead: groupAgent, actingSubject: groupAgent }, { additionalProperties: false }),
      response: { 200: t.Object({ support: fieldSupport, replayed: t.Boolean() }),
        201: t.Object({ support: fieldSupport, replayed: t.Boolean() }),
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      try {
        if (!work.sourceFieldAttachments || !work.sourceFieldWithdrawals) {
          return problem(503, 'source_support_unavailable', 'Source field owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const attached = await work.sourceFieldAttachments.attach(principal, principalId, key, body);
        const support = await work.sourceFieldWithdrawals.read(principalId, attached.support);
        if (!support) throw new FieldWithdrawalUnavailable('field support certificate is unavailable');
        return Response.json({ support, replayed: attached.replayed },
          { status: attached.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return fieldError(error); }
    })
    .post('/v1/works/:id/author-credits/:credit/retirements', {
      params: t.Object({ id: groupUuid, credit: groupUuid }),
      body: t.Object({ profile: t.Literal('work-author-credit-retirement-v1'),
        revision: groupAgent, expectedHead: groupAgent, actingSubject: groupAgent,
        reason: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      response: { 200: t.Object({ retirement: creditRetirement, replayed: t.Boolean() }),
        201: t.Object({ retirement: creditRetirement, replayed: t.Boolean() }),
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const result = await retireAuthorCredit(work.environment, work.account, work.access, request, {
          work: `https://rezics.com/id/${params.id}`, credit: `https://rezics.com/id/${params.credit}`,
          revision: body.revision, expectedHead: body.expectedHead, actingSubject: body.actingSubject,
          reason: body.reason, idempotencyKey: key });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/author-credits/:credit/retirement', {
      params: t.Object({ id: groupUuid, credit: groupUuid }),
      query: t.Object({ actingSubject: groupAgent }),
      response: { 200: creditRetirement, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const native = `https://rezics.com/id/${params.id}`;
        if (!await work.access.canReadWork(principal, query.actingSubject, native)) {
          return problem(404, 'author_credit_unavailable', 'Author credit is unavailable');
        }
        const retirement = await readAuthorCreditRetirement(work.environment,
          `https://rezics.com/id/${params.credit}`);
        if (!retirement || retirement.work !== native) {
          return problem(404, 'author_credit_unavailable', 'Author credit is unavailable');
        }
        return Response.json(retirement, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/supports/:support', {
      params: t.Object({ support: groupUuid }),
      response: { 200: anySupportResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceFieldWithdrawals) return problem(503, 'source_support_unavailable', 'Source support owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const support = await readAnySupport(work, principalId, params.support);
        if (!support) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json(support, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return fieldError(error); }
    })
    .get('/v1/sources/field-supports/:support', {
      params: t.Object({ support: groupUuid }),
      response: { 200: fieldSupport, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceFieldWithdrawals) return problem(503, 'source_support_unavailable', 'Source field owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const support = await work.sourceFieldWithdrawals.read(principalId, params.support);
        if (!support) return problem(404, 'source_support_unavailable', 'Field support is unavailable');
        return Response.json(support, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return fieldError(error); }
    })
    .post('/v1/sources/withdrawals', {
      body: t.Object({ profile: t.Union([t.Literal('source-support-withdrawal-v1'),
        t.Literal('source-field-withdrawal-v1')]),
        support: groupAgent, expectedSupport: groupAgent,
        reason: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      response: { 200: t.Object({ support: anySupportResult, replayed: t.Boolean() }),
        201: t.Object({ support: anySupportResult, replayed: t.Boolean() }),
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      try {
        if (!work.sourceFieldWithdrawals) return problem(503, 'source_support_unavailable', 'Source field owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const current = await readAnySupport(work, principalId, body.support);
        if (!current) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        if ('kind' in current && body.profile !== 'source-support-withdrawal-v1') {
          return problem(400, 'invalid_source_withdrawal', 'Native support requires the general withdrawal profile');
        }
        let result: { support: typeof current; replayed: boolean } | null;
        if (!('kind' in current)) {
          result = await work.sourceFieldWithdrawals.withdraw(principalId, key, body);
        } else if (current.kind === 'author-credit') {
          if (body.expectedSupport !== body.support) throw new FieldWithdrawalConflict('credit support changed');
          const withdrawn = await work.sourceAuthorCredits?.withdraw(principalId,
            body.support.split('/').at(-1)!, key, body.reason);
          result = withdrawn ? { support: { kind: 'author-credit', support: withdrawn.support },
            replayed: withdrawn.replayed } : null;
        } else {
          const native = current.kind === 'adoption' ? current.support.work : current.support.attachment.work;
          const withdrawn = await work.sourceAttachments?.withdraw(principalId, native,
            body.support, key, { expectedSupport: body.expectedSupport, reason: body.reason });
          const settled = withdrawn && await work.sourceAttachments?.readBinding(principalId, native, body.support);
          result = withdrawn && settled ? { support: settled, replayed: withdrawn.replayed } : null;
        }
        if (!result) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return fieldError(error); }
    })
    .post('/v1/works/:id/source-author-credits', {
      params: t.Object({ id: groupUuid }), body: authorCreditBody,
      response: { 200: authorCreditWriteResult, 201: authorCreditWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAuthorCredits) return problem(503, 'author_credit_unavailable', 'Source credit owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAuthorCredits.adopt(principal, principalId, request,
          `https://rezics.com/id/${params.id}`, key, body);
        if (!result) return problem(404, 'source_proposal_unavailable', 'Source proposal is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/sources/author-credit-supports/:support', {
      params: t.Object({ support: groupUuid }), response: { 200: authorCreditSupportResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAuthorCredits) return problem(503, 'author_credit_unavailable', 'Source credit owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAuthorCredits.read(principalId, params.support);
        if (!result) return problem(404, 'author_credit_unavailable', 'Source credit support is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/sources/author-credit-supports/:support/withdrawals', {
      params: t.Object({ support: groupUuid }), body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) },
        { additionalProperties: false }),
      response: { 200: authorCreditWriteResult, 201: authorCreditWriteResult, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAuthorCredits) return problem(503, 'author_credit_unavailable', 'Source credit owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAuthorCredits.withdraw(principalId, params.support, key, body.reason);
        if (!result) return problem(404, 'author_credit_unavailable', 'Source credit support is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/author-credits/:credit/revisions/:revision', {
      params: t.Object({ id: groupUuid, credit: groupUuid, revision: groupUuid }),
      query: t.Object({ actingSubject: groupAgent }),
      response: { 200: nativeAuthorCreditResult, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const resource = `https://rezics.com/id/${params.id}`;
        if (!await work.access.canReadWork(principal, query.actingSubject, resource)) {
          return problem(404, 'author_credit_unavailable', 'Native credit is unavailable');
        }
        const result = await readAuthorCredit(work.environment, `https://rezics.com/id/${params.credit}`,
          `https://rezics.com/id/${params.revision}`);
        if (!result || result.work !== resource) return problem(404, 'author_credit_unavailable', 'Native credit is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v2/works/:id/source-supports', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ profile: t.Literal('native-work-source-title-attachment-v2'),
        proposal: groupAgent, expectedHead: groupAgent, actingSubject: groupAgent,
        confirmedTitle: t.String({ minLength: 1, maxLength: 200 }), titleLanguage: t.Literal('en'),
      }, { additionalProperties: false }),
      response: { 200: sourceAttachmentWriteResult, 201: sourceAttachmentWriteResult,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAttachments) return problem(503, 'source_adoption_unavailable', 'Source owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAttachments.attach(principal, principalId,
          `https://rezics.com/id/${params.id}`, key, body);
        if (!result) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v2/works/:id/source-supports', {
      params: t.Object({ id: groupUuid }),
      response: { 200: sourceSupportCollectionResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAttachments) return problem(503, 'source_adoption_unavailable', 'Source owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAttachments.read(principalId, `https://rezics.com/id/${params.id}`);
        if (!result) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v2/works/:id/source-supports/:binding', {
      params: t.Object({ id: groupUuid, binding: groupUuid }),
      response: { 200: sourceSupportEntryResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAttachments) return problem(503, 'source_adoption_unavailable', 'Source owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAttachments.readBinding(principalId,
          `https://rezics.com/id/${params.id}`, `https://rezics.com/id/${params.binding}`);
        if (!result) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v2/works/:id/source-supports/:binding/withdrawal', {
      params: t.Object({ id: groupUuid, binding: groupUuid }),
      body: t.Object({ profile: t.Literal('native-work-source-support-withdrawal-v2'),
        expectedSupport: groupAgent, reason: t.String({ minLength: 1, maxLength: 500 }),
      }, { additionalProperties: false }),
      response: { 200: sourcePerBindingWithdrawalResult, 201: sourcePerBindingWithdrawalResult,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAttachments) return problem(503, 'source_adoption_unavailable', 'Source owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAttachments.withdraw(principalId,
          `https://rezics.com/id/${params.id}`, `https://rezics.com/id/${params.binding}`, key, body);
        if (!result) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/source-support', {
      params: t.Object({ id: groupUuid }),
      response: { 200: sourceSupportResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const support = await work.sourceAdoptions.readSupport(principalId,
          `https://rezics.com/id/${params.id}`);
        if (!support) return problem(404, 'source_support_unavailable',
          'Work source support is unavailable');
        return Response.json(support, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/works/:id/source-support/withdrawal', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ profile: t.Literal('native-work-source-support-withdrawal-v1'),
        binding: groupAgent, expectedSupport: groupAgent,
        reason: t.String({ minLength: 1, maxLength: 500 }),
      }, { additionalProperties: false }),
      response: { 200: sourceSupportWithdrawalWriteResult, 201: sourceSupportWithdrawalWriteResult,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAdoptions.withdrawSupport(principalId,
          `https://rezics.com/id/${params.id}`, key, body);
        if (!result) return problem(404, 'source_support_unavailable',
          'Work source support is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/source-refresh-assessments/:candidateProposal', {
      params: t.Object({ id: groupUuid, candidateProposal: groupUuid }),
      response: { 200: sourceRefreshAssessmentResult, ...authorizedReadProblems,
        409: problemResult(409) },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const assessment = await work.sourceAdoptions.assessRefresh(principalId,
          `https://rezics.com/id/${params.id}`, params.candidateProposal);
        if (!assessment) return problem(404, 'source_refresh_unavailable',
          'Source refresh evidence is unavailable');
        return Response.json(assessment, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/title-control', {
      params: t.Object({ id: groupUuid }), query: t.Object({ actingSubject: groupAgent }),
      response: { 200: titleControlState, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const target = `https://rezics.com/id/${params.id}`;
        if (!await work.access.canReadWork(principal, query.actingSubject, target)) return problem(404, 'work_unavailable', 'Work is unavailable');
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        return Response.json(await readTitleControl(work.environment, target), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/works/:id/title-control/source-return', {
      params: t.Object({ id: groupUuid }),
      body: t.Object({ proposal: groupAgent, expectedHead: groupAgent, actingSubject: groupAgent,
        titleControl: titleControlBasis }, { additionalProperties: false }),
      response: { 200: titleControlReturnResult, 202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable', 'Source owner is unavailable');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const key = request.headers.get('idempotency-key') ?? '';
        const result = await work.sourceAdoptions.returnTitleControl(principalId, request,
          `https://rezics.com/id/${params.id}`, key, body);
        if (!result) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json({ work: result.work, contentHead: result.revision, control: result.control,
          receipt: result.receipt, replayed: result.replayed, sourcePosition: { datasetId: 'product',
            dataEpoch: result.dataEpoch, sequence: result.sequence } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/works/:id/source-title-applications/:candidateProposal', {
      params: t.Object({ id: groupUuid, candidateProposal: groupUuid }),
      body: t.Object({ profile: t.Literal('native-work-source-title-application-v1'),
        expectedHead: groupAgent, actingSubject: groupAgent, titleControl: titleControlBasis,
        confirmedTitle: t.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      response: { 200: sourceTitleApplicationWriteResult,
        201: sourceTitleApplicationWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAdoptions.applyTitle(principalId, request,
          `https://rezics.com/id/${params.id}`, params.candidateProposal,
          { expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            confirmedTitle: body.confirmedTitle, titleControl: body.titleControl });
        if (!result) return problem(404, 'source_title_application_unavailable',
          'Source title proposal or Work binding is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/source-title-applications/:candidateProposal', {
      params: t.Object({ id: groupUuid, candidateProposal: groupUuid }),
      response: { 200: sourceTitleApplicationResult, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAdoptions.readTitleApplication(principalId,
          `https://rezics.com/id/${params.id}`, params.candidateProposal);
        if (!result) return problem(404, 'source_title_application_unavailable',
          'Source title application is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
