import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { Link } from '@tanstack/react-router';
import { useCandidateWork, type CandidateWork } from './candidate-lifetime';
import { ContextComparisonView } from '../features/catalogue/context-curation-view';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { CandidateValue, pageText } from '../features/pages/data';
import { webUrl } from '../features/pages/shared';
import { m } from '../paraglide/messages.js';
import { subjectHref } from './subject-href';
import { candidateCanSelect, editCandidateDraft, refreshCandidateDraft, type CandidateDraft } from './candidate-draft';
import {
  candidateSourceRecords,
  publicCandidateSelection,
  publicSlotStatements,
  type Candidate,
  type CandidateCommand,
  type CandidateFailure,
  type CandidateRead,
  type CandidateResult,
  type CandidateSlot,
} from './candidates';
import { ContributionLifecycle } from '../features/catalogue/contribution-lifecycle-view';
import type {
  ContributionAddress,
  ContributionAvailability,
  ContributionCommand,
  ContributionResult,
} from '../features/catalogue/contribution-lifecycle';

export type CandidateTransport = {
  /** Explicit fixture observation; production inherits the prepared session boundary. */
  reader?: string;
  read: (property?: string, cursor?: string, session?: string, work?: CandidateWork) => Promise<CandidateRead>;
  confirm: (command: CandidateCommand, work?: CandidateWork) => Promise<CandidateResult>;
};

/** Session BFF for own-contribution delete/restore. Native author evidence remains authoritative. */
export type CandidateLifecycle = {
  change: (command: ContributionCommand, work: CandidateWork) => Promise<ContributionResult>;
  read: (address: ContributionAddress, work: CandidateWork) => Promise<ContributionAvailability>;
};

/** A session-only region: the owning subject route mounts it only after sign-in hydration. */
export function CandidateReview(props: Omit<ComponentProps<typeof CandidateReviewLive>, 'work'>) {
  const { id, locale, initialProperty, exactCandidate, context, slot, returnHref, returnLabel, returnUnavailable } = props;
  const work = useCandidateWork(
    JSON.stringify([
      id,
      locale,
      initialProperty,
      exactCandidate,
      context,
      slot?.target,
      slot?.sameAs,
      slot?.key,
      returnHref,
      returnLabel,
      returnUnavailable,
    ]),
    props.transport.reader,
  );
  if (!work.live()) return null;
  return <CandidateReviewLive key={work.generation} {...props} work={work} />;
}

function CandidateReviewLive({
  id,
  locale,
  transport,
  lifecycle,
  initialProperty,
  exactCandidate,
  context,
  slot,
  returnHref,
  returnLabel,
  returnUnavailable,
  documents,
  work,
}: {
  work: CandidateWork;
  id: string;
  locale: string;
  transport: CandidateTransport;
  lifecycle?: CandidateLifecycle;
  initialProperty?: string | undefined;
  exactCandidate?: string;
  context?: string;
  returnHref?: string;
  returnLabel?: string;
  returnUnavailable?: boolean;
  slot?: CandidateSlot | undefined;
  documents?: { public: unknown; candidates: unknown };
}) {
  const options = { locale: locale as never };
  const [opened, setOpened] = useState(!!(initialProperty && exactCandidate));
  const [read, setRead] = useState<CandidateRead>();
  const [property, setProperty] = useState(initialProperty ?? '');
  const [candidate, setCandidate] = useState<Candidate>();
  const [lifecycleCandidate, setLifecycleCandidate] = useState(exactCandidate);
  const [confirmation, setConfirmation] = useState<CandidateCommand['operation'] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>({});
  const [modes, setModes] = useState<Record<string, 'inherit' | 'replace' | 'suppress'>>({});
  const mode = modes[property] ?? 'replace';
  const [busy, setBusy] = useState(false);
  const [requiresReload, setRequiresReload] = useState(false);
  const [failure, setFailure] = useState<CandidateFailure>();
  const [result, setResult] = useState<CandidateResult & { ok: true }>();
  const confirmationTitle = useId();
  const confirmationRegion = useRef<HTMLElement>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreConfirmationFocus = useRef(false);
  const request = useRef<CandidateCommand | null>(null);
  const running = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const openedTarget = useRef<string | null>(null);
  const target =
    initialProperty && exactCandidate
      ? JSON.stringify([id, initialProperty, exactCandidate, context, slot?.target, slot?.sameAs, slot?.key])
      : null;
  const current = read?.ok ? read : undefined;
  const publicRead = context
    ? (result?.contextReview?.reading ?? current?.contextReview?.reading)
    : result
      ? result.public
      : current?.public;
  const draft = drafts[property];
  const maximum = current?.fields.find((field) => field.id === property)?.multivalued ? 32 : 1;
  const locked = busy || confirmation !== null || !!request.current || !!result;
  const safeReturnHref =
    returnHref && returnHref.startsWith('/') && !returnHref.startsWith('//') && !returnHref.includes('\\')
      ? returnHref
      : undefined;
  const publicStatements = context
    ? (result?.contextReview?.selected ?? current?.contextReview?.selected ?? []).filter(
        (statement) => statement.rank === 'normal' || statement.rank === 'preferred',
      )
    : publicRead
      ? publicSlotStatements(publicRead, property, slot)
      : [];
  // Public values outside this page remain choices. No page ever stands in for the whole selection.
  const choices = new Map(publicStatements.map((statement) => [statement.id, { statement, eligible: true }]));
  for (const item of current?.page?.candidates ?? [])
    choices.set(item.id, { statement: item.statement, eligible: candidateCanSelect(item) });
  const valid =
    (context && mode !== 'replace') ||
    (!!draft &&
      draft.selection.length <= maximum &&
      draft.selection.every((entry) => choices.get(entry.candidate)?.eligible));
  const action =
    confirmation === 'reject'
      ? m.candidate_reject({}, options)
      : confirmation === 'adopt'
        ? context
          ? m.context_adopt({}, options)
          : m.candidate_adopt({}, options)
        : m.candidate_accept({}, options);

  async function load(field = property, cursor?: string) {
    if (!work.live() || running.current || request.current) return;
    running.current = true;
    setOpened(true);
    setBusy(true);
    setFailure(undefined);
    setConfirmation(null);
    setCandidate(undefined);
    setResult(undefined);
    try {
      const next = await transport.read(field || undefined, cursor, session.current, work);
      if (!work.live()) return;
      if (!next.ok) {
        setRead(undefined);
        setFailure(next);
        if (next.reason === 'denied') setDrafts({});
        return;
      }
      session.current = next.session ?? session.current;
      if (
        exactCandidate &&
        !next.page?.candidates.some(
          (item) =>
            item.id === exactCandidate &&
            item.retracted === null &&
            item.statement.property.id === field,
        )
      ) {
        setRead(undefined);
        setCandidate(undefined);
        setFailure({ ok: false, reason: 'unavailable' });
        return;
      }
      setRead(
        cursor && current?.page && next.page
          ? {
              ...next,
              page: {
                ...next.page,
                candidates: [
                  ...new Map(
                    [...current.page.candidates, ...next.page.candidates].map((item) => [item.id, item]),
                  ).values(),
                ],
              },
            }
          : next,
      );
      if (!cursor) setRequiresReload(false);
      if (context)
        setModes((previous) => ({
          ...previous,
          [field]:
            previous[field] ??
            next.page?.adoption?.mode ??
            (next.contextReview?.context.kind === 'community'
              ? (next.contextReview.context.defaults[field] ?? 'inherit')
              : 'replace'),
        }));
      if (field)
        setDrafts((previous) => ({
          ...previous,
          [field]: refreshCandidateDraft(
            previous[field],
            next.contextReview
              ? next.contextReview.selected.flatMap((statement) =>
                  statement.rank === 'normal' || statement.rank === 'preferred'
                    ? [{ candidate: statement.id, rank: statement.rank }]
                    : [],
                )
              : publicCandidateSelection(next.public, field, slot),
          ),
        }));
      if (exactCandidate) {
        setLifecycleCandidate(exactCandidate);
        setCandidate(next.page?.candidates.find((item) => item.id === exactCandidate && item.retracted === null));
      }
    } catch {
      if (!work.live()) return;
      setRead(undefined);
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!work.live()) return;
      setBusy(false);
      running.current = false;
    }
  }

  useEffect(() => {
    if (!work.live()) return;
    if (!target) {
      openedTarget.current = null;
      return;
    }
    if (openedTarget.current === target || running.current || request.current) return;
    // An explicit exact-target handoff requests this same bounded read. Keep its identity across
    // rerenders/StrictMode, and defer retargeting until an active read or frozen command finishes.
    openedTarget.current = target;
    setProperty(initialProperty!);
    void load(initialProperty);
  });

  useEffect(() => {
    if (!work.live()) return;
    if (confirmation) confirmationRegion.current?.focus();
    else if (restoreConfirmationFocus.current) {
      restoreConfirmationFocus.current = false;
      confirmationTrigger.current?.focus();
    }
  }, [confirmation]);

  function openConfirmation(operation: CandidateCommand['operation'], trigger: HTMLButtonElement) {
    if (!work.live() || locked || requiresReload || running.current || request.current) return;
    confirmationTrigger.current = trigger;
    setConfirmation(operation);
  }

  function cancelConfirmation() {
    if (!work.live() || running.current || request.current) return;
    restoreConfirmationFocus.current = true;
    setConfirmation(null);
  }

  async function confirm() {
    if (
      !work.live() ||
      !current?.page ||
      !confirmation ||
      running.current ||
      requiresReload ||
      (confirmation === 'adopt' ? !valid : !candidate)
    )
      return;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    request.current ??= freezeCommand({
      id,
      expectedReader: work.reader,
      property,
      // Adoption uses selection; candidate is retained for compatibility with existing scalar callers.
      candidate: candidate?.id ?? draft?.selection[0]?.candidate ?? id,
      operation: confirmation,
      head: confirmation === 'adopt' ? (current.page.adoption?.head ?? null) : candidate!.head,
      key: crypto.randomUUID(),
      ...(confirmation === 'adopt'
        ? { selection: context && mode !== 'replace' ? [] : structuredClone(draft!.selection) }
        : {}),
      ...(session.current ? { session: session.current } : {}),
      ...(slot ? { slot: structuredClone(slot) } : {}),
      ...(context ? { context, mode } : {}),
    });
    try {
      const next = await transport.confirm(request.current, work);
      if (!work.live()) return;
      if (!next.ok) {
        setFailure(next);
        // An uncertain retry keeps the exact payload, old heads and key. A conflict never retries itself.
        if (next.reason !== 'unavailable') {
          setConfirmation(null);
          request.current = null;
          setRequiresReload(true);
        }
        if (next.reason === 'denied') {
          setRead(undefined);
          setCandidate(undefined);
          setDrafts({});
        }
      } else {
        session.current = next.session ?? session.current;
        setResult(next);
        if (context && next.contextRefreshFailed) {
          setRead(undefined);
          setCandidate(undefined);
        }
        setConfirmation(null);
        request.current = null;
        setRequiresReload(true);
      }
    } catch {
      if (!work.live()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!work.live()) return;
      setBusy(false);
      running.current = false;
    }
  }

  function edit(choice: string, rank: 'normal' | 'preferred' | null) {
    if (!work.live() || locked || !draft) return;
    setDrafts((previous) => ({ ...previous, [property]: editCandidateDraft(previous[property]!, choice, rank) }));
  }

  function state(item: Candidate) {
    if (item.retracted !== null) return m.candidate_retracted({}, options);
    if (item.decision === 'rejected') return m.candidate_rejected_state({}, options);
    if (publicStatements.some((statement) => statement.id === item.id))
      return context ? m.context_selected({}, options) : m.candidate_selected({}, options);
    if (item.rank === 'normal' || item.rank === 'preferred')
      return context ? m.context_pending({}, options) : m.candidate_pending({}, options);
    return item.decision === 'accepted' ? m.candidate_unselected({}, options) : m.candidate_unresolved({}, options);
  }

  const confirmationContent = confirmation && (
    <section
      ref={confirmationRegion}
      tabIndex={-1}
      aria-labelledby={confirmationTitle}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <ContentItemHeading level={4} id={confirmationTitle} className="font-semibold">
        {m.candidate_confirm_title({ action }, options)}
      </ContentItemHeading>
      <p className="text-sm">
        {confirmation === 'accept'
          ? context
            ? m.context_confirm_accept({}, options)
            : m.candidate_confirm_accept({}, options)
          : confirmation === 'reject'
            ? m.candidate_confirm_reject({}, options)
            : context && mode !== 'replace'
              ? m.context_empty_selection({}, options)
              : context
                ? m.context_confirm_replace({}, options)
                : m.candidate_confirm_replace({}, options)}
      </p>
      {context && confirmation === 'adopt' && (
        <p>
          {mode === 'inherit'
            ? m.context_inherit({}, options)
            : mode === 'suppress'
              ? m.context_suppress({}, options)
              : m.context_replace({}, options)}
        </p>
      )}
      {confirmation === 'adopt' && (!context || mode === 'replace') && (
        <ul className="space-y-2">
          {draft?.selection.map((entry) => {
            const value = choices.get(entry.candidate);
            return (
              <li key={entry.candidate}>
                {value && (
                  <CandidateValue
                    snak={value.statement}
                    related={(current!.contextReview?.reading ?? current!.public).related}
                    locale={locale}
                    subject={id}
                    documents={documents?.candidates}
                  />
                )}
                <span className="ml-2 text-sm">
                  {entry.rank === 'preferred'
                    ? m.candidate_rank_preferred({}, options)
                    : m.candidate_rank_normal({}, options)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" disabled={busy || !!request.current} onClick={() => void confirm()}>
          {action}
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy || !!request.current}
          onClick={cancelConfirmation}
        >
          {m.candidate_cancel({}, options)}
        </Button>
      </div>
    </section>
  );

  return (
    <section
      id="candidate-review"
      aria-label={m.candidate_title({}, options)}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 [overflow-wrap:anywhere] sm:p-6 [&_button]:h-auto [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:text-start [&_select]:max-w-full max-md:[&_select]:min-h-11 pointer-coarse:[&_select]:min-h-11 pointer-coarse:[&_[role=checkbox]]:size-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:[overflow-wrap:anywhere] max-md:[&_a]:inline-flex max-md:[&_a]:min-h-11 max-md:[&_a]:min-w-11 max-md:[&_a]:items-center max-md:[&_a]:py-2 pointer-coarse:[&_a]:inline-flex pointer-coarse:[&_a]:min-h-11 pointer-coarse:[&_a]:min-w-11 pointer-coarse:[&_a]:items-center pointer-coarse:[&_a]:py-2 [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline-ring"
    >
      <div className="space-y-1">
        <ContentItemHeading level={2} className="text-xl font-semibold">
          {m.candidate_title({}, options)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">
          {context ? m.context_authority({}, options) : m.candidate_intro({}, options)}
        </p>
        {safeReturnHref && !busy && confirmation === null && !request.current && (
          <Link
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4"
            to={safeReturnHref as never}
            onClick={(event) => {
              if (!work.live() || busy || confirmation !== null || request.current) event.preventDefault();
            }}
          >
            {returnLabel ?? m.changes_return_to_changes()}
          </Link>
        )}
        {returnUnavailable && <p role="status">{m.candidate_unavailable({}, options)}</p>}
      </div>
      {!opened ? (
        <Button variant="outline" className="min-h-11" onClick={() => void load()}>
          {m.candidate_entry({}, options)}
        </Button>
      ) : (
        <>
          {busy && <p role="status">{m.candidate_loading({}, options)}</p>}
          {failure && (
            <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 p-3">
              <p>
                {failure.reason === 'stale'
                  ? m.candidate_draft_stale({}, options)
                  : failure.reason === 'denied'
                    ? m.candidate_denied({}, options)
                    : failure.reason === 'invalid'
                      ? m.candidate_invalid({}, options)
                      : m.candidate_unavailable({}, options)}
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => void (request.current ? confirm() : load())}
              >
                {request.current ? m.candidate_retry({}, options) : m.candidate_reload({}, options)}
              </Button>
            </div>
          )}
          {result && (
            <div role="status" className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
              {result.contextRefreshFailed && <p>{m.context_read_unavailable({}, options)}</p>}
              <p>
                {context && confirmation === null && result.kind !== 'accepted' && result.kind !== 'rejected'
                  ? m.context_saved({}, options)
                  : result.kind === 'selected'
                    ? m.candidate_selection_confirmed({}, options)
                    : result.kind === 'accepted'
                      ? context
                        ? m.context_accepted({}, options)
                        : m.candidate_accepted({}, options)
                      : result.kind === 'rejected'
                        ? context
                          ? m.context_rejected({}, options)
                          : m.candidate_rejected({}, options)
                        : m.candidate_pending({}, options)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {!context && result.kind === 'selected' && result.public && (
                  <a
                    className="underline underline-offset-4"
                    href={
                      subjectHref(
                        { id: result.public.subject.id, label: pageText(result.public.subject.labels, locale).text },
                        locale,
                      ).href
                    }
                  >
                    {m.candidate_view_public({}, options)}
                  </a>
                )}
                <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void load()}>
                  {m.candidate_reload({}, options)}
                </Button>
              </div>
            </div>
          )}
          {current && (
            <>
              {context && (
                <ContextComparisonView
                  read={result?.contextReview ? { ...current, contextReview: result.contextReview } : current}
                  property={property}
                  locale={locale}
                />
              )}
              <Field>
                <FieldLabel htmlFor="candidate-field">{m.candidate_field({}, options)}</FieldLabel>
                <NativeSelect
                  id="candidate-field"
                  className="min-h-11 w-full"
                  value={property}
                  disabled={locked || !!exactCandidate || !!slot}
                  onChange={(event) => {
                    if (!work.live()) return;
                    const field = event.target.value;
                    setProperty(field);
                    setLifecycleCandidate(exactCandidate && field === initialProperty ? exactCandidate : undefined);
                    void load(field);
                  }}
                >
                  <NativeSelectOption value="">{m.candidate_choose_field({}, options)}</NativeSelectOption>
                  {current.fields.map((field) => (
                    <NativeSelectOption key={field.id} value={field.id}>
                      {field.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {current.page && (!context || !result) && (
                <>
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {context ? m.context_authority({}, options) : m.candidate_compare_hint({}, options)}
                    </p>
                    {(!current.page.candidates.length ||
                      (exactCandidate && !current.page.candidates.some((item) => item.id === exactCandidate))) && (
                      <p>{exactCandidate ? m.correction_exact_missing({}, options) : m.candidate_empty({}, options)}</p>
                    )}
                    {!candidate && (
                      <ul className="space-y-3">
                        {current.page.candidates
                          .filter((item) => !exactCandidate || item.id === exactCandidate)
                          .map((item) => (
                            <li key={item.id} className="min-w-0">
                              <ContentItemFrame as="div" className="min-w-0 space-y-3 p-3 sm:p-4" data-candidate-item>
                                <CandidateValue
                                  snak={item.statement}
                                  related={(current.contextReview?.reading ?? current.public).related}
                                  locale={locale}
                                  subject={id}
                                  documents={documents?.candidates}
                                />
                                <p className="text-sm text-muted-foreground">{state(item)}</p>
                                <CandidateProvenance candidate={item} read={current} locale={locale} />
                                <Button
                                  variant="outline"
                                  className="min-h-11"
                                  disabled={locked || item.retracted !== null}
                                  onClick={() => {
                                    if (!work.live()) return;
                                    setCandidate(item);
                                    setLifecycleCandidate(item.id);
                                  }}
                                >
                                  {m.candidate_review({}, options)}
                                </Button>
                              </ContentItemFrame>
                            </li>
                          ))}
                      </ul>
                    )}
                    {current.page.next && (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={locked || requiresReload}
                        onClick={() => void load(property, current.page!.next!)}
                      >
                        {m.candidate_more({}, options)}
                      </Button>
                    )}
                  </div>
                  {candidate && (
                    <div className="space-y-4">
                      <ContentItemHeading level={3} className="font-semibold">
                        {current.fields.find((field) => field.id === property)?.label}
                      </ContentItemHeading>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <ContentItemFrame
                          as="div"
                          className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3"
                          data-candidate-panel="current"
                        >
                          <ContentItemHeading level={4} className="text-sm font-semibold">
                            {context ? m.context_selected_values({}, options) : m.candidate_current({}, options)}
                          </ContentItemHeading>
                          {!publicRead ? (
                            <p>{m.candidate_public_unconfirmed({}, options)}</p>
                          ) : publicStatements.length ? (
                            publicStatements.map((statement) => (
                              <div key={statement.id}>
                                <CandidateValue
                                  snak={statement}
                                  related={publicRead.related}
                                  locale={locale}
                                  subject={id}
                                  documents={documents?.public}
                                />
                              </div>
                            ))
                          ) : (
                            <p>{context ? m.context_no_values({}, options) : m.candidate_no_current({}, options)}</p>
                          )}
                        </ContentItemFrame>
                        <ContentItemFrame
                          as="div"
                          className="min-w-0 space-y-2 rounded-lg border border-primary/40 p-3"
                          data-candidate-panel="proposed"
                        >
                          <ContentItemHeading level={4} className="text-sm font-semibold">
                            {m.candidate_proposed({}, options)}
                          </ContentItemHeading>
                          <CandidateValue
                            snak={candidate.statement}
                            related={(current.contextReview?.reading ?? current.public).related}
                            locale={locale}
                            subject={id}
                            documents={documents?.candidates}
                          />
                          <p className="text-sm text-muted-foreground">{state(candidate)}</p>
                          {candidate.statement.qualifiers.map((snak, index) => (
                            <div key={index}>
                              <span className="text-sm text-muted-foreground">
                                {pageText(current.names[snak.property.id], locale).text ||
                                  m.subject_value_unlabelled({}, options)}
                                :{' '}
                              </span>
                              <CandidateValue
                                snak={snak}
                                related={(current.contextReview?.reading ?? current.public).related}
                                locale={locale}
                              />
                            </div>
                          ))}
                          <CandidateProvenance candidate={candidate} read={current} locale={locale} />
                        </ContentItemFrame>
                      </div>
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-2">
                          {candidate.retracted === null && candidate.decision !== 'accepted' && (
                            <Button
                              variant="outline"
                              className="min-h-11"
                              disabled={locked || requiresReload}
                              onClick={(event) => openConfirmation('accept', event.currentTarget)}
                            >
                              {m.candidate_accept({}, options)}
                            </Button>
                          )}
                          {candidate.retracted === null && candidate.decision !== 'rejected' && (
                            <Button
                              variant="outline"
                              className="min-h-11"
                              disabled={locked || requiresReload}
                              onClick={(event) => openConfirmation('reject', event.currentTarget)}
                            >
                              {m.candidate_reject({}, options)}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={locked}
                            onClick={() => work.live() && setCandidate(undefined)}
                          >
                            {m.candidate_back({}, options)}
                          </Button>
                        </div>
                        {confirmation !== 'adopt' && confirmationContent}
                      </div>
                    </div>
                  )}
                  {draft && (
                    <section
                      aria-label={context ? m.context_draft({}, options) : m.candidate_selection_draft({}, options)}
                      className="min-w-0"
                    >
                      <ContentItemFrame
                        as="div"
                        className="flex min-w-0 flex-col gap-3 p-3 sm:p-4"
                        data-candidate-draft
                      >
                        <ContentItemHeading level={3} className="font-semibold">
                          {context ? m.context_draft({}, options) : m.candidate_selection_draft({}, options)}
                        </ContentItemHeading>
                        {context && current.contextReview && (
                          <Field>
                            <FieldLabel htmlFor="context-mode">{m.context_mode({}, options)}</FieldLabel>
                            <NativeSelect
                              id="context-mode"
                              value={mode}
                              disabled={locked || requiresReload}
                              onChange={(event) =>
                                work.live() &&
                                setModes((previous) => ({ ...previous, [property]: event.target.value as typeof mode }))
                              }
                            >
                              <NativeSelectOption value="replace">{m.context_replace({}, options)}</NativeSelectOption>
                              {current.contextReview.context.kind === 'community' && (
                                <>
                                  <NativeSelectOption value="inherit">
                                    {m.context_inherit({}, options)}
                                  </NativeSelectOption>
                                  <NativeSelectOption value="suppress">
                                    {m.context_suppress({}, options)}
                                  </NativeSelectOption>
                                </>
                              )}
                            </NativeSelect>
                          </Field>
                        )}
                        <p className="text-sm text-muted-foreground">
                          {context && mode !== 'replace'
                            ? m.context_empty_selection({}, options)
                            : context
                              ? m.context_replace_hint({}, options)
                              : m.candidate_replace_hint({}, options)}
                        </p>
                        <p className="text-sm">{m.candidate_selection_limit({ limit: String(maximum) }, options)}</p>
                        {(!context || mode === 'replace') && (
                          <ul className="space-y-3">
                            {[...new Set([...choices.keys(), ...draft.selection.map((entry) => entry.candidate)])].map(
                              (choice) => {
                                const value = choices.get(choice);
                                const entry = draft.selection.find((entry) => entry.candidate === choice);
                                return (
                                  <li key={choice} className="min-w-0">
                                    <ContentItemFrame
                                      as="div"
                                      className="min-w-0 space-y-2 rounded-lg bg-muted/30 p-3"
                                      data-candidate-choice
                                    >
                                      <Field orientation="horizontal">
                                        <Checkbox
                                          id={`include-${choice}`}
                                          className="shrink-0"
                                          checked={!!entry}
                                          disabled={
                                            locked ||
                                            (!entry && (!value?.eligible || draft.selection.length >= maximum))
                                          }
                                          onCheckedChange={(checked) => edit(choice, checked ? 'normal' : null)}
                                        />
                                        <FieldLabel
                                          htmlFor={`include-${choice}`}
                                          className="min-h-11 min-w-0 flex-wrap [overflow-wrap:anywhere]"
                                        >
                                          <span>{m.candidate_include({}, options)}</span>
                                          {value ? (
                                            <CandidateValue
                                              snak={value.statement}
                                              related={(current.contextReview?.reading ?? current.public).related}
                                              locale={locale}
                                              subject={id}
                                              documents={documents?.candidates}
                                            />
                                          ) : (
                                            <span>{m.candidate_choice_unresolved({}, options)}</span>
                                          )}
                                        </FieldLabel>
                                      </Field>
                                      {entry && (
                                        <Field>
                                          <FieldLabel htmlFor={`rank-${choice}`}>
                                            {m.candidate_rank({}, options)}
                                          </FieldLabel>
                                          <NativeSelect
                                            id={`rank-${choice}`}
                                            className="min-h-11"
                                            value={entry.rank}
                                            disabled={locked || !value?.eligible}
                                            onChange={(event) =>
                                              edit(choice, event.target.value as 'normal' | 'preferred')
                                            }
                                          >
                                            <NativeSelectOption value="normal">
                                              {m.candidate_rank_normal({}, options)}
                                            </NativeSelectOption>
                                            <NativeSelectOption value="preferred">
                                              {m.candidate_rank_preferred({}, options)}
                                            </NativeSelectOption>
                                          </NativeSelect>
                                        </Field>
                                      )}
                                    </ContentItemFrame>
                                  </li>
                                );
                              },
                            )}
                          </ul>
                        )}
                        {!draft.selection.length && <p>{m.candidate_clear_selection({}, options)}</p>}
                        {!valid && <p role="status">{m.candidate_selection_invalid({}, options)}</p>}
                        <Button
                          variant="outline"
                          className="min-h-11 self-start"
                          disabled={locked || requiresReload || !valid}
                          onClick={(event) => openConfirmation('adopt', event.currentTarget)}
                        >
                          {context ? m.context_adopt({}, options) : m.candidate_adopt({}, options)}
                        </Button>
                        {confirmation === 'adopt' && confirmationContent}
                      </ContentItemFrame>
                    </section>
                  )}
                </>
              )}
              {lifecycle && property && lifecycleCandidate && (
                <ContributionLifecycle
                  address={{
                    id,
                    candidate: lifecycleCandidate,
                    property,
                    ...(session.current ? { session: session.current } : {}),
                  }}
                  locale={locale}
                  transport={{
                    change: (command) =>
                      work.live() ? lifecycle.change(command, work) : Promise.resolve({ ok: false, reason: 'denied' }),
                    read: (address) =>
                      work.live()
                        ? lifecycle.read(address, work)
                        : Promise.resolve({ subject: 'unavailable', candidate: 'unconfirmed', selected: null }),
                  }}
                  onClear={async () => {
                    if (!work.live()) return;
                    const withdrawn = lifecycleCandidate;
                    setCandidate((current) => (current?.id === withdrawn ? undefined : current));
                    setRead((current) => {
                      if (!current?.ok || !current.page) return current;
                      return {
                        ...current,
                        page: {
                          ...current.page,
                          candidates: current.page.candidates.filter((item) => item.id !== withdrawn),
                        },
                      };
                    });
                  }}
                />
              )}
            </>
          )}
          <Button
            variant="outline"
            className="min-h-11"
            disabled={locked}
            onClick={() => {
              if (!work.live()) return;
              setOpened(false);
              setRead(undefined);
              setCandidate(undefined);
              setResult(undefined);
              setFailure(undefined);
              setProperty(initialProperty ?? '');
            }}
          >
            {m.candidate_close({}, options)}
          </Button>
        </>
      )}
    </section>
  );
}

function CandidateProvenance({
  candidate,
  read,
  locale,
}: {
  candidate: Candidate;
  read: Extract<CandidateRead, { ok: true }>;
  locale: string;
}) {
  const options = { locale: locale as never };
  const source = candidate.source;
  const records = candidateSourceRecords(read.public.subject);
  const names: Record<string, string> = {
    bangumi: 'Bangumi',
    vndb: 'VNDB',
    openlibrary: 'Open Library',
    wikidata: 'Wikidata',
  };
  return (
    <div className="min-w-0 space-y-1 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
      <p>
        {m.candidate_source({}, options)}:{' '}
        {source && 'source' in source ? (names[source.source] ?? source.source) : m.candidate_editorial({}, options)}
      </p>
      {source && 'source' in source && (
        <details>
          <summary className="min-h-8 cursor-pointer rounded-sm py-1 whitespace-normal [overflow-wrap:anywhere] max-md:min-h-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.candidate_provenance({}, options)}
          </summary>
          <dl className="min-w-0 space-y-2 py-2">
            <div>
              <dt>{m.candidate_record({}, options)}</dt>
              <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="ltr">
                {source.external_id}
              </dd>
            </div>
            <div>
              <dt>{m.candidate_source_revision({}, options)}</dt>
              <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="ltr">
                {source.record_revision}
              </dd>
            </div>
            <div>
              <dt>{m.candidate_converter({}, options)}</dt>
              <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="ltr">
                {source.converter_revision}
              </dd>
            </div>
          </dl>
        </details>
      )}
      {candidate.statement.references.map((reference, index) => (
        <div key={index}>
          {reference.parts.map((snak, part) => (
            <div key={part}>
              <CandidateValue snak={snak} related={read.public.related} locale={locale} />
            </div>
          ))}
        </div>
      ))}
      {records
        .filter((record) =>
          candidate.statement.references.some((reference) =>
            reference.parts.some((snak) => snak.value.type === 'value' && snak.value.content === record.url),
          ),
        )
        .map((record, index) => (
          <div key={index}>
            {record.url && webUrl(record.url) ? (
              <a className="underline" href={record.url} rel="noreferrer">
                {record.name}
              </a>
            ) : (
              record.name
            )}
            {record.attribution && <p>{record.attribution}</p>}
            {record.licence && (
              <p>
                {m.candidate_licence({}, options)}:{' '}
                {record.licence.url && webUrl(record.licence.url) ? (
                  <a className="underline" href={record.licence.url} rel="noreferrer">
                    {record.licence.id}
                  </a>
                ) : (
                  record.licence.id
                )}
              </p>
            )}
          </div>
        ))}
    </div>
  );
}

/** Frozen uncertain attempts never pick up a later continuity token, slot or selection. */
function freezeCommand(command: CandidateCommand): CandidateCommand {
  if (command.slot) Object.freeze(command.slot);
  if (command.selection) {
    for (const entry of command.selection) Object.freeze(entry);
    Object.freeze(command.selection);
  }
  return Object.freeze(command);
}
