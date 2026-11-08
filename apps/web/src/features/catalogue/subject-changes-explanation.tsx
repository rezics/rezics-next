import { Link } from '@tanstack/react-router';
import { languageName } from '../../subject/language';
import { candidateContext } from '../../subject/candidates';
import type { CurrentCandidateAddress, CurrentCorrectionAddress } from './subject-changes-navigation';
import type { TermField } from './subject-terms';
import { m } from '../../paraglide/messages.js';
import type { ChangeDetail, CurrentOperationsRead } from './subject-changes';

const actionClassName =
  'relative z-10 h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function currentReviewHref(pageHref: string | undefined, address: CurrentCandidateAddress) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !pageHref?.startsWith('/') ||
    pageHref.startsWith('//') ||
    pageHref.includes('\\') ||
    !uuid.test(address.subject) ||
    !uuid.test(address.candidate) ||
    !uuid.test(address.context) ||
    !address.property ||
    address.property.length > 256
  )
    return undefined;
  const query = new URLSearchParams({
    reviewProperty: address.property,
    candidate: address.candidate,
    context: address.context,
    returnTo: 'changes',
  });
  return `${pageHref.replace(/\/$/, '')}/edit?${query.toString()}`;
}

function CurrentReviewLink({
  pageHref,
  address,
  revision,
  onReviewCandidate,
}: {
  pageHref?: string | undefined;
  address: CurrentCandidateAddress;
  revision: number;
  onReviewCandidate?: (address: CurrentCandidateAddress, href: string, revision: number) => boolean;
}) {
  const href = currentReviewHref(pageHref, address);
  if (!href || !onReviewCandidate) return null;
  return (
    <Link
      className={`${actionClassName} inline-flex items-center text-primary underline-offset-4 hover:underline`}
      to={href as never}
      onClick={(event) => {
        if (!onReviewCandidate(address, `${pageHref!.replace(/\/$/, '')}/changes`, revision)) event.preventDefault();
      }}
    >
      {m.changes_review_current()}
    </Link>
  );
}

function currentCorrectionHref(pageHref: string | undefined, address: CurrentCorrectionAddress) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!pageHref?.startsWith('/') || pageHref.startsWith('//') || pageHref.includes('\\') || !uuid.test(address.subject))
    return undefined;
  const base = pageHref.replace(/\/$/, '');
  if (address.kind === 'terms') return `${base}/terms?returnTo=changes`;
  if (address.kind === 'subject') return `${base}/edit?returnTo=changes`;
  if (!address.property || address.property.length > 256 || address.context !== candidateContext) return undefined;
  return `${base}/edit?${new URLSearchParams({ property: address.property, returnTo: 'changes' }).toString()}`;
}

function correctionAddress(detail: ChangeDetail): CurrentCorrectionAddress | undefined {
  if (detail.summary.kind === 'terms') return { kind: 'terms', subject: detail.id };
  if (detail.summary.kind === 'limited') return { kind: 'subject', subject: detail.id };
  if (
    'property' in detail.summary &&
    'context' in detail.summary &&
    detail.summary.context === candidateContext &&
    detail.summary.property
  )
    return {
      kind: 'property',
      subject: detail.id,
      property: detail.summary.property,
      context: detail.summary.context,
    };
  return undefined;
}

function CurrentCorrectionAction({
  detail,
  revision,
  locale,
  pageHref,
  currentOperations,
  onCorrectCurrent,
}: {
  detail: ChangeDetail;
  revision: number;
  locale: string;
  pageHref?: string | undefined;
  currentOperations?: CurrentOperationsRead | undefined;
  onCorrectCurrent?: (address: CurrentCorrectionAddress, href: string, revision: number) => boolean;
}) {
  const o = { locale: locale as never };
  if (!currentOperations || currentOperations.state === 'unavailable')
    return <p role="status">{m.changes_correction_unavailable({}, o)}</p>;
  if (currentOperations.state === 'preparing') return <p role="status">{m.changes_correction_preparing({}, o)}</p>;
  const address = correctionAddress(detail);
  if (!address) return <p role="status">{m.changes_correction_unavailable({}, o)}</p>;
  const operation = address.kind === 'terms' ? 'subject.terms' : 'subject.propose';
  if (!currentOperations.operations.includes(operation))
    return <p role="status">{m.changes_correction_denied({}, o)}</p>;
  const href = currentCorrectionHref(pageHref, address);
  if (!href || !onCorrectCurrent) return <p role="status">{m.changes_correction_unavailable({}, o)}</p>;
  return (
    <Link
      className={`${actionClassName} inline-flex items-center text-primary underline-offset-4 hover:underline`}
      to={href as never}
      onClick={(event) => {
        if (!onCorrectCurrent(address, `${pageHref!.replace(/\/$/, '')}/changes`, revision)) event.preventDefault();
      }}
    >
      {address.kind === 'terms' ? m.changes_correct_terms({}, o) : m.changes_correct_current({}, o)}
    </Link>
  );
}

export function ChangeExplanation({
  detail,
  revision,
  locale,
  pageHref,
  onReviewCandidate,
  currentOperations,
  onCorrectCurrent,
}: {
  detail: ChangeDetail;
  revision: number;
  locale: string;
  pageHref?: string | undefined;
  onReviewCandidate?: (address: CurrentCandidateAddress, href: string, revision: number) => boolean;
  currentOperations?: CurrentOperationsRead | undefined;
  onCorrectCurrent?: (address: CurrentCorrectionAddress, href: string, revision: number) => boolean;
}) {
  const o = { locale: locale as never };
  const summary = detail.summary;
  const reading = summary.kind === 'candidate' || summary.kind === 'decision' ? summary.reading : undefined;
  const rank = (value: 'normal' | 'preferred' | 'deprecated') =>
    value === 'normal'
      ? m.candidate_rank_normal({}, o)
      : value === 'preferred'
        ? m.candidate_rank_preferred({}, o)
        : m.changes_rank_deprecated({}, o);
  const field = (kind: TermField) =>
    kind === 'labels'
      ? m.changes_name({}, o)
      : kind === 'descriptions'
        ? m.changes_description({}, o)
        : m.changes_aliases({}, o);
  return (
    <div className="min-w-0 space-y-3">
      <p>
        {summary.kind === 'limited'
          ? m.changes_limited({}, o)
          : summary.kind === 'terms'
            ? m.changes_terms({}, o)
            : summary.kind === 'candidate'
              ? m.changes_proposal_detail({}, o)
              : summary.kind === 'decision'
                ? summary.decision === 'accept'
                  ? m.changes_accepted_detail({}, o)
                  : summary.decision === 'reject'
                    ? m.changes_rejected_detail({}, o)
                    : m.changes_abstained_detail({}, o)
                : m.changes_adopted_detail({}, o)}
      </p>
      {summary.kind === 'terms' && (
        <dl className="space-y-2 text-sm" aria-label={m.changes_fields({}, o)}>
          {summary.fields.map((entry, index) => (
            <div key={index}>
              <dt className="text-muted-foreground">{field(entry.field)}</dt>
              <dd>
                {entry.languages
                  .map((tag) => languageName(tag, locale) ?? m.subject_value_unlabelled({}, o))
                  .join(' · ')}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {detail.propertyLabel?.text && (
        <p lang={detail.propertyLabel.lang} className="font-medium">
          {detail.propertyLabel.text}
        </p>
      )}
      {'context' in summary && summary.context && (
        <dl className="space-y-2 text-sm">
          <dt className="text-muted-foreground">{m.context_title({}, o)}</dt>
          <dd>{summary.context === candidateContext ? m.context_global({}, o) : m.context_unnamed({}, o)}</dd>
        </dl>
      )}
      {reading && (
        <section className="space-y-2 text-sm" aria-label={m.changes_current({}, o)}>
          <h3 className="font-medium">{m.changes_current({}, o)}</h3>
          <p>
            {reading.decision === null
              ? m.candidate_unresolved({}, o)
              : reading.decision.verdict === 'accept'
                ? m.context_accepted({}, o)
                : reading.decision.verdict === 'reject'
                  ? m.candidate_rejected_state({}, o)
                  : m.changes_abstained_detail({}, o)}
          </p>
          <p>{reading.selected ? m.context_selected({}, o) : m.value_not_selected({}, o)}</p>
          {reading.rank !== null && (
            <p>
              {m.candidate_rank({}, o)}: {rank(reading.rank)}
            </p>
          )}
        </section>
      )}
      {(summary.kind === 'candidate' || summary.kind === 'decision') && summary.candidate && summary.property && (
        <section className="space-y-2" aria-label={m.changes_review_current({}, o)}>
          <p className="text-sm text-muted-foreground">{m.changes_review_notice({}, o)}</p>
          <CurrentReviewLink
            pageHref={pageHref}
            address={{
              subject: detail.id,
              property: summary.property,
              candidate: summary.candidate,
              context: summary.context ?? candidateContext,
            }}
            revision={revision}
            onReviewCandidate={onReviewCandidate}
          />
        </section>
      )}
      {summary.kind === 'adoption' && (
        <section className="space-y-2 text-sm" aria-label={m.changes_recorded({}, o)}>
          <h3 className="font-medium">{m.changes_recorded({}, o)}</h3>
          {summary.mode && (
            <p>
              {m.context_mode({}, o)}:{' '}
              {summary.mode === 'inherit'
                ? m.context_inherit({}, o)
                : summary.mode === 'replace'
                  ? m.context_replace({}, o)
                  : m.context_suppress({}, o)}
            </p>
          )}
          <ol className="space-y-2">
            {summary.selection?.slice(0, 32).map((entry, index) => (
              <li key={entry.candidate} className="space-y-1">
                <span className="block">
                  {m.facts_selected_value({ number: String(index + 1) }, o)} · {rank(entry.rank)}
                </span>
                <CurrentReviewLink
                  pageHref={pageHref}
                  address={{
                    subject: detail.id,
                    property: summary.property,
                    candidate: entry.candidate,
                    context: summary.context,
                  }}
                  revision={revision}
                  onReviewCandidate={onReviewCandidate}
                />
              </li>
            ))}
          </ol>
          <p className="text-sm text-muted-foreground">{m.changes_choose_candidate({}, o)}</p>
          <p className="text-sm text-muted-foreground">{m.changes_review_notice({}, o)}</p>
        </section>
      )}
      <section className="space-y-2" aria-label={m.changes_correct_current({}, o)}>
        <CurrentCorrectionAction
          detail={detail}
          revision={revision}
          locale={locale}
          pageHref={pageHref}
          currentOperations={currentOperations}
          onCorrectCurrent={onCorrectCurrent}
        />
      </section>
    </div>
  );
}
