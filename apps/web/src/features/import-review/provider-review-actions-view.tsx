import { useRef, useState, type ReactNode } from 'react';
import type { SubjectRead } from '@rezics/client';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ContentItem, ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@rezics/ui/shadcn/alert-dialog';
import { CandidateValue, pageText } from '../pages/data';
import { pickText } from '@rezics/composition';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import {
  prepareProviderBatch,
  providerRowKey,
  providerRowIsSelectable,
  providerRowIsConcealed,
  providerScopeKey,
  providerSelectionInScope,
  providerSelectionLimit,
  runProviderBatch,
  type ProviderBatch,
  type ProviderDecision,
  type ProviderDecisionResult,
  type ProviderFailure,
  type ProviderReading,
  type ProviderDecisionRow,
  type ProviderScope,
} from './provider-review-actions';
import { providerAlwaysCurrent, useProviderVisit, type ProviderVisit } from './provider-visit';
import type { ProviderQueuePage, ProviderQueueRead } from './provider-queue';

export type ProviderReviewTransport = {
  confirm: (command: ProviderDecision) => Promise<ProviderDecisionResult>;
  refresh: (batch: ProviderBatch) => Promise<{ queue: ProviderQueueRead; readings: ProviderReading[] }>;
};

export function providerOutcomeText(result: ProviderDecisionResult, locale: string) {
  const o = { locale: locale as never };
  if (result.ok) return result.kind === 'accepted' ? m.provider_accepted({}, o) : m.provider_rejected({}, o);
  const messages: Record<ProviderFailure['reason'], () => string> = {
    stale: () => m.provider_stale({}, o),
    denied: () => m.provider_denied({}, o),
    missing: () => m.provider_missing({}, o),
    'rate-limited': () => m.provider_rate_limited({}, o),
    unavailable: () => m.provider_unavailable({}, o),
    invalid: () => m.provider_invalid({}, o),
    'key-conflict': () => m.provider_key_conflict({}, o),
  };
  return messages[result.reason]();
}

/** The queue and its sealed confirmation share the exact statement and provenance presentation. */
function ProviderStatement({
  statement,
  row,
  locale,
}: {
  statement: SubjectRead['subject']['statements'][string][number];
  row: ProviderDecisionRow;
  locale: string;
}) {
  const o = { locale: locale as never };
  const value = (snak: (typeof statement.qualifiers)[number]) => (
    <CandidateValue snak={snak} related={row.related} locale={locale} subject={row.subject} />
  );
  return (
    <div className="space-y-2">
      {value(statement)}
      {!!statement.qualifiers.length && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{m.subject_qualifiers({}, o)}</p>
          {statement.qualifiers.map((snak, index) => (
            <p key={index}>
              {pageText(row.related[snak.property.id]?.labels, locale).text || m.candidate_field({}, o)}: {value(snak)}
            </p>
          ))}
        </div>
      )}
      {!!statement.references.length && (
        <details className="text-sm">
          <summary className="cursor-pointer py-2 text-primary">{m.subject_sources({}, o)}</summary>
          <ul className="space-y-2">
            {statement.references.map((reference, index) => (
              <li key={index}>
                {reference.parts.map((snak, part) => (
                  <div key={part}>
                    {pageText(row.related[snak.property.id]?.labels, locale).text || m.candidate_field({}, o)}:{' '}
                    {value(snak)}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="break-all text-xs text-muted-foreground">
        {m.candidate_rank({}, o)}:{' '}
        {statement.rank === 'preferred'
          ? m.candidate_rank_preferred({}, o)
          : statement.rank === 'deprecated'
            ? m.changes_rank_deprecated({}, o)
            : m.candidate_rank_normal({}, o)}
        {' · '}
        {statement.id}
      </p>
    </div>
  );
}

function ProviderProposal({ row, locale }: { row: ProviderDecisionRow; locale: string }) {
  const o = { locale: locale as never };
  const source = row.candidate.source;
  return (
    <div className="space-y-2">
      <ProviderStatement statement={row.candidate.statement} row={row} locale={locale} />
      {source && 'source' in source && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt>{m.prq_source({}, o)}</dt>
          <dd>{source.source}</dd>
          <dt>{m.prq_record({}, o)}</dt>
          <dd className="break-words">{source.external_id}</dd>
          <dt>{m.prq_revision({}, o)}</dt>
          <dd className="break-words">{source.record_revision}</dd>
          <dt>{m.prq_converter({}, o)}</dt>
          <dd className="break-words">{source.converter_revision}</dd>
        </dl>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer py-2">{m.prq_identifiers({}, o)}</summary>
        <p className="break-all">
          {row.subject} · {row.candidate.id} · {row.candidate.statement.property.id}
        </p>
      </details>
    </div>
  );
}

function ProviderComparison({ row, locale }: { row: ProviderDecisionRow; locale: string }) {
  const o = { locale: locale as never };
  const reading = row.reading;
  const selected = reading?.ok
    ? (reading.current.subject.statements[row.candidate.statement.property.id] ?? []).filter(
        (statement) => statement.rank === 'normal' || statement.rank === 'preferred',
      )
    : [];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="min-w-0 space-y-2" aria-label={m.context_selected_values({}, o)}>
        <ContentItemHeading level={3} className="text-sm font-semibold">
          {m.context_selected_values({}, o)}
        </ContentItemHeading>
        {!reading?.ok ? (
          <p role="status">{m.prq_comparison_unavailable({}, o)}</p>
        ) : selected.length ? (
          <ul className="space-y-3">
            {selected.map((statement) => (
              <li key={statement.id}>
                <ProviderStatement statement={statement} row={row} locale={locale} />
              </li>
            ))}
          </ul>
        ) : (
          <p>{m.context_no_values({}, o)}</p>
        )}
      </section>
      <section className="min-w-0 space-y-2" aria-label={m.candidate_proposed({}, o)}>
        <ContentItemHeading level={3} className="text-sm font-semibold">
          {m.candidate_proposed({}, o)}
        </ContentItemHeading>
        <ProviderProposal row={row} locale={locale} />
      </section>
    </div>
  );
}

/** Selection and sealed action drafts only; the owning queue retains all query and row authority. */
export function ProviderReviewActions({
  page,
  locale,
  transport,
  onRefresh,
  concealRows = false,
  disabled = false,
  renderDetails,
  currentScope,
  current = providerAlwaysCurrent,
  onCustodyChange,
}: {
  page?: ProviderQueuePage | undefined;
  locale: string;
  transport: ProviderReviewTransport;
  onRefresh: (read: ProviderQueueRead) => void;
  concealRows?: boolean;
  disabled?: boolean;
  renderDetails?: (row: ProviderDecisionRow, locked: boolean) => ReactNode;
  currentScope?: ProviderScope;
  current?: () => boolean;
  onCustodyChange?: (held: boolean, phase?: 'confirmation' | 'writing' | 'settled') => void;
}) {
  const o = { locale: locale as never };
  const selectedScope = currentScope ?? page?.scope;
  const scope = selectedScope ? providerScopeKey(selectedScope) : '';
  const visit = useProviderVisit(current, scope);
  const enabled = useRef(!disabled);
  if (enabled.current && disabled) visit.retire();
  enabled.current = !disabled;
  const pageAddress = page?.pageAddress ?? '';
  const [selection, setSelection] = useState<{ scope: string; page: string; ids: string[] }>({
    scope,
    page: pageAddress,
    ids: [],
  });
  const [batch, setBatch] = useState<ProviderBatch>();
  const [confirmation, setConfirmation] = useState<ProviderBatch>();
  const confirmationOwner = useRef<ProviderBatch | null>(null);
  const batchOwner = useRef<ProviderBatch | null>(null);
  // Sealed presentation and transport stay with the original confirmation, just like native operands.
  const custody = useRef(
    new WeakMap<
      ProviderBatch,
      { visit: ProviderVisit; transport: ProviderReviewTransport; source: string; context: string; status: string }
    >(),
  );
  const [busy, setBusy] = useState(false);
  const [readings, setReadings] = useState<ProviderReading[]>([]);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const running = useRef(false);
  const lastScope = useRef(scope);
  if (selectedScope) lastScope.current = scope;
  // A changed source, Context or status clears checkboxes before the new scope can be acted on.
  if (selection.scope !== scope || selection.page !== pageAddress)
    setSelection({ scope, page: pageAddress, ids: [] });
  if (confirmation && providerScopeKey(confirmation.scope) !== scope) {
    confirmationOwner.current = null;
    setConfirmation(undefined);
  }
  const selected = selection.scope === scope && selection.page === pageAddress
    ? providerSelectionInScope(selection, scope)
    : [];
  const visible = page?.rows ?? [];
  function concealed(row: ProviderDecisionRow) {
    return (
      concealRows ||
      providerRowIsConcealed(row) ||
      page?.rows.some((current) => current.subject === row.subject && providerRowIsConcealed(current)) ||
      batch?.attempts.some(
        (attempt) =>
          providerRowKey(attempt.row) === providerRowKey(row) &&
          attempt.result &&
          !attempt.result.ok &&
          (attempt.result.reason === 'denied' || attempt.result.reason === 'missing'),
      ) ||
      readings.some(
        (entry) =>
          entry.subject === row.subject &&
          !entry.result.ok &&
          (entry.result.reason === 'denied' || entry.result.reason === 'missing'),
      )
    );
  }
  if (
    confirmation &&
    (!page ||
      concealRows ||
      confirmation.attempts.some(
        ({ row }) =>
          concealed(row) ||
          !visible.some((current) => providerRowKey(current) === providerRowKey(row) && !concealed(current)),
      ))
  ) {
    confirmationOwner.current = null;
    setConfirmation(undefined);
  }
  const sameScope = !batch || providerScopeKey(batch.scope) === lastScope.current;
  const attempted = batch?.attempts.some((attempt) => attempt.result);
  const uncertain = batch?.attempts.some(
    (attempt) => attempt.result && !attempt.result.ok && attempt.result.reason === 'unavailable',
  );
  const failed = batch?.attempts.some((attempt) => !attempt.result?.ok);
  const locked = disabled || busy || !!batch || !!confirmation;

  function destination(row: ProviderDecisionRow) {
    return row.href.startsWith('/') && !row.href.startsWith('//') && !row.href.includes('\\') ? row.href : undefined;
  }

  function review(operation: ProviderDecision['operation']) {
    if (!visit.live() || !enabled.current || !page || locked) return;
    const next = prepareProviderBatch(page.scope, visible, selected, operation, undefined, page.session);
    if (next) {
      custody.current.set(next, {
        visit,
        transport,
        source: page.sourceLabel,
        context: page.contextLabel,
        status: page.statusLabel,
      });
      confirmationOwner.current = next;
      onCustodyChange?.(true, 'confirmation');
      setConfirmation(next);
    }
  }

  async function refresh(current: ProviderBatch, insideExecution = false) {
    if (!visit.live() || !enabled.current || batchOwner.current !== current || (!insideExecution && running.current))
      return;
    if (!insideExecution) {
      running.current = true;
      setBusy(true);
    }
    setReadings((previous) =>
      previous.map((entry) => (entry.result.ok ? { ...entry, result: { ok: false, reason: 'unavailable' } } : entry)),
    );
    try {
      const original = custody.current.get(current);
      if (!original || original.visit !== visit || !visit.live()) return;
      const next = await original.transport.refresh(current);
      if (!visit.live()) return;
      setReadings(next.readings);
      setRefreshFailed(!next.queue.ok);
      // An older decision must not navigate the owning queue back after a scope change.
      if (providerScopeKey(current.scope) === lastScope.current) onRefresh(next.queue);
    } catch {
      if (!visit.live()) return;
      setRefreshFailed(true);
      if (providerScopeKey(current.scope) === lastScope.current) onRefresh({ ok: false, reason: 'unavailable' });
    } finally {
      if (visit.live() && !insideExecution) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  async function execute(current: ProviderBatch) {
    if (!visit.live() || !enabled.current || running.current) return;
    if (
      current.attempts.some((attempt) => attempt.result)
        ? batchOwner.current !== current
        : confirmationOwner.current !== current
    )
      return;
    const original = custody.current.get(current);
    if (!original || original.visit !== visit) return;
    confirmationOwner.current = null;
    batchOwner.current = current;
    running.current = true;
    onCustodyChange?.(true, 'writing');
    setBusy(true);
    setConfirmation(undefined);
    setSelection({ scope, page: pageAddress, ids: [] });
    setBatch(current);
    try {
      const next = await runProviderBatch(current, (command) => {
        visit.assert();
        if (!enabled.current) throw new Error('Provider write authority retired');
        return original.transport.confirm(command);
      });
      if (!visit.live()) return;
      custody.current.set(next, original);
      batchOwner.current = next;
      setBatch(next);
      await refresh(next, true);
    } finally {
      if (visit.live()) {
        setBusy(false);
        running.current = false;
        onCustodyChange?.(true, 'settled');
      }
    }
  }

  if (!visit.live()) return null;
  return (
    <div
      className="space-y-5"
      onClickCapture={(event) => {
        if (!visit.live()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {page && visible.length > 0 && !concealRows && (
        <>
          {visible.some((row) => !concealed(row)) && (
            <>
              <ContentItemFrame
                as="div"
                className="flex flex-wrap items-center gap-2 p-3"
                aria-label={m.provider_selection({}, o)}
              >
                <ContentItemHeading level={2} className="me-auto text-sm" role="status">
                  {m.provider_selected_count({ count: selected.length }, o)}
                </ContentItemHeading>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={locked || !selected.length}
                  onClick={() => review('accept')}
                >
                  {m.candidate_accept({}, o)}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={locked || !selected.length}
                  onClick={() => review('reject')}
                >
                  {m.candidate_reject({}, o)}
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={locked || !selected.length}
                  onClick={() => {
                    if (visit.live()) setSelection({ scope, page: pageAddress, ids: [] });
                  }}
                >
                  {m.provider_clear({}, o)}
                </Button>
                <p className="w-full text-sm text-muted-foreground">
                  {m.provider_visible_only({ limit: providerSelectionLimit }, o)} {m.prq_selection_help({}, o)}
                </p>
              </ContentItemFrame>
            </>
          )}
          <ul className="space-y-4">
            {visible.map((row, index) => {
              const key = providerRowKey(row);
              const checked = selected.includes(key);
              const returned =
                page?.returnCandidate?.subject === row.subject &&
                page.returnCandidate.candidate === row.candidate.id &&
                page.returnCandidate.property === row.candidate.statement.property.id;
              if (concealed(row))
                return <ContentItem key={key} title={m.provider_missing({}, o)} headingLevel={3} role="status" />;
              const href = destination(row);
              return (
                <ContentItem
                  key={key}
                  className={returned ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : undefined}
                  title={row.label}
                  {...(href ? { href } : {})}
                  context={row.propertyLabel}
                  metadata={
                    <>
                      <details className="w-full min-w-0 text-sm">
                        <summary className="cursor-pointer py-2 text-primary">
                          {m.context_selected_values({}, o)} · {m.candidate_proposed({}, o)}
                        </summary>
                        <ProviderComparison row={row} locale={locale} />
                      </details>
                      {renderDetails?.(row, locked || selected.length > 0)}
                    </>
                  }
                  actions={
                    <Field className="w-auto shrink-0">
                      <FieldLabel className="min-h-11 min-w-11 justify-center">
                        <Checkbox
                          checked={checked}
                          disabled={
                            locked ||
                            !row.reading?.ok ||
                            !providerRowIsSelectable(row, page.scope) ||
                            (!checked && selected.length >= providerSelectionLimit)
                          }
                          onCheckedChange={(value) => {
                            if (!visit.live() || !enabled.current || locked) return;
                            setSelection((previous) => {
                              const ids = providerSelectionInScope(previous, scope);
                              if (value && !ids.includes(key) && ids.length >= providerSelectionLimit) return previous;
                              return {
                                scope,
                                page: pageAddress,
                                ids: value ? [...new Set([...ids, key])] : ids.filter((id) => id !== key),
                              };
                            });
                          }}
                        />
                        <span className="sr-only">
                          {m.provider_select_row({ number: index + 1, label: row.label }, o)}
                        </span>
                      </FieldLabel>
                    </Field>
                  }
                />
              );
            })}
          </ul>
        </>
      )}
      <AlertDialog
        open={!!confirmation && providerScopeKey(confirmation.scope) === scope}
        onOpenChange={(open) => {
          if (visit.live() && !open) {
            confirmationOwner.current = null;
            setConfirmation(undefined);
            if (!batch) onCustodyChange?.(false);
          }
        }}
      >
        <AlertDialogContent
          initialFocus={() => (visit.live() ? true : false)}
          finalFocus={() => (visit.live() ? true : false)}
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
        >
          <AlertDialogHeader>
            <AlertDialogTitle render={<ContentItemHeading level={2} />} className="text-lg font-medium">
              {m.provider_confirm_title({}, o)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.provider_confirm_description({ count: confirmation?.attempts.length ?? 0 }, o)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm">
            {confirmation && custody.current.get(confirmation)?.source} ·{' '}
            {confirmation && custody.current.get(confirmation)?.context} ·{' '}
            {confirmation && custody.current.get(confirmation)?.status}
          </p>
          <ul className="space-y-4">
            {confirmation?.attempts.map(({ row, command }) => (
              <li key={command.key}>
                <ContentItemFrame as="article" className="space-y-2 p-3">
                  <ContentItemHeading level={3}>{row.label}</ContentItemHeading>
                  <p className="text-sm text-muted-foreground">{row.propertyLabel}</p>
                  <ContentItemHeading level={4} className="text-sm font-medium">
                    {m.candidate_proposed({}, o)}
                  </ContentItemHeading>
                  <ProviderProposal row={row} locale={locale} />
                </ContentItemFrame>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => {
                if (visit.live()) {
                  confirmationOwner.current = null;
                  setConfirmation(undefined);
                  if (!batch) onCustodyChange?.(false);
                }
              }}
            >
              {m.provider_cancel({}, o)}
            </Button>
            <Button
              className="min-h-11"
              disabled={disabled || busy || !confirmation || providerScopeKey(confirmation.scope) !== scope}
              onClick={() => {
                if (visit.live() && confirmation) void execute(confirmation);
              }}
            >
              {confirmation?.attempts[0]?.command.operation === 'reject'
                ? m.provider_confirm_reject({}, o)
                : m.provider_confirm_accept({}, o)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {batch && (
        <ContentItemFrame as="div" className="space-y-3 p-4" aria-label={m.provider_results({}, o)} aria-busy={busy}>
          <ContentItemHeading level={2} className="text-lg font-semibold">
            {m.provider_results({}, o)}
          </ContentItemHeading>
          <p className="text-sm">
            {custody.current.get(batch)?.source} · {custody.current.get(batch)?.context} ·{' '}
            {custody.current.get(batch)?.status}
          </p>
          {!sameScope && <p>{m.provider_scope_changed({}, o)}</p>}
          {busy && <p role="status">{m.provider_working({}, o)}</p>}
          <ul className="space-y-3" aria-live="polite">
            {batch.attempts.map((attempt) => {
              const reading = readings.find((entry) => entry.subject === attempt.row.subject)?.result;
              const rowConcealed =
                concealed(attempt.row) ||
                (attempt.result &&
                  !attempt.result.ok &&
                  (attempt.result.reason === 'denied' || attempt.result.reason === 'missing')) ||
                (reading && !reading.ok && (reading.reason === 'denied' || reading.reason === 'missing'));
              const missingOutcome = attempt.result && !attempt.result.ok && attempt.result.reason === 'missing';
              return (
                <li key={attempt.command.key}>
                  <ContentItemFrame as="article" className="space-y-2 p-3">
                    <ContentItemHeading level={3} role={rowConcealed && missingOutcome ? 'status' : undefined}>
                      {rowConcealed ? m.provider_missing({}, o) : attempt.row.label}
                    </ContentItemHeading>
                    {!rowConcealed && (
                      <>
                        <p className="text-sm text-muted-foreground">{attempt.row.propertyLabel}</p>
                        <ProviderProposal row={attempt.row} locale={locale} />
                      </>
                    )}
                    {!(rowConcealed && missingOutcome) && (
                      <p>{attempt.result ? providerOutcomeText(attempt.result, locale) : m.provider_working({}, o)}</p>
                    )}
                    {!rowConcealed &&
                      reading &&
                      (reading.ok ? (
                        <a
                          className="underline underline-offset-4"
                          href={
                            subjectHref(
                              {
                                id: reading.current.subject.id,
                                label: pickText(reading.current.subject.labels, locale).text,
                              },
                              locale,
                            ).href
                          }
                        >
                          {m.provider_current_reading({}, o)}
                        </a>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {m.provider_reading_failed({}, o)} {providerOutcomeText(reading, locale)}
                        </p>
                      ))}
                  </ContentItemFrame>
                </li>
              );
            })}
          </ul>
          {refreshFailed && <p role="alert">{m.provider_refresh_failed({}, o)}</p>}
          <div className="flex flex-wrap gap-2">
            {attempted && failed && (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={disabled || busy || !sameScope}
                onClick={() => void execute(batch)}
              >
                {m.provider_retry_failed({}, o)}
              </Button>
            )}
            {attempted && (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={disabled || busy || !sameScope}
                onClick={() => void refresh(batch)}
              >
                {m.provider_refresh({}, o)}
              </Button>
            )}
            {attempted && !uncertain && (
              <Button
                variant="ghost"
                className="min-h-11"
                disabled={busy}
                onClick={() => {
                  if (!visit.live()) return;
                  batchOwner.current = null;
                  onCustodyChange?.(false);
                  setBatch(undefined);
                  setReadings([]);
                }}
              >
                {m.provider_finish({}, o)}
              </Button>
            )}
          </div>
        </ContentItemFrame>
      )}
    </div>
  );
}
