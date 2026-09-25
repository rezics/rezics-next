import type { ContentCore } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry, GraphTerminalProof } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { ContentPublicationConflict, contentPublicationDigest,
  publishPinnedContent, reconcilePinnedContentPublication,
  type ContentPublicationResult, type PublishPinnedContentInput } from './publish.ts';

/** Public command boundary for a pinned, exact PostgreSQL Content revision. */
export async function publishAdmittedContent(
  env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: PublishPinnedContentInput & { actingSubject: string; idempotencyKey: string },
): Promise<ContentPublicationResult> {
  const { actingSubject, idempotencyKey, ...publication } = input;
  const digest = contentPublicationDigest(publication);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject,
    scope: `content:publish:${publication.variantId}`, action: 'content.publish',
    idempotencyKey, requestDigest: digest });
  const admission = registered.state === 'sealed' ? registered
    : await access.claim(registered.id, digest);
  const result = admission.state === 'sealed'
    ? await reconcilePinnedContentPublication(env, content, admission, publication)
    : await publishPinnedContent(env, content, admission, publication);
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
