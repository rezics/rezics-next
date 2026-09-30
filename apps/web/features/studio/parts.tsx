import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { TriangleAlertIcon } from 'lucide-react';
import type { ContractOf } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { typeLabel } from '../catalogue/types.ts';
import { RetryButton } from '../work-page/retry-button.tsx';
import type { ManuscriptLength } from './counts.ts';
import type { StudioMessages } from './messages.ts';
import type { InventoryState, ReviewMode, SubmissionState } from './types.ts';

// Small pieces every Studio page shares: addresses, names and badges.

type T = ContractOf<StudioMessages>;

/** A BCP 47 tag's name in the interface language ("zh-Hans" → "简体中文"), or the tag itself. */
export function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' }).of(tag) ?? tag; }
  catch { return tag; }
}

/** A Work's kind uses the same name and type precedence as the catalogue. */
export function kindLabel(types: readonly string[], locale: UiLocale, t: T): string {
  return typeLabel(types, locale) ?? t.kindChapter;
}

export function StateBadge({ state, t }: { state: InventoryState; t: T }) {
  if (state === 'published') return <Badge variant="success">{t.statePublished}</Badge>;
  if (state === 'draft') return <Badge variant="outline">{t.stateDraft}</Badge>;
  return <Badge variant="secondary">{t.stateEmpty}</Badge>;
}

// Submissions still open with the Realm come first.
export const openStates = new Set<SubmissionState>(['pending', 'deciding', 'changes-requested']);

export function submissionState(state: SubmissionState, t: T):
  { text: string; variant: 'info' | 'success' | 'warning' | 'outline' } {
  switch (state) {
    case 'pending': return { text: t.submissionPending, variant: 'info' };
    case 'deciding': return { text: t.submissionDeciding, variant: 'info' };
    case 'accepted': return { text: t.submissionAccepted, variant: 'success' };
    case 'changes-requested': return { text: t.submissionChanges, variant: 'warning' };
    case 'rejected': return { text: t.submissionRejected, variant: 'outline' };
    case 'withdrawn': return { text: t.submissionWithdrawn, variant: 'outline' };
    case 'stale': return { text: t.submissionStale, variant: 'outline' };
  }
}

export function SubmissionBadge({ state, t }: { state: SubmissionState; t: T }) {
  const { text, variant } = submissionState(state, t);
  return <Badge variant={variant}>{text}</Badge>;
}

/** What happens after a submission to a Realm with this review mode, in one line. */
export function reviewModeText(mode: ReviewMode | null, t: T): string {
  switch (mode) {
    case 'open': return t.reviewOpen;
    case 'trusted-members': return t.reviewTrusted;
    case 'mandatory': return t.reviewMandatory;
    case null: return t.reviewUnknown;
  }
}

/** A region Main could not fill: a retry when it may answer later, the reason alone when it refused. */
export function Failure({ title, help, retry, t }: { title: string; help?: string; retry: boolean; t: T }) {
  return <Alert variant={retry ? 'destructive' : 'warning'}>
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{title}</AlertTitle>
    {help || retry ? <AlertDescription className="grid justify-items-start gap-2">{help ? <p>{help}</p> : null}
      {retry ? <RetryButton label={t.retry} pendingLabel={t.retry} /> : null}</AlertDescription> : null}
  </Alert>;
}

/** A manuscript's length in the unit its language counts: "1,204 words", "3,580 字". */
export function lengthLabel(length: ManuscriptLength, t: T): string {
  return length.unit === 'characters' ? t.characterCount(length.value) : t.wordCount(length.value);
}

/** A calendar date in the interface language ("Sep 28, 2026", "2026年9月28日"). */
export function formatDate(iso: string, locale: UiLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}
