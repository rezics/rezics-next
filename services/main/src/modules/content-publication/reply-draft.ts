import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ContentConflict, contentDraftIntentDigest, type ContentCore,
  type SaveDraftCommand } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry, type VerifiedPrincipal } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readReplyRoot, replyRoot, resolveCanonicalReplyParent,
  type CanonicalReplyParentReader, type ValidatedCanonicalReplyParent } from '../realm-reply/root.ts';
import { targetRead } from '../target/resolve.ts';
import { WorkReadMissing, WorkReadUnavailable } from '../work/read-session.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { ContentDraftStale, contentDraftReceiptIri, sealContentDraftAdmission } from './draft.ts';
import { authoredDocumentBody } from '../../../../content/src/document-body.ts';
import { hasDocumentContent, type DocumentSnapshot } from '@rezics/document';

/** Direct root probes run before and after admission; Access baseline and
 * delegated target authority retain their owners' separate cost contracts. */
export const MEMBER_REPLY_COST = { bodyBytes: 8192, pageSize: 32,
  graphQueries: 11, graphResponseBytes: 262_144, ownerRowLocks: 12, priorRevisionReads: 1 } as const;
export interface MemberReplyDraft {
  originRealm?: string | null;
  spoiler?: boolean;
  reply: string; variantId: string; rootTarget: string; rootRevision: string;
  language: string; direction: 'ltr' | 'rtl' | 'none'; expectedHead: string | null;
  body?: string | null; document?: DocumentSnapshot; actingSubject: string;
}

/** Server command input: `about` and the observed live target revision come
 * from the Zone attachment; opener and parent are resolved by the owner. */
export interface CanonicalAboutReplyDraft extends Omit<MemberReplyDraft, 'rootTarget' | 'rootRevision' | 'originRealm'> {
  about: string; realm: string; targetRevision: string; originRealm: string;
}

export type VerifiedMemberReplyDraftIntent =
  | { kind: 'member-reply'; input: MemberReplyDraft }
  | { kind: 'canonical-about-reply'; input: CanonicalAboutReplyDraft; parentReader: CanonicalReplyParentReader };

export interface MemberReplyDraftResult {
  reply: string; variantId: string; revisionId: string; revisionDigest: string;
  predecessor: string | null; deleted: boolean;
  sourcePosition: { dataEpoch: string; sequence: string }; replayed: boolean;
}

export interface CanonicalAboutReplyDraftResult extends MemberReplyDraftResult {
  rootTarget: string; rootRevision: string; originRealm: string;
  canonicalParent: ValidatedCanonicalReplyParent | null;
}

interface PreparedDraft { body: ReturnType<typeof authoredDocumentBody> | { body: string }; deleted: boolean }

type ReplyDraftAccess = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
  & Partial<Pick<AccessAdmissionRegistry, 'fenceClaim' | 'withRealmPolicy' | 'canReadWork' | 'canReadSemanticResource'>>;

interface DraftPlan {
  input: MemberReplyDraft;
  canonical?: { realm: string; about: string; targetRevision: string; reader: CanonicalReplyParentReader };
}

function planDraft(intent: VerifiedMemberReplyDraftIntent): DraftPlan {
  if (intent.kind === 'member-reply') return { input: intent.input };
  const input = intent.input;
  const allowed = new Set(['about', 'realm', 'targetRevision', 'originRealm', 'reply', 'variantId',
    'language', 'direction', 'expectedHead', 'body', 'document', 'actingSubject', 'spoiler']);
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.has(key)))
    throw new ContentConflict('canonical reply parent is owner-derived');
  return { input: { ...input, rootTarget: input.about, rootRevision: input.targetRevision,
    originRealm: input.originRealm },
    canonical: { realm: input.realm, about: input.about, targetRevision: input.targetRevision,
      reader: intent.parentReader } };
}

function prepareDraft(input: MemberReplyDraft): PreparedDraft {
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  if (input.spoiler !== undefined && typeof input.spoiler !== 'boolean') throw new ContentConflict('invalid reply spoiler');
  const deleted = input.body === null && input.document === undefined;
  let body: { body: string; document?: DocumentSnapshot };
  try { body = deleted ? { body: '' } : authoredDocumentBody({
    ...(input.body !== undefined ? { body: input.body as string } : {}),
    ...(input.document !== undefined ? { document: input.document } : {}),
  }, MEMBER_REPLY_COST.bodyBytes); }
  catch { throw new ContentConflict('invalid member reply body'); }
  if (![input.reply, input.rootTarget, input.rootRevision, input.actingSubject].every(value => native.test(value))
    || input.originRealm != null && !native.test(input.originRealm)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/.test(input.variantId)
    || (deleted ? input.expectedHead === null
      : body.document ? !hasDocumentContent(body.document) : !body.body)) {
    throw new ContentConflict('invalid member reply draft');
  }
  return { body, deleted };
}

function sameCanonicalParent(left: ValidatedCanonicalReplyParent | null,
  right: ValidatedCanonicalReplyParent | null): boolean {
  if (left === null || right === null) return left === right;
  return left.realm === right.realm && left.about === right.about && left.reply === right.reply
    && left.parentRevision === right.parentRevision && left.rootRevision === right.rootRevision
    && left.originRealm === right.originRealm;
}

/** The author/root binding and every edit/delete use Content's draft CAS and
 * immutable receipts. Deletion is a tombstone revision; retained history and
 * moderation evidence remain intact. A later edit never inherits Realm review. */
async function saveVerifiedDraft(env: WorkActivationEnvironment, content: ContentCore,
  access: ReplyDraftAccess, principal: VerifiedPrincipal, plan: DraftPlan,
  key: string, prepared: PreparedDraft, graphOpen = false): Promise<MemberReplyDraftResult | CanonicalAboutReplyDraftResult> {
  const input = plan.input;
  const { body, deleted } = prepared;
  if (!graphOpen) await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  if (input.originRealm) {
    if (!access.withRealmPolicy) throw new AdmissionDenied('Realm policy owner is unavailable');
  }
  let spoiler = input.spoiler;
  if (input.expectedHead !== null) {
    const prior = (await content.readExactBatch([input.expectedHead], async ids => new Set(ids)))[0];
    if (prior?.status !== 'available' || prior.reference.resourceId !== input.reply
      || prior.reference.variantId !== input.variantId || prior.reference.model !== 'member-reply-v1'
      || prior.reference.provenance.kind !== 'admitted-original-contribution-v1'
      || typeof prior.reference.provenance.author !== 'string'
      || prior.body.spoiler !== undefined && typeof prior.body.spoiler !== 'boolean') {
      throw new ContentConflict('prior reply declaration is unavailable');
    }
    // Root participation admits a new reply, not correction of another author's
    // retained bytes. Content still fences immutable authorship in its final CAS.
    if (prior.reference.provenance.author !== input.actingSubject) {
      throw new AdmissionDenied('reply author authority is required');
    }
    if (spoiler === undefined) spoiler = prior.body.spoiler as boolean | undefined;
  }
  const proveRoot = async (creating: boolean) => {
    try {
      const readable = await targetRead(env, { access, principal, actingSubject: input.actingSubject },
        session => (creating ? replyRoot : readReplyRoot)(session, input.rootTarget, input.rootRevision));
      if (!readable) throw new AdmissionDenied('reply root is unavailable');
    } catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
      // The first probe is before the key. An unseen root matches a missing id.
      // A root lost after the key is claimed stays open for the same key.
      if (!creating) throw error;
      throw new WorkReadUnavailable('reply root is unavailable');
    }
  };
  let canonicalParent: ValidatedCanonicalReplyParent | null = null;
  if (plan.canonical) {
    canonicalParent = await targetRead(env, { access, principal, actingSubject: input.actingSubject }, session =>
      resolveCanonicalReplyParent(session, { realm: plan.canonical!.realm, about: plan.canonical!.about,
        targetRevision: plan.canonical!.targetRevision, originRealm: input.originRealm! },
      principal, input.actingSubject, plan.canonical!.reader));
    if (canonicalParent) input.rootRevision = canonicalParent.rootRevision;
    else input.rootRevision = plan.canonical.targetRevision;
  } else await proveRoot(false);
  const command: SaveDraftCommand = { operationId: '', variant: { id: input.variantId,
    resourceId: input.reply, language: { kind: 'tag', tag: input.language, originalTag: input.language },
    direction: input.direction }, expectedHead: input.expectedHead, model: 'member-reply-v1',
    sourceRevision: input.rootRevision, provenance: {}, serializedJson: JSON.stringify({ ...body,
      deleted, rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      ...(spoiler !== undefined ? { spoiler } : {}),
      ...(input.originRealm ? { originRealm: input.originRealm } : {}),
      ...(plan.canonical ? { canonicalParent: canonicalParent ? { realm: canonicalParent.realm,
        about: canonicalParent.about, reply: canonicalParent.reply,
        parentRevision: canonicalParent.parentRevision, rootRevision: canonicalParent.rootRevision,
        originRealm: canonicalParent.originRealm } : null } : {}) }) };
  const digest = contentDraftIntentDigest(command, input.actingSubject);
  const scope = `content:draft:${input.reply}`;
  const admission = await access.register({ principal, actingSubject: input.actingSubject, action: 'content.draft', scope,
    baselineRelatedWork: input.rootTarget, baselineSourceRevision: input.rootRevision,
    idempotencyKey: key, requestDigest: digest });
  command.operationId = `content-draft:${admission.id}`;
  let priorReceipt = await content.readDraftReceipt(command.operationId);
  const creating = input.expectedHead === null && !priorReceipt;
  command.provenance = { kind: 'admitted-original-contribution-v1', author: input.actingSubject,
    admissionId: admission.id, authorityEpoch: admission.authorityEpoch, scope, requestDigest: digest,
    expectedHead: input.expectedHead, rightsBasis: 'original-contribution' };
  if (admission.state !== 'sealed') {
    try {
      if (!admission.dispatchEligible) throw new AdmissionDenied('reply draft dispatch is fenced');
      await access.claim(admission.id, digest, principal);
    } catch (error) {
      priorReceipt = await content.readDraftReceipt(command.operationId);
      if (!priorReceipt) {
        await access.recordGraphOutcome(admission.id, await sealContentDraftAdmission(content, admission));
        throw error;
      }
    }
  }
  // The earlier probe already disclosed the retained root. A new draft still
  // binds the target's current root; an edit does not resolve it again.
  try {
    if (!priorReceipt && plan.canonical) {
      const current = await targetRead(env, { access, principal, actingSubject: input.actingSubject }, session =>
        resolveCanonicalReplyParent(session, { realm: plan.canonical!.realm, about: plan.canonical!.about,
          targetRevision: plan.canonical!.targetRevision, originRealm: input.originRealm! },
        principal, input.actingSubject, plan.canonical!.reader));
      if (!sameCanonicalParent(canonicalParent, current)) throw new ContentDraftStale('canonical reply parent changed');
    } else if (!priorReceipt && creating) await proveRoot(true);
  }
  catch (error) {
    if (error instanceof WorkReadUnavailable) throw error;
    await access.recordGraphOutcome(admission.id, await sealContentDraftAdmission(content, admission));
    throw error;
  }
  let saved;
  try {
    const save = async (client?: PoolClient) => {
      if (!priorReceipt) {
        if (client) {
          if (!access.fenceClaim) throw new AdmissionDenied('Realm dispatch authority is unavailable');
          await access.fenceClaim(client, admission.id, digest, principal);
        } else await access.claim(admission.id, digest, principal);
      }
      return content.saveDraft(command);
    };
    // Registration/claim and root probes are complete before this callback.
    // Its held connection only revalidates the durable claim; native bytes
    // cannot escape an uncommitted Access admission on callback rollback.
    saved = input.originRealm && !priorReceipt
      ? await access.withRealmPolicy!(principal, input.actingSubject, input.originRealm, 'reply', async (permit, client) => {
        const policy = await readRealmPolicy(env, input.originRealm!);
        if (!policy || policy.visibility !== 'public' && !permit.member) throw new AdmissionDenied('Realm is unavailable');
        return save(client);
      }) : await save();
  }
  catch (error) {
    if (error instanceof ContentConflict || error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
      const terminal = await sealContentDraftAdmission(content, admission);
      await access.recordGraphOutcome(admission.id, terminal);
      if (terminal.outcome === 'succeeded') saved = await content.saveDraft(command);
      else {
        if (error instanceof AdmissionExpired) throw new ContentDraftStale('admission expired during claim verification');
        throw error;
      }
    }
    else throw error;
  }
  await access.recordGraphOutcome(admission.id, { admissionId: admission.id, requestDigest: digest,
    authorityEpoch: admission.authorityEpoch, scope, receipt: contentDraftReceiptIri(admission.id),
    outcome: saved.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    dataEpoch: saved.position.dataEpoch, sequence: saved.position.sequence });
  if (saved.outcome === 'stale_head') throw new ContentDraftStale('reply head changed');
  if (saved.outcome !== 'succeeded') throw new AdmissionDenied('reply draft was cancelled');
  const result: MemberReplyDraftResult = { reply: input.reply, variantId: input.variantId, revisionId: saved.revisionId!,
    revisionDigest: createHash('sha256').update(command.serializedJson).digest('hex'),
    predecessor: saved.predecessor, deleted,
    sourcePosition: saved.position, replayed: admission.replayed || saved.replayed };
  return plan.canonical ? { ...result, rootTarget: input.rootTarget, rootRevision: input.rootRevision,
    originRealm: input.originRealm!, canonicalParent } : result;
}

/** Internal bridge for callers with an already-verified Account identity.
 * Callers must obtain `principal` with `verifyMemberReplyDraftPrincipal(account, request)`,
 * which verifies the `comment:create` scope. The canonical path takes about/Realm
 * coordinates and a server owner reader; it never accepts opener or parent ids. */
export async function saveVerifiedMemberReplyDraft(env: WorkActivationEnvironment, content: ContentCore,
  access: ReplyDraftAccess, principal: VerifiedPrincipal, intent: VerifiedMemberReplyDraftIntent,
  key: string): Promise<MemberReplyDraftResult | CanonicalAboutReplyDraftResult> {
  const plan = planDraft(intent);
  const prepared = prepareDraft(plan.input);
  return saveVerifiedDraft(env, content, access, principal, plan, key, prepared);
}

/** Verify Account identity for a member reply draft, including its write scope.
 * Server commands and the Request adapter share this check before drafting. */
export async function verifyMemberReplyDraftPrincipal(account: Pick<AccountAssertionVerifier, 'verify'>,
  request: Request): Promise<VerifiedPrincipal> {
  return account.verify(request, ['comment:create']);
}

/** Request adapter retained for existing public drafts. It verifies Account
 * first, then uses the same owner flow as the already-verified entrypoint. */
export async function saveMemberReplyDraft(env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: ReplyDraftAccess,
  request: Request, input: MemberReplyDraft, key: string): Promise<MemberReplyDraftResult> {
  const prepared = prepareDraft(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await verifyMemberReplyDraftPrincipal(account, request);
  const result = await saveVerifiedDraft(env, content, access, principal,
    { input }, key, prepared, true);
  return result;
}
