import { transportResponses } from '../transport-responses.ts';
import { languageTagSchema } from '../modules/display-language/schema.ts';
import { Elysia, t } from 'elysia';
import type { Static, TSchema, TUnsafe } from 'typebox';
import type { FieldSupportResult } from '../modules/source/withdrawal.ts';
import type { RetainedPublicEvidence } from '../modules/source/field-support-retained.ts';
import type { NativeCreditAnnotationRequest, NativeCreditAnnotationResult } from '../modules/source/native-credit-annotation.ts';
import { nativeCreditAnnotationRequest, nativeCreditAnnotationResult } from '../modules/source/native-credit-annotation-schema.ts';
import type { FieldAttachmentCertificate, VerifiedRetainedSupportAdmission, RetainedSupportRequest } from '../modules/source/field-support-contract.ts';
import type { AttachFieldSupportInput } from '../modules/source/support-attach.ts';
import type { NativeWorkSourceSupport } from '../modules/source/native-work-adoption.ts';
import type { NativeWorkSourceAttachment } from '../modules/source/native-work-attachment.ts';
import type { SourceNativeChildStore } from '../modules/source/child-native-support.ts';
import type { SourceAuthorCreditSupport } from '../modules/source/author-credit.ts';
import type { NativeAuthorCredit } from '../modules/work/author-credit.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { authorCreditBody, authorCreditSupportResult as authorCreditSupportSchema,
  authorCreditWriteResult as authorCreditWriteSchema,
  nativeAuthorCreditResult as nativeAuthorCreditSchema } from '../modules/source/author-credit-schema.ts';
import { readAuthorCredit } from '../modules/work/author-credit.ts';
import { readAuthorCreditRetirement, retireAuthorCredit } from '../modules/work/author-credit-retirement.ts';
import { readTitleControl } from '../modules/work/title-control.ts';
import { changeNativeFieldControl, readNativeFieldControl, NativeFieldConflict,
  NativeFieldInvalid, NativeFieldUnavailable } from '../modules/source/field-control-native.ts';
import { RightsDenied, RightsUnavailable } from '../modules/rights/store.ts';
import { FieldWithdrawalConflict, FieldWithdrawalInvalid, FieldWithdrawalPending,
  FieldWithdrawalUnavailable } from '../modules/source/withdrawal.ts';
import { NativeChildConflict, NativeChildInvalid, NativeChildUnavailable,
  readNativeChild } from '../modules/source/child-native.ts';
import { readNativeChildRetirement, retireNativeChild } from '../modules/source/child-retirement.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { commandError, problem } from './problems.ts';
import { exposureOperationId, requireSelectedPlatformCapability } from '../modules/access/exposure.ts';
import { groupAgent, groupUuid, sourceRightsEvidence, titleControlBasis } from './shared.ts';
import { requireSourceImportAuthority } from './source-runs.ts';
import { SYNOPSIS_TEXT_LIMIT } from '../modules/source/field-control-language.ts';
import { retainedSupportRequest, retainedSupportAdmission, fieldAttachmentCertificate,
  retainedPublicEvidence, suppliedLanguageSchema } from '../modules/source/field-support-schema.ts';

import { workRead, type WorkReadSession, WorkReadMoved, WorkReadUnavailable } from '../modules/work/read-session.ts';
import { workReadError } from './work-reads.ts';

// Reuse owner types without cloning Elysia's validators: their schema kind can
// live on the prototype and must survive at runtime.
function ownerSchema<T>(schema: TSchema): TUnsafe<T> { return schema as TUnsafe<T>; }

const publicWritePolicy = { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } as const;
const publicReadPolicy = { exposure: 'public', rateLimitFamily: 'read', bearer: true } as const;
const sourceReadPolicy = { exposure: 'platform:catalogue-import', rateLimitFamily: 'read', bearer: true } as const;
const sourceWritePolicy = { exposure: 'platform:catalogue-import', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } as const;
const sourceLegacyReadPolicy = { exposure: 'platform:catalogue-import', rateLimitFamily: 'read' } as const;
const sourceLegacyWritePolicy = { exposure: 'platform:catalogue-import', rateLimitFamily: 'write' } as const;
const publicLegacyReadPolicy = { exposure: 'public', rateLimitFamily: 'read' } as const;

export const openApiOperations = {
  '/v1/works/{id}/author-credits/{credit}/retirements': { post: publicWritePolicy },
  '/v1/works/{id}/author-credits/{credit}/retirement': { get: publicReadPolicy },
  '/v1/sources/supports/{support}': { get: publicReadPolicy },
  '/v1/sources/field-supports/{support}': { get: publicReadPolicy },
  '/v1/sources/field-supports': { post: publicWritePolicy },
  '/v1/sources/withdrawals': { post: publicWritePolicy },
  '/v1/works/{id}/fields/synopsis/control': { get: publicReadPolicy,
    post: publicWritePolicy },
  '/v1/works/{id}/source-children': { post: sourceWritePolicy },
  '/v1/sources/native-child-supports/{support}': { get: sourceReadPolicy },
  '/v1/sources/native-child-supports/{support}/withdrawals': { post: sourceWritePolicy },
  '/v1/works/{id}/native-children/{child}/revisions/{revision}': { get: publicReadPolicy },
  '/v1/works/{id}/native-children/{child}/retirements': { post: publicWritePolicy,
    get: publicReadPolicy },
  '/v1/works/{id}/source-title-applications/{candidateProposal}': { get: sourceLegacyReadPolicy, post: sourceLegacyWritePolicy },
  '/v1/works/{id}/title-control/source-return': { post: sourceLegacyWritePolicy },
  '/v1/works/{id}/title-control': { get: publicLegacyReadPolicy },
  '/v1/works/{id}/source-refresh-assessments/{candidateProposal}': { get: sourceLegacyReadPolicy },
  '/v1/works/{id}/source-support/withdrawal': { post: sourceLegacyWritePolicy },
  '/v1/works/{id}/source-support': { get: sourceLegacyReadPolicy },
  '/v2/works/{id}/source-supports/{binding}/withdrawal': { post: sourceLegacyWritePolicy },
  '/v2/works/{id}/source-supports/{binding}': { get: sourceLegacyReadPolicy },
  '/v2/works/{id}/source-supports': { get: sourceLegacyReadPolicy, post: sourceLegacyWritePolicy },
  '/v1/works/{id}/author-credits/{credit}/revisions/{revision}': { get: publicLegacyReadPolicy },
  '/v1/sources/author-credit-supports/{support}/withdrawals': { post: sourceLegacyWritePolicy },
  '/v1/sources/author-credit-supports/{support}': { get: sourceLegacyReadPolicy },
  '/v1/works/{id}/source-author-credits': { post: sourceLegacyWritePolicy },
} as const;

const workParams = t.Object({ id: groupUuid });
const supportParams = t.Object({ support: groupUuid });
const creditParams = t.Object({ id: groupUuid, credit: groupUuid });
const childParams = t.Object({ id: groupUuid, child: groupUuid });
const childRevisionParams = t.Object({ id: groupUuid, child: groupUuid, revision: groupUuid });
const creditRevisionParams = t.Object({ id: groupUuid, credit: groupUuid, revision: groupUuid });
const bindingParams = t.Object({ id: groupUuid, binding: groupUuid });
const proposalParams = t.Object({ id: groupUuid, candidateProposal: groupUuid });

const nativeChildBody = t.Object({ profile: t.Literal('source-native-child-adoption-v1'),
  field: t.String({ pattern: '^[A-Za-z][A-Za-z0-9:_.-]{0,99}$' }), proposal: groupAgent,
  conversion: groupAgent, occurrence: t.String(), sourceOrdinal: t.Integer({ minimum: 0, maximum: 127 }),
  confirmedSourceKey: t.String({ minLength: 1, maxLength: 200 }),
  nativeOrdinal: t.Integer({ minimum: 0, maximum: 127 }), expectedHead: groupAgent,
  actingSubject: groupAgent, baseSupport: t.Nullable(groupAgent), correspondence: t.Nullable(groupAgent),
  confirmedUse: t.Literal('factual-reference-only') }, { additionalProperties: false });
interface NativeChildResponse extends NonNullable<Awaited<ReturnType<typeof readNativeChild>>> {}
interface NativeChildSupportResponse extends NonNullable<Awaited<ReturnType<SourceNativeChildStore['read']>>> {}
interface AuthorCreditResponse extends Omit<SourceAuthorCreditSupport, 'credit' | 'correspondenceKind' | 'rightsEvidence'> {
  credit: Omit<NativeAuthorCredit, 'agent' | 'modelRevision'>;
  correspondenceKind: string;
  rightsEvidence: { basis: string; note: string };
}
const authorCreditSupportResult = ownerSchema<AuthorCreditResponse>(authorCreditSupportSchema);
const authorCreditWriteResult = ownerSchema<{ support: AuthorCreditResponse; replayed: boolean }>(authorCreditWriteSchema);
const nativeAuthorCreditResult = ownerSchema<AuthorCreditResponse['credit']>(nativeAuthorCreditSchema);
const nativeChildResult = ownerSchema<NativeChildResponse>(t.Object({ profile: t.String(), state: t.String(), work: groupAgent,
  child: groupAgent, revision: groupAgent, field: t.String({ pattern: '^[A-Za-z][A-Za-z0-9:_.-]{0,99}$' }),
  sourceKey: t.String(), nativeOrdinal: t.Integer(), expectedHead: groupAgent,
  actingSubject: groupAgent, dataEpoch: t.String(), sequence: t.String(),
  retiredBy: t.Nullable(t.String()) }));
const nativeChildSupport = ownerSchema<NativeChildSupportResponse>(t.Object({ profile: t.String(), state: t.String(), support: groupAgent,
  work: groupAgent, field: t.String({ pattern: '^[A-Za-z][A-Za-z0-9:_.-]{0,99}$' }), child: nativeChildResult,
  proposal: groupAgent, conversion: groupAgent, record: groupAgent,
  observation: groupAgent, sourceOccurrence: t.String(), sourceOrdinal: t.Integer(),
  sourceKey: t.String(), correspondence: t.Nullable(groupAgent), baseSupport: t.Nullable(groupAgent),
  nativeReceipt: t.String(), headGuarantee: t.String(), rightsStatus: t.String(),
  withdrawal: t.Nullable(t.Object({ withdrawal: groupAgent, reason: t.String(), createdAt: t.String() })),
  createdAt: t.String() }));
const nativeChildWrite = ownerSchema<{ support: NativeChildSupportResponse; replayed: boolean }>(t.Object({ support: nativeChildSupport, replayed: t.Boolean() }));
const nativeChildRetirement = t.Object({ profile: t.String(), state: t.Literal('retired'),
  retirement: t.String(), work: groupAgent, child: groupAgent, revision: groupAgent,
  workHead: groupAgent, reason: t.String(), admissionId: t.String(), requestDigest: t.String(),
  sourcePosition: t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }) });
const nativeChildRetirementWrite = t.Object({ retirement: nativeChildRetirement, replayed: t.Boolean() });

function childError(error: unknown): Response {
  if (error instanceof NativeChildInvalid) return problem(400, 'invalid_native_child', 'Native child request is invalid');
  if (error instanceof NativeChildConflict) return problem(409, 'native_child_changed', 'Native child or source support changed');
  if (error instanceof NativeChildUnavailable) return problem(503, 'native_child_unavailable', 'Native child evidence is unavailable');
  return commandError(error);
}

const synopsisBasis = t.Object({ contentHead: t.Nullable(groupAgent),
  head: t.Nullable(groupAgent), epoch: t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' }),
  protection: t.Nullable(groupAgent) }, { additionalProperties: false });
const synopsisSource = t.Object({ record: groupAgent, observation: groupAgent,
  conversion: groupAgent, mapping: t.String({ pattern: '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}$' }) },
{ additionalProperties: false });
const synopsisState = t.Object({ profile: t.Literal('work-editorial-field-control-v1'),
  work: groupAgent, field: t.Literal('synopsis'), slot: t.String(), workHead: groupAgent,
  contentHead: t.Nullable(groupAgent), controlHead: t.Nullable(groupAgent),
  controlEpoch: t.String(), protectionHead: t.Nullable(groupAgent),
  mode: t.Union([t.Literal('unestablished'), t.Literal('human-controlled'),
    t.Literal('source-managed')]), value: t.Nullable(t.String()),
  rightsStatus: t.Nullable(t.Union([t.Literal('undetermined'), t.Literal('restricted')])),
  language: t.Optional(suppliedLanguageSchema) });
const synopsisReceipt = t.Object({ outcome: t.Literal('succeeded'), receipt: t.String(),
  admissionId: t.String(), requestDigest: t.String(), authorityEpoch: t.String(),
  scope: t.String(), dataEpoch: t.String(), sequence: t.String(), replayed: t.Boolean(),
  work: groupAgent, slot: t.String(), content: groupAgent, control: groupAgent,
  support: t.Optional(groupAgent) });

const fieldWithdrawal = t.Object({ profile: t.Literal('source-field-withdrawal-v1'),
  state: t.Literal('withdrawn'), withdrawal: t.String(), support: t.String(),
  supportIdentity: t.String(), reason: t.String(), createdAt: t.String(), nativeEffect: t.Literal('none') });
// Keep the complete validators while using owner types for route/client inference.
interface FieldSupportResponse extends FieldSupportResult {
  admission?: VerifiedRetainedSupportAdmission;
  attachment?: FieldAttachmentCertificate;
  publicEvidence?: RetainedPublicEvidence | null;
}
interface FieldSupportWriteResponse {
  support: FieldSupportResponse;
  replayed: boolean;
}
const fieldSupport = ownerSchema<FieldSupportResponse>(t.Object({ profile: t.Literal('source-field-support-v1'),
  state: t.Union([t.Literal('recorded'), t.Literal('withdrawn')]), support: t.String(),
  supportIdentity: t.String(), target: t.String(), slot: t.String(), occurrence: t.Nullable(t.String()),
  context: t.String(), sourceRecord: t.String(), conversion: t.String(), mappingRevision: t.String(),
  grain: t.String(), sourceField: t.String(), sourceOccurrence: t.Nullable(t.String()),
  valueDigest: t.String(), nativeRevision: t.Nullable(t.String()), graphReceipt: t.Nullable(t.String()),
  headGuarantee: t.Union([t.Literal('transaction-guarded'), t.Literal('verified-before-commit')]),
  outcome: t.Union([t.Literal('applied'), t.Literal('attached'), t.Literal('returned')]),
  createdAt: t.String(), withdrawal: t.Nullable(fieldWithdrawal),
  admission: t.Optional(retainedSupportAdmission), attachment: t.Optional(fieldAttachmentCertificate),
  publicEvidence: t.Optional(t.Nullable(retainedPublicEvidence)) }));
const fieldSupportWrite = ownerSchema<FieldSupportWriteResponse | { support: NativeCreditAnnotationResult; replayed: boolean }>(
  t.Object({ support: t.Union([fieldSupport, nativeCreditAnnotationResult]), replayed: t.Boolean() }));

const creditRetirement = t.Object({ profile: t.Literal('work-author-credit-retirement-v1'),
  state: t.Literal('retired'), retirement: t.String(), work: t.String(), credit: t.String(),
  revision: t.String(), workHead: t.String(), reason: t.String(), admissionId: t.String(),
  requestDigest: t.String(), sourcePosition: t.Object({ datasetId: t.Literal('product'),
    dataEpoch: t.String(), sequence: t.String() }) });

function fieldError(error: unknown): Response {
  if (error instanceof WorkReadMoved || error instanceof WorkReadUnavailable) return workReadError(error);
  if (error instanceof RightsDenied) return problem(403,'rights_denied',error.message);
  if (error instanceof RightsUnavailable) return problem(503,'source_support_unavailable',error.message);
  if (error instanceof NativeChildInvalid || error instanceof NativeChildConflict
    || error instanceof NativeChildUnavailable) return childError(error);
  if (error instanceof FieldWithdrawalInvalid) return problem(400, 'invalid_source_withdrawal', 'Field withdrawal is invalid');
  if (error instanceof FieldWithdrawalPending) return problem(409, 'source_support_pending', 'Field support needs reconciliation');
  if (error instanceof FieldWithdrawalConflict) return problem(409, 'source_support_changed', 'Field support changed');
  if (error instanceof FieldWithdrawalUnavailable) return problem(503, 'source_support_unavailable', 'Field support evidence is unavailable');
  return commandError(error);
}

const titleSourceBasis = t.Object({ binding: t.String(), record: t.String(), observation: t.String(),
  conversion: t.String(), proposal: t.String(), mapping: t.String({ pattern: '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}$' }), initialHead: t.String() });

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

const sourceSupportResult = ownerSchema<NativeWorkSourceSupport>(t.Object({
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
}));

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

interface SourceAttachmentResponse extends Omit<NativeWorkSourceAttachment, 'authority'> {
  authority: Omit<NativeWorkSourceAttachment['authority'], 'role' | 'baseline' | 'grantId' | 'grantGeneration'> & {
    grantId: string; grantGeneration: string;
  };
}
const sourceAttachmentResult = ownerSchema<SourceAttachmentResponse>(t.Object({
  profile: t.Literal('native-work-source-title-attachment-v2'), state: t.Literal('attached'),
  binding: t.String(), supportIdentity: t.String(), originalBinding: t.String(), work: t.String(),
  proposal: t.String(), sourceRecord: t.String(), sourceObservation: t.String(),
  sourceConversion: t.String(), sourceGraphReceipt: t.String(), title: t.String(),
  titleLanguage: languageTagSchema(35), verifiedHead: t.String(),
  headGuarantee: t.Literal('verified-before-commit'),
  authority: t.Object({ principalId: t.String(), principalEpoch: t.String(),
    actingSubject: t.String(), subjectGeneration: t.String(), scope: t.String(), action: t.Literal('work.edit'),
    authorityEpoch: t.String(), recoveryGeneration: t.String(), representationId: t.String(),
    representationGeneration: t.String(), grantId: t.String(), grantGeneration: t.String(), validUntil: t.String() }),
  rightsEvidence: sourceRightsEvidence, rightsStatus: t.Literal('undetermined'), createdAt: t.String(),
}));

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

type AnySupportResponse = FieldSupportResponse | NativeCreditAnnotationResult | Static<typeof sourceSupportEntryResult>
  | { kind: 'author-credit'; support: Static<typeof authorCreditSupportResult> }
  | { kind: 'native-child'; support: Static<typeof nativeChildSupport> };
const anySupportResult = ownerSchema<AnySupportResponse>(t.Union([fieldSupport, nativeCreditAnnotationResult, sourceSupportEntryResult,
  t.Object({ kind: t.Literal('author-credit'), support: authorCreditSupportResult }),
  t.Object({ kind: t.Literal('native-child'), support: nativeChildSupport })]));
interface AnySupportWriteResponse { support: AnySupportResponse; replayed: boolean }
const anySupportWrite = ownerSchema<AnySupportWriteResponse>(t.Object({
  support: anySupportResult, replayed: t.Boolean(),
}));

async function readAnySupport(work: MainWorkDependencies, principalId: string, support: string, principal: VerifiedPrincipal) {
  if (!work.sourceFieldWithdrawals) return null;
  const field = await work.sourceFieldWithdrawals.read(principalId, support, principal);
  if (field) return field;
  const native = await work.sourceFieldWithdrawals.locateNative(principalId, support);
  if (!native) return null;
  if (native.kind === 'author-credit') {
    const credit = await work.sourceAuthorCredits?.read(principalId, support.split('/').at(-1)!);
    return credit ? { kind: 'author-credit' as const, support: credit } : null;
  }
  if (native.kind === 'native-child') {
    const child = await work.sourceNativeChildren?.read(principalId, support.split('/').at(-1)!);
    return child ? { kind: 'native-child' as const, support: child } : null;
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
  const synopsisRoutes = new Elysia()
    .get('/v1/works/:id/fields/synopsis/control', {
      params: workParams, query: t.Object({ actingSubject: groupAgent }),
      response: transportResponses(openApiOperations["/v1/works/{id}/fields/synopsis/control"].get, { 200: synopsisState, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }): Promise<Response> => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const native = `https://rezics.com/id/${params.id}`;
        if (!await work.access.canReadWork(principal, query.actingSubject, native)) {
          return problem(404, 'field_unavailable', 'Work field is unavailable');
        }
        const state = await readNativeFieldControl(work.environment, native);
        const rights = work.rights?.store;
        if (state.value && !rights) {
          return problem(503, 'synopsis_rights_unavailable', 'Synopsis rights are unavailable');
        }
        if (state.value && rights && await rights.nativeSynopsisRestricted(native,
          state.value, ['disclosure'])) {
          return Response.json({ ...state, value: null, rightsStatus: 'restricted' },
            { headers: { 'cache-control': 'no-store' } });
        }
        return Response.json(state, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof RightsUnavailable) return problem(503, 'synopsis_rights_unavailable', error.message);
        return commandError(error);
      }
    })
    .post('/v1/works/:id/fields/synopsis/control', {
      params: workParams,
      body: t.Object({ profile: t.Literal('work-editorial-field-control-v1'),
        field: t.Literal('synopsis'), expectedWorkHead: groupAgent, basis: synopsisBasis,
        value: t.String({ minLength: 1, maxLength: SYNOPSIS_TEXT_LIMIT }),
        language: t.Optional(suppliedLanguageSchema),
        origin: t.Union([t.Literal('human'), t.Literal('source')]),
        source: t.Nullable(synopsisSource), actingSubject: groupAgent },
      { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/fields/synopsis/control"].post, { 200: synopsisReceipt, 201: synopsisReceipt,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
      try {
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        if (!work.access.issueTitleAdmission) {
          return problem(503, 'field_control_unavailable', 'Field admission signer is unavailable');
        }
        const native = `https://rezics.com/id/${params.id}`;
        if (body.origin === 'source') {
          if (!body.source || !work.sourceFieldApplications) {
            return problem(400, 'invalid_field_source', 'Verified source basis is required');
          }
          const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
          const principalId = await work.access.activePrincipalId(principal);
          if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
          const retained = await work.sourceConversions?.retained.custody(principalId,body.source.conversion);
          if (retained) {
            if (!work.sourceRetainedFieldSupports) return problem(503,'source_support_unavailable','Source field owner is unavailable');
            await requireSourceImportAuthority(work,principal);
            const intent = { profile: body.profile, work: native, field: body.field,
              expectedWorkHead: body.expectedWorkHead, basis: body.basis, value: body.value,
              ...(body.language === undefined ? {} : { language: body.language }),
              origin: 'source' as const, source: body.source, actingSubject: body.actingSubject };
            try { await work.sourceRetainedFieldSupports.admitSynopsis(principal,principalId,intent); }
            catch (error) { return fieldError(error); }
            const receipt = await changeNativeFieldControl(work.environment,work.account,
              { register: work.access.register.bind(work.access), claim: work.access.claim.bind(work.access),
                recordGraphOutcome: work.access.recordGraphOutcome.bind(work.access),
                issueTitleAdmission: work.access.issueTitleAdmission.bind(work.access) },request,
              { ...intent,idempotencyKey: key });
            return Response.json(receipt,{ status: receipt.replayed ? 200 : 201,
              headers: { 'cache-control': 'no-store' } });
          }
          const visible = await work.sourceConversions?.mappedRead(principalId,
            body.source.conversion.split('/').at(-1)!);
          if (!visible) return problem(404, 'field_source_unavailable', 'Source evidence is unavailable');
          const result = await work.sourceFieldApplications.apply(principal, principalId, request,
            key, { profile: body.profile, work: native, field: body.field,
              expectedWorkHead: body.expectedWorkHead, basis: body.basis, value: body.value,
              ...(body.language === undefined ? {} : { language: body.language }),
              origin: 'source', source: body.source, actingSubject: body.actingSubject });
          return Response.json({ ...result.receipt, support: result.support.support,
            replayed: result.replayed }, { status: result.replayed ? 200 : 201,
            headers: { 'cache-control': 'no-store' } });
        }
        if (!work.rights?.store) {
          return problem(503, 'synopsis_rights_unavailable', 'Synopsis rights are unavailable');
        }
        if (await work.rights.store.nativeSynopsisRestricted(native, body.value,
          ['source_apply', 'disclosure'])) {
          return problem(403, 'synopsis_rights_restricted', 'This synopsis expression is restricted');
        }
        const result = await changeNativeFieldControl(work.environment, work.account,
          { register: work.access.register.bind(work.access), claim: work.access.claim.bind(work.access),
            recordGraphOutcome: work.access.recordGraphOutcome.bind(work.access),
            issueTitleAdmission: work.access.issueTitleAdmission.bind(work.access) },
          request, { profile: body.profile, work: native, field: body.field,
            expectedWorkHead: body.expectedWorkHead, basis: body.basis,
            value: body.value, origin: body.origin, source: body.source,
            ...(body.language === undefined ? {} : { language: body.language }),
            actingSubject: body.actingSubject, idempotencyKey: key });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof NativeFieldInvalid) return problem(400, 'invalid_field_control', 'Field control is invalid');
        if (error instanceof NativeFieldConflict) return problem(409, 'field_control_changed', 'Field control changed');
        if (error instanceof NativeFieldUnavailable) return problem(503, 'field_control_unavailable', 'Field control is unavailable');
        if (error instanceof RightsDenied) return problem(403, 'synopsis_rights_restricted', error.message);
        if (error instanceof RightsUnavailable) return problem(503, 'synopsis_rights_unavailable', error.message);
        return commandError(error);
      }
    });
  const fieldSupportRoutes = new Elysia()
    .post('/v1/sources/field-supports', {
      body: ownerSchema<AttachFieldSupportInput | RetainedSupportRequest | NativeCreditAnnotationRequest>(t.Union([t.Object({ profile: t.Literal('source-field-support-attachment-v1'),
        target: groupAgent, slot: t.String({ minLength: 1, maxLength: 200 }),
        occurrence: t.Nullable(groupAgent), context: t.String({ minLength: 1, maxLength: 100 }),
        sourceRecord: groupAgent, conversion: groupAgent,
        grain: t.String({ minLength: 1, maxLength: 64 }),
        sourceField: t.String({ minLength: 1, maxLength: 200 }),
        sourceOccurrence: t.Nullable(t.String({ maxLength: 100 })),
        sourcePointer: t.String({ minLength: 1, maxLength: 200 }),
        expectedHead: groupAgent, actingSubject: groupAgent }, { additionalProperties: false }),retainedSupportRequest,nativeCreditAnnotationRequest])),
      response: transportResponses(openApiOperations["/v1/sources/field-supports"].post, { 200: fieldSupportWrite, 201: fieldSupportWrite,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }): Promise<Response> => {
      try {
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        if (body.profile === 'source-native-credit-annotation-v1') {
          if (!work.sourceNativeCreditAnnotations) return problem(503, 'source_support_unavailable', 'Source annotation owner is unavailable');
          const attached = await work.sourceNativeCreditAnnotations.attach(principal, principalId, key, body);
          return Response.json(attached, { status: attached.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
        }
        await requireSelectedPlatformCapability(work.platformAccess, principal, { exposure: 'platform:catalogue-import',
          operationId: exposureOperationId('POST', '/v1/sources/field-supports') });
        if (body.profile === 'source-field-support-attachment-v1'
          && (!work.sourceFieldAttachments || !work.sourceFieldWithdrawals)) {
          return problem(503, 'source_support_unavailable', 'Source field owner is unavailable');
        }
        if (body.profile === 'source-field-support-attachment-v2') {
          if (!work.sourceRetainedFieldSupports) return problem(503,'source_support_unavailable','Source field owner is unavailable');
          await requireSourceImportAuthority(work,principal);
          const settle = async (session?: WorkReadSession) => {
            const attached = await work.sourceRetainedFieldSupports!.attach(principal,principalId,key,body,session);
            const support = await work.sourceRetainedFieldSupports!.read(principalId,attached.support,attached.step,principal,session);
            if (!support) throw new FieldWithdrawalUnavailable('field support certificate is unavailable');
            return Response.json({ support,replayed: attached.replayed },
              { status: attached.replayed ? 200 : 201,headers: { 'cache-control': 'no-store' } });
          };
          // POST has one attempt: committing callbacks must never run inside read retries.
          return body.native.kind === 'structure-occurrence'
            ? await workRead(work,request,{ actingSubject: body.actingSubject,localBasis: true },settle)
            : await settle();
        }
        const attached = await work.sourceFieldAttachments!.attach(principal, principalId, key, body);
        const support = await work.sourceFieldWithdrawals!.read(principalId, attached.support);
        if (!support) throw new FieldWithdrawalUnavailable('field support certificate is unavailable');
        return Response.json({ support, replayed: attached.replayed },
          { status: attached.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return fieldError(error); }
    })
    .post('/v1/works/:id/author-credits/:credit/retirements', {
      params: creditParams,
      body: t.Object({ profile: t.Literal('work-author-credit-retirement-v1'),
        revision: groupAgent, expectedHead: groupAgent, actingSubject: groupAgent,
        reason: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/author-credits/{credit}/retirements"].post, { 200: t.Object({ retirement: creditRetirement, replayed: t.Boolean() }),
        201: t.Object({ retirement: creditRetirement, replayed: t.Boolean() }),
        202: pendingOperation, ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
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
      params: creditParams,
      query: t.Object({ actingSubject: groupAgent }),
      response: transportResponses(openApiOperations["/v1/works/{id}/author-credits/{credit}/retirement"].get, { 200: creditRetirement, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }): Promise<Response> => {
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
      params: supportParams,
      response: transportResponses(openApiOperations["/v1/sources/supports/{support}"].get, { 200: anySupportResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
      try {
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const annotation = await work.sourceNativeCreditAnnotations?.read(principalId, params.support);
        if (annotation) return Response.json(annotation, { headers: { 'cache-control': 'no-store' } });
        await requireSelectedPlatformCapability(work.platformAccess, principal, { exposure: 'platform:catalogue-import',
          operationId: exposureOperationId('GET', '/v1/sources/supports/{support}') });
        const support = await readAnySupport(work, principalId, params.support, principal);
        if (!support) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
        return Response.json(support, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return fieldError(error); }
    })
    .get('/v1/sources/field-supports/:support', {
      params: supportParams,
      response: transportResponses(openApiOperations["/v1/sources/field-supports/{support}"].get, { 200: t.Union([fieldSupport,nativeCreditAnnotationResult]), ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
      try {
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const annotation = await work.sourceNativeCreditAnnotations?.read(principalId, params.support);
        if (annotation) return Response.json(annotation, { headers: { 'cache-control': 'no-store' } });
        await requireSelectedPlatformCapability(work.platformAccess, principal, { exposure: 'platform:catalogue-import',
          operationId: exposureOperationId('GET', '/v1/sources/field-supports/{support}') });
        if (!work.sourceFieldWithdrawals) return problem(503, 'source_support_unavailable', 'Source field owner is unavailable');
        const support = await work.sourceFieldWithdrawals.read(principalId, params.support, principal);
        if (!support) return problem(404, 'source_support_unavailable', 'Field support is unavailable');
        return Response.json(support, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return fieldError(error); }
    })
    .post('/v1/sources/withdrawals', {
      body: t.Object({ profile: t.Union([t.Literal('source-support-withdrawal-v1'),
        t.Literal('source-field-withdrawal-v1')]),
        support: groupAgent, expectedSupport: groupAgent,
        reason: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/withdrawals"].post, { 200: t.Union([anySupportWrite,fieldSupportWrite]), 201: t.Union([anySupportWrite,fieldSupportWrite]),
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, body }): Promise<Response> => {
      try {
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const annotation = await work.sourceNativeCreditAnnotations?.read(principalId, body.support);
        if (annotation) {
          const withdrawn = await work.sourceNativeCreditAnnotations!.withdraw(principalId, key, body);
          if (!withdrawn) return problem(404, 'source_support_unavailable', 'Source support is unavailable');
          return Response.json(withdrawn, { status: withdrawn.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
        }
        await requireSelectedPlatformCapability(work.platformAccess, principal, { exposure: 'platform:catalogue-import',
          operationId: exposureOperationId('POST', '/v1/sources/withdrawals') });
        if (!work.sourceFieldWithdrawals) return problem(503, 'source_support_unavailable', 'Source field owner is unavailable');
        const current = await readAnySupport(work, principalId, body.support, principal);
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
        } else if (current.kind === 'native-child') {
          if (body.expectedSupport !== body.support) throw new FieldWithdrawalConflict('child support changed');
          const withdrawn = await work.sourceNativeChildren?.withdraw(principalId, key,
            body.support.split('/').at(-1)!, body.reason);
          result = withdrawn?.support ? { support: { kind: 'native-child', support: withdrawn.support },
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
    });
  const creditRoutes = new Elysia()
    .post('/v1/works/:id/source-author-credits', {
      params: workParams, body: authorCreditBody,
      response: transportResponses(openApiOperations["/v1/works/{id}/source-author-credits"].post, { 200: authorCreditWriteResult, 201: authorCreditWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
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
      params: supportParams, response: transportResponses(openApiOperations["/v1/sources/author-credit-supports/{support}"].get, { 200: authorCreditSupportResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
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
      params: supportParams, body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) },
        { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/author-credit-supports/{support}/withdrawals"].post, { 200: authorCreditWriteResult, 201: authorCreditWriteResult, ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
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
    });
  const childRoutes = new Elysia()
    .post('/v1/works/:id/source-children', {
      params: workParams, body: nativeChildBody,
      response: transportResponses(openApiOperations["/v1/works/{id}/source-children"].post, { 200: nativeChildWrite, 201: nativeChildWrite, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
      try {
        if (!work.sourceNativeChildren) return problem(503, 'native_child_unavailable', 'Native child owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceNativeChildren.adopt(principal, principalId, request,
          `https://rezics.com/id/${params.id}`, key, body);
        if (!result) return problem(404, 'source_proposal_unavailable', 'Source proposal is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return childError(error); }
    })
    .get('/v1/sources/native-child-supports/:support', {
      params: supportParams,
      response: transportResponses(openApiOperations["/v1/sources/native-child-supports/{support}"].get, { 200: nativeChildSupport, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
      try {
        if (!work.sourceNativeChildren) return problem(503, 'native_child_unavailable', 'Native child owner is unavailable');
        const principal = await work.account.verify(request, ['source:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceNativeChildren.read(principalId, params.support);
        if (!result) return problem(404, 'native_child_unavailable', 'Source child support is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return childError(error); }
    })
    .post('/v1/sources/native-child-supports/:support/withdrawals', {
      params: supportParams,
      body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/sources/native-child-supports/{support}/withdrawals"].post, { 200: nativeChildWrite, 201: nativeChildWrite,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
      try {
        if (!work.sourceNativeChildren) return problem(503, 'native_child_unavailable', 'Native child owner is unavailable');
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['source:adopt']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceNativeChildren.withdraw(principalId, key, params.support, body.reason);
        if (!result || !result.support) return problem(404, 'native_child_unavailable', 'Source child support is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return childError(error); }
    })
    .get('/v1/works/:id/native-children/:child/revisions/:revision', {
      params: childRevisionParams,
      query: t.Object({ actingSubject: groupAgent }),
      response: transportResponses(openApiOperations["/v1/works/{id}/native-children/{child}/revisions/{revision}"].get, { 200: nativeChildResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }): Promise<Response> => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const resource = `https://rezics.com/id/${params.id}`;
        if (!await work.access.canReadWork(principal, query.actingSubject, resource)) {
          return problem(404, 'native_child_unavailable', 'Native child is unavailable');
        }
        const result = await readNativeChild(work.environment, `https://rezics.com/id/${params.child}`,
          `https://rezics.com/id/${params.revision}`);
        if (!result || result.work !== resource) return problem(404, 'native_child_unavailable', 'Native child is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return childError(error); }
    })
    .post('/v1/works/:id/native-children/:child/retirements', {
      params: childParams,
      body: t.Object({ profile: t.Literal('work-native-child-retirement-v1'),
        revision: groupAgent, expectedHead: groupAgent,
        actingSubject: groupAgent, reason: t.String({ minLength: 1, maxLength: 500 }) },
      { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/native-children/{child}/retirements"].post, { 200: nativeChildRetirementWrite, 201: nativeChildRetirementWrite,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
      try {
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        if (!work.access.issueTitleAdmission) {
          return problem(503, 'native_child_unavailable', 'Native child admission is unavailable');
        }
        const result = await retireNativeChild(work.environment, work.account,
          { register: work.access.register.bind(work.access), claim: work.access.claim.bind(work.access),
            recordGraphOutcome: work.access.recordGraphOutcome.bind(work.access),
            issueTitleAdmission: work.access.issueTitleAdmission.bind(work.access) }, request, {
          work: `https://rezics.com/id/${params.id}`, child: `https://rezics.com/id/${params.child}`,
          revision: body.revision, expectedHead: body.expectedHead, actingSubject: body.actingSubject,
          reason: body.reason, idempotencyKey: key });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return childError(error); }
    })
    .get('/v1/works/:id/native-children/:child/retirements', {
      params: childParams,
      query: t.Object({ actingSubject: groupAgent }),
      response: transportResponses(openApiOperations["/v1/works/{id}/native-children/{child}/retirements"].get, { 200: nativeChildRetirement, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }): Promise<Response> => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const resource = `https://rezics.com/id/${params.id}`;
        if (!await work.access.canReadWork(principal, query.actingSubject, resource)) {
          return problem(404, 'native_child_unavailable', 'Native child is unavailable');
        }
        const result = await readNativeChildRetirement(work.environment,
          `https://rezics.com/id/${params.child}`);
        if (!result || result.work !== resource) return problem(404, 'native_child_unavailable', 'Native child is unavailable');
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return childError(error); }
    })
    .get('/v1/works/:id/author-credits/:credit/revisions/:revision', {
      params: creditRevisionParams,
      query: t.Object({ actingSubject: groupAgent }),
      response: transportResponses(openApiOperations["/v1/works/{id}/author-credits/{credit}/revisions/{revision}"].get, { 200: nativeAuthorCreditResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }): Promise<Response> => {
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
    });
  const titleRoutes = new Elysia()
    .post('/v2/works/:id/source-supports', {
      params: workParams,
      body: t.Object({ profile: t.Literal('native-work-source-title-attachment-v2'),
        proposal: groupAgent, expectedHead: groupAgent, actingSubject: groupAgent,
        confirmedTitle: t.String({ minLength: 1, maxLength: 200 }), titleLanguage: languageTagSchema(35),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v2/works/{id}/source-supports"].post, { 200: sourceAttachmentWriteResult, 201: sourceAttachmentWriteResult,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
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
      params: workParams,
      response: transportResponses(openApiOperations["/v2/works/{id}/source-supports"].get, { 200: sourceSupportCollectionResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
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
      params: bindingParams,
      response: transportResponses(openApiOperations["/v2/works/{id}/source-supports/{binding}"].get, { 200: sourceSupportEntryResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
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
      params: bindingParams,
      body: t.Object({ profile: t.Literal('native-work-source-support-withdrawal-v2'),
        expectedSupport: groupAgent, reason: t.String({ minLength: 1, maxLength: 500 }),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v2/works/{id}/source-supports/{binding}/withdrawal"].post, { 200: sourcePerBindingWithdrawalResult, 201: sourcePerBindingWithdrawalResult,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
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
      params: workParams,
      response: transportResponses(openApiOperations["/v1/works/{id}/source-support"].get, { 200: sourceSupportResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
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
      params: workParams,
      body: t.Object({ profile: t.Literal('native-work-source-support-withdrawal-v1'),
        binding: groupAgent, expectedSupport: groupAgent,
        reason: t.String({ minLength: 1, maxLength: 500 }),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/source-support/withdrawal"].post, { 200: sourceSupportWithdrawalWriteResult, 201: sourceSupportWithdrawalWriteResult,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
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
      params: proposalParams,
      response: transportResponses(openApiOperations["/v1/works/{id}/source-refresh-assessments/{candidateProposal}"].get, { 200: sourceRefreshAssessmentResult, ...authorizedReadProblems,
        409: problemResult(409) }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
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
      params: workParams, query: t.Object({ actingSubject: groupAgent }),
      response: transportResponses(openApiOperations["/v1/works/{id}/title-control"].get, { 200: titleControlState, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }): Promise<Response> => {
      try {
        const principal = await work.account.verify(request, ['work:read']);
        const target = `https://rezics.com/id/${params.id}`;
        if (!await work.access.canReadWork(principal, query.actingSubject, target)) return problem(404, 'work_unavailable', 'Work is unavailable');
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        return Response.json(await readTitleControl(work.environment, target), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/works/:id/title-control/source-return', {
      params: workParams,
      body: t.Object({ proposal: groupAgent, expectedHead: groupAgent, actingSubject: groupAgent,
        titleControl: titleControlBasis }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/title-control/source-return"].post, { 200: titleControlReturnResult, 202: pendingOperation, ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
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
      params: proposalParams,
      body: t.Object({ profile: t.Literal('native-work-source-title-application-v1'),
        expectedHead: groupAgent, actingSubject: groupAgent, titleControl: titleControlBasis,
        language: t.Optional(languageTagSchema(35)),
        confirmedTitle: t.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/source-title-applications/{candidateProposal}"].post, { 200: sourceTitleApplicationWriteResult,
        201: sourceTitleApplicationWriteResult, 202: pendingOperation,
        ...writeProblems, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }): Promise<Response> => {
      try {
        if (!work.sourceAdoptions) return problem(503, 'source_adoption_unavailable',
          'Source adoption owner is unavailable');
        const principal = await work.account.verify(request, ['source:adopt', 'work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
        const result = await work.sourceAdoptions.applyTitle(principalId, request,
          `https://rezics.com/id/${params.id}`, params.candidateProposal,
          { expectedHead: body.expectedHead, actingSubject: body.actingSubject,
            confirmedTitle: body.confirmedTitle, language: body.language, titleControl: body.titleControl });
        if (!result) return problem(404, 'source_title_application_unavailable',
          'Source title proposal or Work binding is unavailable');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/works/:id/source-title-applications/:candidateProposal', {
      params: proposalParams,
      response: transportResponses(openApiOperations["/v1/works/{id}/source-title-applications/{candidateProposal}"].get, { 200: sourceTitleApplicationResult, ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params }): Promise<Response> => {
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
  return new Elysia().use(synopsisRoutes).use(fieldSupportRoutes)
    .use(creditRoutes).use(childRoutes).use(titleRoutes);
}
