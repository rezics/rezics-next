import type { CollectionPrivacyEditor } from './collection-privacy-recovery';
import type { VerificationInput } from './verification-core';
import type { VerificationRecoveryState } from './verification-recovery';
import type { useSession } from '../session/query';

type Session = ReturnType<typeof useSession>;
export function settingsDraftViewerIsCurrent(
  owner: Pick<Session, 'subject' | 'csrfToken'> | null,
  current: Session | undefined,
  csrfToken: string | null,
) {
  return (
    !!owner?.subject &&
    current?.state === 'signed-in' &&
    current.subject === owner.subject &&
    current.csrfToken === owner.csrfToken &&
    csrfToken === owner.csrfToken
  );
}

export function collectionPrivacyNeedsNavigationDecision(state: ReturnType<CollectionPrivacyEditor['snapshot']>) {
  return (
    state.attempt !== null ||
    state.intent !== undefined ||
    (state.current !== null && state.desired !== state.current.visibility)
  );
}

type VerificationDraft = Omit<VerificationInput, 'idempotencyKey' | 'subject'> & { subject: string | null };
const emptyVerificationDraft: VerificationDraft = { subject: null, statement: '', links: [] };

export function verificationNeedsNavigationDecision(
  state: VerificationRecoveryState,
  draft: VerificationDraft,
  acknowledged: Omit<VerificationInput, 'idempotencyKey'> | null = null,
) {
  // Only the recovery controller can resolve an original command, using its receipt and native request ID.
  if (state.attempt) return true;
  const subject = draft.subject || null;
  const links = draft.links.filter((link) => link.label || link.url);
  if (!acknowledged && !subject && !draft.statement && links.length === 0) return false;
  const request = state.current?.verificationRequest;
  const known = state.current
    ? request
      ? { subject: request.catalogueSubjectId, statement: request.statement, links: request.links }
      : emptyVerificationDraft
    : (acknowledged ?? emptyVerificationDraft);
  return (
    subject !== known.subject ||
    draft.statement !== known.statement ||
    links.length !== known.links.length ||
    links.some((link, index) => link.label !== known.links[index]?.label || link.url !== known.links[index]?.url)
  );
}
