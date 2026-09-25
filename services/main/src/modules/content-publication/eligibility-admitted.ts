import type { ContentCore } from '../../../../content/src/core.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry, GraphTerminalProof }
  from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch,
  type ContentSearchEligibilityInput, type ContentSearchEligibilityResult }
  from './eligibility.ts';

/** Review public search eligibility against an admitted original-author proof. */
export async function selectAdmittedPublicContentSearch(
  env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry,
    'register' | 'claim' | 'recordGraphOutcome' | 'verifyContentDraftProof'>,
  request: Request,
  input: ContentSearchEligibilityInput & { idempotencyKey: string },
): Promise<ContentSearchEligibilityResult> {
  const { idempotencyKey, ...eligibility } = input;
  const digest = contentSearchEligibilityDigest(eligibility);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: eligibility.actingSubject,
    scope: `content:search-eligibility:${eligibility.variantId}`,
    action: 'content.search-eligibility', idempotencyKey, requestDigest: digest });
  const admission = registered.state === 'sealed' ? registered
    : await access.claim(registered.id, digest);
  const result = await selectPublicContentSearch(env, content, access, admission, eligibility);
  const proof: GraphTerminalProof = {
    outcome: result.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    receipt: result.receipt, admissionId: registered.id, requestDigest: digest,
    authorityEpoch: registered.authorityEpoch, scope: registered.scope,
    dataEpoch: result.graphDataEpoch, sequence: result.graphSequence,
  };
  await access.recordGraphOutcome(registered.id, proof);
  return { ...result, replayed: registered.replayed || result.replayed };
}
