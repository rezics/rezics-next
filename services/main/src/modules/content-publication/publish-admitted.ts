import type { ContentCore, PublicationPreparation } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry, GraphTerminalProof } from '../access/admission.ts';
import { RevisionNotFound } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { assertContentPublicationBody, ContentPublicationConflict, contentPublicationDigest,
  publishPinnedContent, reconcilePinnedContentPublication,
  type ContentPublicationResult, type PublishPinnedContentInput } from './publish.ts';
import { canReadContentTarget, resolveContentTarget, withZoneContentAuthority,
} from './draft.ts';
import { withZonePageContentTarget } from '../access/zone-content-authority.ts';
import { assertPublicContentEmbeds, publicContentEmbedGuards } from './embed-closure.ts';

/** Public command boundary for a pinned, exact PostgreSQL Content revision. */
export async function publishAdmittedContent(
  env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork'>
    & Partial<Pick<AccessAdmissionRegistry, 'activePrincipalId' | 'withOwnerAuthority'>>,
  request: Request,
  input: PublishPinnedContentInput & { actingSubject: string; idempotencyKey: string },
): Promise<ContentPublicationResult> {
  const { actingSubject, idempotencyKey, ...publication } = input;
  const digest = contentPublicationDigest(publication);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const target = await resolveContentTarget(env, publication.resourceId);
  if (publication.targetProfile === 'catalog-description'
    && target.type !== 'https://schema.org/Organization') {
    throw new ContentPublicationConflict('Content profile differs from its target');
  }
  const principal = await account.verify(request, [target.zone ? 'zone:edit' : 'work:edit']);
  // Reject undisclosed and foreign revisions before loading their private bytes.
  if (!await canReadContentTarget(env, access, principal, actingSubject,
    publication.resourceId, target)
    || await content.owningResourceForRevision(publication.revisionId) !== publication.resourceId) {
    throw new RevisionNotFound('Content revision is unavailable');
  }
  await assertContentPublicationBody(content, publication, env);
  const registration = { principal, actingSubject,
    scope: `content:publish:${publication.resourceId}`, action: 'content.publish',
    idempotencyKey, requestDigest: digest };
  const registered = await access.register(target.zone
    ? withZonePageContentTarget(registration, target.zone) : registration);
  const admission = registered.state === 'sealed' ? registered
    : await access.claim(registered.id, digest, principal);
  const dispatch = () => admission.state === 'sealed'
    ? reconcilePinnedContentPublication(env, content, admission, publication)
    : publishPinnedContent(env, content, admission, publication, target);
  const result = target.zone ? await withZoneContentAuthority(env, access, principal,
    actingSubject, target.zone, 'content.publish', dispatch) : await dispatch();
  if (result.status !== 'pending') {
    if (!result.graphDataEpoch || !result.graphSequence) {
      throw new ContentPublicationConflict('terminal graph position is missing');
    }
    const proof: GraphTerminalProof = {
      outcome: result.status === 'active' ? 'succeeded' : 'cancelled',
      receipt: result.receipt, admissionId: registered.id, requestDigest: digest,
      authorityEpoch: registered.authorityEpoch, scope: registered.scope,
      dataEpoch: result.graphDataEpoch, sequence: result.graphSequence,
    };
    await access.recordGraphOutcome(registered.id, proof);
  }
  return { ...result, replayed: registered.replayed || result.replayed };
}

/** Site publishers use this owner primitive before switching their bundle.
 * The ordinary Zone bridge holds live authority while Content creates its pin;
 * the site command retains its own admission and terminal receipt. It must include
 * publicationGuard in its guarded bundle switch, fencing exact embed disclosure. */
export async function pinAdmittedZonePageContent(env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Partial<Pick<AccessAdmissionRegistry, 'activePrincipalId' | 'withOwnerAuthority'>>, request: Request,
  input: PublishPinnedContentInput & { actingSubject: string }): Promise<PublicationPreparation & { publicationGuard: string }> {
  const { actingSubject, ...publication } = input;
  contentPublicationDigest(publication);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const target = await resolveContentTarget(env, publication.resourceId);
  if (!target.zone) throw new ContentPublicationConflict('Site page requires a resolved Zone target');
  if (publication.targetProfile === 'catalog-description') {
    throw new ContentPublicationConflict('Content profile differs from its target');
  }
  const principal = await account.verify(request, ['zone:edit']);
  return withZoneContentAuthority(env, access, principal, actingSubject, target.zone, 'content.publish', async () => {
    if (await content.owningResourceForRevision(publication.revisionId) !== publication.resourceId) {
      throw new RevisionNotFound('Content revision is unavailable');
    }
    await assertContentPublicationBody(content, publication, env);
    const closure = await assertPublicContentEmbeds(env, content, publication.revisionId);
    const preparation = await content.preparePublication(publication.preparationId, publication.revisionId,
      publication.expectedDigest, true, publication.expectedContentEpoch);
    if (preparation.reference.variantId !== publication.variantId
      || preparation.reference.model === 'catalog-description-v1'
      || preparation.position.dataEpoch !== publication.expectedContentEpoch) {
      throw new ContentPublicationConflict('Content page pin differs from publication intent');
    }
    return { ...preparation, publicationGuard: publicContentEmbedGuards(closure.dependencies) };
  });
}
