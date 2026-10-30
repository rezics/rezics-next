import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ListRow, ListRowLink, ListRowControl } from '@rezics/ui/list-row';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@rezics/ui/shadcn/alert-dialog';
import { CandidateValue } from '../pages/data';
import { pickText } from '@rezics/composition';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import {
  prepareProviderBatch,
  providerRowKey,
  providerRowIsSelectable,
  providerScopeKey,
  providerSelectionInScope,
  providerSelectionLimit,
  runProviderBatch,
  type ProviderBatch,
  type ProviderDecision,
  type ProviderDecisionResult,
  type ProviderFailure,
  type ProviderReading,
} from './provider-review-actions';
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

/** Selection and sealed action drafts only; the owning queue retains all query and row authority. */
export function ProviderReviewActions({
  page,
  locale,
  transport,
  onRefresh,
  concealRows = false,
}: {
  page?: ProviderQueuePage | undefined;
  locale: string;
  transport: ProviderReviewTransport;
  onRefresh: (read: ProviderQueueRead) => void;
  concealRows?: boolean;
}) {
  const o = { locale: locale as never };
  const scope = page ? providerScopeKey(page.scope) : '';
  const [selection, setSelection] = useState<{ scope: string; ids: string[] }>({ scope, ids: [] });
  const [batch, setBatch] = useState<ProviderBatch>();
  const [confirmation, setConfirmation] = useState<ProviderBatch>();
  const [busy, setBusy] = useState(false);
  const [readings, setReadings] = useState<ProviderReading[]>([]);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const running = useRef(false);
  const lastScope = useRef(scope);
  if (page) lastScope.current = scope;
  // A changed source, Context or status clears checkboxes before the new scope can be acted on.
  if (selection.scope !== scope) setSelection({ scope, ids: [] });
  if (confirmation && providerScopeKey(confirmation.scope) !== scope) setConfirmation(undefined);
  const selected = providerSelectionInScope(selection, scope);
  const visible = page?.rows ?? [];
  const sameScope = !batch || providerScopeKey(batch.scope) === lastScope.current;
  const attempted = batch?.attempts.some((attempt) => attempt.result);
  const uncertain = batch?.attempts.some(
    (attempt) => attempt.result && !attempt.result.ok && attempt.result.reason === 'unavailable',
  );
  const failed = batch?.attempts.some((attempt) => !attempt.result?.ok);
  const locked = busy || !!batch || !!confirmation;

  function review(operation: ProviderDecision['operation']) {
    if (!page || locked) return;
    const next = prepareProviderBatch(page.scope, visible, selected, operation, undefined, page.session);
    if (next) setConfirmation(next);
  }

  async function refresh(current: ProviderBatch) {
    try {
      const next = await transport.refresh(current);
      setReadings(next.readings);
      setRefreshFailed(!next.queue.ok);
      // An older decision must not navigate the owning queue back after a scope change.
      if (providerScopeKey(current.scope) === lastScope.current) onRefresh(next.queue);
    } catch {
      setRefreshFailed(true);
      if (providerScopeKey(current.scope) === lastScope.current) onRefresh({ ok: false, reason: 'unavailable' });
    }
  }

  async function execute(current: ProviderBatch) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setConfirmation(undefined);
    setSelection({ scope, ids: [] });
    setBatch(current);
    try {
      const next = await runProviderBatch(current, transport.confirm);
      setBatch(next);
      await refresh(next);
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  return (
    <div className="space-y-5">
      {page && (
        <>
          <div
            className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3"
            aria-label={m.provider_selection({}, o)}
          >
            <p className="me-auto text-sm" role="status">
              {m.provider_selected_count({ count: selected.length }, o)}
            </p>
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
              onClick={() => setSelection({ scope, ids: [] })}
            >
              {m.provider_clear({}, o)}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {m.provider_visible_only({ limit: providerSelectionLimit }, o)}
          </p>
          <ul className="space-y-4">
            {visible.map((row, index) => {
              const key = providerRowKey(row);
              const checked = selected.includes(key);
              return (
                <ListRow key={key} className="flex min-w-0 gap-3 p-2">
                  <ListRowLink href={row.href}>{row.label}</ListRowLink>
                  <ListRowControl>
                    <Field className="w-auto shrink-0">
                      <FieldLabel className="min-h-11 min-w-11 justify-center">
                        <Checkbox
                          checked={checked}
                          disabled={
                            locked ||
                            !providerRowIsSelectable(row, page.scope) ||
                            (!checked && selected.length >= providerSelectionLimit)
                          }
                          onCheckedChange={(value) =>
                            setSelection({
                              scope,
                              ids: value ? [...new Set([...selected, key])] : selected.filter((id) => id !== key),
                            })
                          }
                        />
                        <span className="sr-only">
                          {m.provider_select_row({ number: index + 1, label: row.label }, o)}
                        </span>
                      </FieldLabel>
                    </Field>
                  </ListRowControl>
                  <div className="min-w-0 space-y-1 break-words">
                    <p className="font-semibold">{row.label}</p>
                    <p className="text-sm text-muted-foreground">{row.propertyLabel}</p>
                    <ListRowControl>
                      <CandidateValue snak={row.candidate.statement} related={row.related} locale={locale} />
                    </ListRowControl>
                  </div>
                </ListRow>
              );
            })}
          </ul>
        </>
      )}
      <AlertDialog
        open={!!confirmation && providerScopeKey(confirmation.scope) === scope}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.provider_confirm_title({}, o)}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.provider_confirm_description({ count: confirmation?.attempts.length ?? 0 }, o)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm">
            {page?.sourceLabel} · {page?.contextLabel} · {page?.statusLabel}
          </p>
          <AlertDialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setConfirmation(undefined)}>
              {m.provider_cancel({}, o)}
            </Button>
            <Button
              className="min-h-11"
              disabled={busy || !confirmation || providerScopeKey(confirmation.scope) !== scope}
              onClick={() => {
                if (confirmation) void execute(confirmation);
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
        <section
          className="space-y-3 rounded-xl border border-border bg-card p-4"
          aria-label={m.provider_results({}, o)}
          aria-busy={busy}
        >
          <h2 className="text-lg font-semibold">{m.provider_results({}, o)}</h2>
          {!sameScope && <p>{m.provider_scope_changed({}, o)}</p>}
          {busy && <p role="status">{m.provider_working({}, o)}</p>}
          <ul className="space-y-3" aria-live="polite">
            {batch.attempts.map((attempt) => {
              const reading = readings.find((entry) => entry.subject === attempt.row.subject)?.result;
              const concealed =
                concealRows ||
                (attempt.result &&
                  !attempt.result.ok &&
                  (attempt.result.reason === 'denied' || attempt.result.reason === 'missing')) ||
                (reading && !reading.ok && (reading.reason === 'denied' || reading.reason === 'missing'));
              return (
                <li key={attempt.command.key} className="space-y-1 break-words">
                  {!concealed && (
                    <>
                      <p className="font-medium">
                        {attempt.row.label} · {attempt.row.propertyLabel}
                      </p>
                      <CandidateValue
                        snak={attempt.row.candidate.statement}
                        related={attempt.row.related}
                        locale={locale}
                      />
                    </>
                  )}
                  <p>{attempt.result ? providerOutcomeText(attempt.result, locale) : m.provider_working({}, o)}</p>
                  {!concealed &&
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
                disabled={busy || !sameScope}
                onClick={() => void execute(batch)}
              >
                {m.provider_retry_failed({}, o)}
              </Button>
            )}
            {attempted && (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy || !sameScope}
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
                  setBatch(undefined);
                  setReadings([]);
                }}
              >
                {m.provider_finish({}, o)}
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
