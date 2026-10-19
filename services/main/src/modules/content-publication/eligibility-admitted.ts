import type { ContentCore } from '../../../../content/src/core.ts';
import { ContentEligibilityStale, ContentEligibilityUnavailable } from './eligibility.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry, GraphTerminalProof }
  from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { RightsStore } from '../rights/store.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch,
  type ContentSearchEligibilityCommand, type ContentSearchEligibilityResult }
  from './eligibility.ts';

/** Review public search eligibility against an admitted original-author proof. */
export async function selectAdmittedPublicContentSearch(
  env: WorkActivationEnvironment, content: ContentCore,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry,
    'register' | 'claim' | 'recordGraphOutcome' | 'verifyContentDraftProof'>
    & Partial<Pick<AccessAdmissionRegistry, 'withOwnerAuthority'>>,
  request: Request,
  input: ContentSearchEligibilityCommand & { idempotencyKey: string },
  rights?: Pick<RightsStore, 'currentPublicDomainAssessment'>,
): Promise<ContentSearchEligibilityResult> {
  const { idempotencyKey, ...eligibility } = input;
  const digest = contentSearchEligibilityDigest(eligibility);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: eligibility.actingSubject,
    scope: `content:search-eligibility:${eligibility.resourceId}`,
    action: 'content.search-eligibility', idempotencyKey, requestDigest: digest });
  const admission = registered.state === 'sealed' ? registered
    : await access.claim(registered.id, digest, principal);
  const select = () => selectPublicContentSearch(env, content, access, admission, eligibility, rights);
  if (eligibility.profile === 'content-search-eligibility-withdrawal-v1' && !access.withOwnerAuthority) {
    throw new ContentEligibilityUnavailable('live author authority is unavailable');
  }
  let result: ContentSearchEligibilityResult;
  let stale: ContentEligibilityStale | undefined;
  try {
    result = eligibility.profile === 'content-search-eligibility-withdrawal-v1'
      ? await access.withOwnerAuthority!({ principal, actingSubject: eligibility.actingSubject,
        action: 'agent.control', scope: `agent:control:${eligibility.actingSubject}` }, select)
      : await select();
  } catch (error) {
    if (!(error instanceof ContentEligibilityStale) || !error.terminal) throw error;
    stale = error;
    result = error.terminal;
  }
  const proof: GraphTerminalProof = {
    outcome: result.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    receipt: result.receipt, admissionId: registered.id, requestDigest: digest,
    authorityEpoch: registered.authorityEpoch, scope: registered.scope,
    dataEpoch: result.graphDataEpoch, sequence: result.graphSequence,
  };
  await access.recordGraphOutcome(registered.id, proof);
  if (stale) throw stale;
  return { ...result, replayed: registered.replayed || result.replayed };
}
