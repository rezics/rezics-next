import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ProviderQueueRead } from './provider-queue';
import {
  ProviderReviewActions,
  providerOutcomeText,
  type ProviderReviewTransport,
} from './provider-review-actions-view';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Field, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { pageText } from '../pages/data';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { subjectHref } from '../../subject/subject-href';
import {
  globalReviewContext,
  firstProviderQueuePage,
  nextProviderQueuePage,
  previousProviderQueuePage,
  providerQueueCursor,
  providerQueueHistoryLimit,
  validQueueScope,
  type QueuePageHistory,
  type QueueScope,
  type QueueState,
  type QueueTransport,
  type ProviderQueueReturnVisit,
} from './provider-queue';
import { ProviderContextChoiceField } from './provider-context-choice-view';
import {
  providerSourceLabel,
  unavailableProviderContexts,
  type ProviderContextChoice,
  type ProviderContextSource,
} from './provider-context-choice';
import { providerAlwaysCurrent, useProviderVisit, type ProviderVisit } from './provider-visit';

type QueueLoad = {
  visitId: string;
  id: string;
  scope: QueueScope;
  choice: ProviderContextChoice;
  initial: QueueState;
  initialReturn?: ProviderQueueReturnVisit;
};

/** Private event-owned reads retain the original no-private-SSR contract. */
export function ProviderQueue({
  transport,
  contexts = unavailableProviderContexts,
  initial = { state: 'idle' },
  initialScope,
  initialChoice,
  initialReturn,
  onReviewCandidate,
  canWrite = true,
  current = providerAlwaysCurrent,
}: {
  transport: QueueTransport;
  contexts?: ProviderContextSource;
  initial?: QueueState;
  initialScope?: QueueScope;
  initialChoice?: ProviderContextChoice;
  initialReturn?: ProviderQueueReturnVisit | undefined;
  onReviewCandidate?: (visit: Omit<ProviderQueueReturnVisit, 'id'>) => boolean | void;
  canWrite?: boolean;
  current?: () => boolean;
}) {
  const id = useId();
  const locale = getLocale();
  const identity = useMemo(
    () => ({}),
    [transport, contexts, canWrite, initialScope?.source, initialScope?.context, initialScope?.status],
  );
  const visit = useProviderVisit(current, identity);
  const startingScope = initialScope ?? initialReturn?.scope;
  const startingChoice =
    initialChoice ??
    (startingScope?.context === globalReviewContext
      ? { id: globalReviewContext, label: m.prq_global() }
      : initialReturn
        ? { id: initialReturn.scope.context, label: initialReturn.contextLabel }
        : null);
  const [source, setSource] = useState(startingScope?.source ?? '');
  const [choice, setChoice] = useState<ProviderContextChoice | null>(startingChoice);
  const [status, setStatus] = useState<QueueScope['status']>(startingScope?.status ?? 'pending');
  const [invalidSource, setInvalidSource] = useState(false);
  const [choiceDenied, setChoiceDenied] = useState(false);
  const [actionHeld, setActionHeld] = useState(false);
  const formVersion = useRef(0);
  const choiceVersion = useRef(0);
  const [choiceEpoch, setChoiceEpoch] = useState(0);
  const renderedForm = formVersion.current;
  const renderedChoice = choiceVersion.current;
  const chooserCurrent = useMemo(() => {
    const generation = formVersion.current;
    return () => visit.live() && generation === formVersion.current;
  }, [visit, choiceEpoch]);
  function replaceForm() {
    formVersion.current++;
    setChoiceEpoch((value) => value + 1);
  }
  const [load, setLoad] = useState<QueueLoad | null>(() =>
    startingScope && startingChoice
      ? {
          visitId: visit.id,
          id: crypto.randomUUID(),
          scope: startingScope,
          choice: startingChoice,
          initial: initialReturn ? { state: 'loading' } : initial,
          ...(initialReturn ? { initialReturn } : {}),
        }
      : null,
  );
  const active = useRef(load?.id);
  const owned = useRef(visit);
  if (owned.current !== visit) {
    owned.current = visit;
    active.current = undefined;
    setLoad(null);
    setChoice(null);
  }
  const replace = (next: QueueLoad | null) => {
    active.current = next?.id;
    setLoad(next);
  };
  const invalidate = () => {
    if (visit.live()) replace(null);
  };
  const loadedCurrent = useMemo(() => () => visit.live() && active.current === load?.id, [visit, load?.id]);
  return (
    <section className="mx-auto w-full max-w-4xl flex flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-balance">{m.prq_title()}</h1>
      <p className="max-w-prose text-muted-foreground">{m.prq_help()}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !visit.live() ||
            renderedForm !== formVersion.current ||
            renderedChoice !== choiceVersion.current ||
            active.current !== load?.id ||
            actionHeld
          )
            return;
          const scope = { source: source.trim(), context: choice?.id ?? '', status };
          if (!validQueueScope(scope)) {
            setInvalidSource(!/^[a-z][a-z0-9_-]{0,31}$/.test(source.trim()));
            return;
          }
          if (!choice) return;
          setInvalidSource(false);
          replace({
            visitId: visit.id,
            id: crypto.randomUUID(),
            scope,
            choice: { ...choice },
            initial: { state: 'loading' },
          });
        }}
      >
        <fieldset disabled={actionHeld} className="min-w-0">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={invalidSource}>
            <FieldLabel htmlFor={`${id}-source`}>{m.prq_source()}</FieldLabel>
            <Input
              id={`${id}-source`}
              value={source}
              list={`${id}-providers`}
              maxLength={32}
              required
              autoComplete="off"
              aria-invalid={invalidSource}
              aria-describedby={`${id}-source-help`}
              onChange={(event) => {
                if (!visit.live() || renderedForm !== formVersion.current) return;
                replaceForm();
                invalidate();
                setSource(event.target.value);
                setInvalidSource(false);
              }}
            />
            <datalist id={`${id}-providers`}>
              {['bangumi', 'vndb', 'open-library', 'wikidata'].map((key) => (
                <option key={key} value={key}>
                  {providerSourceLabel(key)}
                </option>
              ))}
            </datalist>
            <p
              id={`${id}-source-help`}
              role={invalidSource ? 'alert' : undefined}
              className="text-sm text-muted-foreground"
            >
              {invalidSource ? m.provider_scope_source_invalid() : m.provider_scope_source_help()}
            </p>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-status`}>{m.prq_status()}</FieldLabel>
            <NativeSelect
              id={`${id}-status`}
              value={status}
              onChange={(event) => {
                if (!visit.live() || renderedForm !== formVersion.current) return;
                replaceForm();
                invalidate();
                setStatus(event.target.value as QueueScope['status']);
              }}
            >
              <NativeSelectOption value="pending">{m.prq_pending()}</NativeSelectOption>
              <NativeSelectOption value="accepted_unselected">{m.prq_accepted()}</NativeSelectOption>
            </NativeSelect>
          </Field>
          <ProviderContextChoiceField
            key={`${visit.id}:${choiceEpoch}`}
            source={contexts}
            value={choice}
            locale={locale}
            current={chooserCurrent}
            onChange={(next) => {
              if (!chooserCurrent()) return;
              choiceVersion.current++;
              invalidate();
              setChoice(next);
              setChoiceDenied(false);
            }}
          />
          <div>
            <Button type="submit" className="min-h-11" disabled={!choice}>
              {m.prq_load()}
            </Button>
          </div>
        </FieldGroup>
        </fieldset>
      </form>
      {load && load.visitId === visit.id && visit.live() ? (
        <ProviderQueueResults
          key={`${load.id}:${visit.id}`}
          transport={transport}
          contexts={contexts}
          scope={load.scope}
          choice={load.choice}
          initial={load.initial}
          initialReturn={load.initialReturn}
          current={loadedCurrent}
          canWrite={canWrite}
          locale={locale}
          onReviewCandidate={onReviewCandidate}
          actionHeld={actionHeld}
          onActionHeldChange={setActionHeld}
          onChoiceRefused={() => {
            if (visit.live()) {
              replace(null);
              setChoice(null);
              setChoiceDenied(true);
            }
          }}
        />
      ) : (
        <p role="status">{choiceDenied ? m.provider_scope_denied() : m.prq_start()}</p>
      )}
    </section>
  );
}

function ProviderQueueResults({
  transport,
  contexts,
  scope,
  choice: originalChoice,
  initial,
  initialReturn,
  current,
  canWrite,
  locale,
  onReviewCandidate,
  actionHeld,
  onActionHeldChange,
  onChoiceRefused,
}: {
  transport: QueueTransport;
  contexts: ProviderContextSource;
  scope: QueueScope;
  choice: ProviderContextChoice;
  initial: QueueState;
  initialReturn?: ProviderQueueReturnVisit | undefined;
  current: () => boolean;
  canWrite: boolean;
  locale: string;
  onReviewCandidate?: (visit: Omit<ProviderQueueReturnVisit, 'id'>) => boolean | void;
  actionHeld: boolean;
  onActionHeldChange: (held: boolean) => void;
  onChoiceRefused: () => void;
}) {
  const visit = useProviderVisit(current, transport);
  const [page, setPage] = useState(initial);
  const [choice, setChoice] = useState(originalChoice);
  const [history, setHistory] = useState<QueuePageHistory>(initialReturn?.history ?? firstProviderQueuePage());
  const historyRef = useRef(history);
  const [returnCandidate, setReturnCandidate] = useState(initialReturn?.candidate);
  const [busy, setBusy] = useState(false);
  const refreshed = useRef(new WeakMap<ProviderQueueRead, QueueState>());
  const running = useRef(false);
  const requests = useRef(0);
  const requestAtRender = requests.current;
  const [actionEpoch, setActionEpoch] = useState(0);
  const actionOwned = useRef(false);
  const custodyBusy = useRef(false);
  const [custodyLocked, setCustodyLocked] = useState(false);
  const rowsLive = useRef(true);
  const actionCurrent = useMemo(() => () => visit.live() && rowsLive.current, [visit, actionEpoch]);
  const session = useRef(initialReturn?.session ?? (initial.state === 'ready' ? initial.session : undefined));
  const started = useRef<ProviderVisit | null>(null);
  const lastVisit = useRef(visit);
  if (lastVisit.current !== visit) {
    lastVisit.current = visit;
    running.current = false;
    rowsLive.current = true;
  }
  useEffect(() => {
    if (initial.state === 'loading' && started.current !== visit && visit.live()) {
      started.current = visit;
      queueMicrotask(() => {
        if (visit.live()) void read();
      });
    }
  }, [visit]);
  async function resolved(): Promise<boolean> {
    if (!visit.live()) return false;
    if (contexts === unavailableProviderContexts) return true; // Typed standalone recording seam only.
    const result = await contexts.resolve(scope.context);
    if (!visit.live()) return false;
    if ('kind' in result || result.context.id !== scope.context || result.context.state !== 'active') {
      if ('kind' in result && result.kind === 'unavailable') setPage({ state: 'unavailable' });
      else onChoiceRefused();
      return false;
    }
    const label = pageText(result.context.labels, locale).text;
    setChoice({
      id: scope.context,
      label: scope.context === globalReviewContext ? m.prq_global() : label || m.provider_scope_unnamed(),
    });
    return true;
  }
  function rememberHistory(next: QueuePageHistory) {
    historyRef.current = next;
    setHistory(next);
  }
  async function read(
    cursor: string | undefined = providerQueueCursor(historyRef.current),
    targetHistory = historyRef.current,
  ) {
    if (!visit.live() || running.current || custodyBusy.current || requestAtRender !== requests.current) return;
    if (cursor !== undefined && cursor.length > 4096) {
      setPage({ state: 'invalid' });
      return;
    }
    requests.current++;
    rememberHistory(targetHistory);
    if (!actionOwned.current) rowsLive.current = false;
    running.current = true;
    setBusy(true);
    setPage({ state: 'loading' });
    try {
      if (!(await resolved()) || !visit.live()) return;
      const result = await transport.read(scope, cursor, session.current);
      if (!visit.live()) return;
      rowsLive.current = true;
      if (!actionOwned.current) setActionEpoch((value) => value + 1);
      setPage(result);
      if (result.state === 'ready') session.current = result.session;
    } catch {
      if (visit.live()) setPage({ state: 'unavailable' });
    } finally {
      if (visit.live()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function prepare() {
    if (!visit.live() || running.current || custodyBusy.current || !canWrite || requestAtRender !== requests.current)
      return;
    requests.current++;
    if (!actionOwned.current) rowsLive.current = false;
    running.current = true;
    setBusy(true);
    try {
      if (!(await resolved()) || !visit.live()) return;
      const next = await transport.prepare(scope);
      if (visit.live()) {
        rowsLive.current = true;
        if (!actionOwned.current) setActionEpoch((value) => value + 1);
        setPage(next);
      }
    } catch {
      if (visit.live()) setPage({ state: 'unavailable' });
    } finally {
      if (visit.live()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  function prepared(state: QueueState): ProviderQueueRead {
    if (state.state !== 'ready')
      return {
        ok: false,
        reason:
          state.state === 'denied' || state.state === 'missing'
            ? state.state
            : state.state === 'invalid'
              ? 'invalid'
              : 'unavailable',
      };
    const related = Object.fromEntries(Object.entries(state.names).map(([key, labels]) => [key, { labels }]));
    return {
      ok: true,
      page: {
        scope,
        sourceLabel: providerSourceLabel(scope.source),
        contextLabel: choice.label,
        statusLabel: scope.status === 'pending' ? m.prq_pending() : m.prq_accepted(),
        pageAddress: providerQueueCursor(historyRef.current) ?? '',
        ...(returnCandidate ? { returnCandidate } : {}),
        rows: state.page.candidates.map(({ subject, candidate }) => {
          const reading = state.readings?.find((entry) => entry.subject === subject)?.result ?? {
            ok: false as const,
            reason: 'unavailable' as const,
          };
          const current = reading.ok ? reading.current : undefined;
          const label = pageText(current?.subject.labels, locale).text || m.prq_subject();
          return {
            subject,
            candidate,
            label,
            href: subjectHref({ id: subject, label }, locale).href,
            propertyLabel:
              pageText(
                current?.related[candidate.statement.property.id]?.labels ??
                  state.names[candidate.statement.property.id],
                locale,
              ).text || m.candidate_field(),
            related: { ...related, ...current?.related },
            reading,
          };
        }),
        ...(state.session ? { session: state.session } : {}),
      },
    };
  }
  const reviewTransport = useMemo<ProviderReviewTransport>(
    () => ({
      confirm: async (command) => {
        visit.assert();
        const result = await transport.decide({ ...scope, ...command });
        visit.assert();
        return result.ok ? { ...result, kind: command.operation === 'accept' ? 'accepted' : 'rejected' } : result;
      },
      refresh: async (batch) => {
        visit.assert();
        const commands = batch.attempts.map(({ command, result }) => ({
          ...command,
          ...(result?.ok && result.session ? { session: result.session } : {}),
        }));
        // Read unknown decisions with their immutable original Context/Subject/session before refreshing labels.
        const readings = await transport.readings(commands);
        visit.assert();
        const observed = commands.findLast((command) => command.session)?.session;
        let next: QueueState;
        try {
          next = await transport.read(
            { ...batch.scope, status: batch.scope.status as QueueScope['status'] },
            providerQueueCursor(historyRef.current),
            observed,
          );
        } catch {
          next = { state: 'unavailable' };
        }
        visit.assert();
        const queue = prepared(next);
        refreshed.current.set(queue, next);
        return { queue, readings };
      },
    }),
    [visit, transport],
  );
  const presentation = prepared(page);
  const messages = {
    idle: m.prq_start,
    loading: m.prq_loading,
    preparing: m.prq_preparing,
    denied: m.prq_denied,
    missing: m.prq_unavailable,
    invalid: m.prq_invalid,
    unavailable: m.prq_unavailable,
  };
  const returnFound =
    page.state === 'ready' &&
    !!returnCandidate &&
    page.page.candidates.some(
      ({ subject, candidate }) =>
        subject === returnCandidate.subject &&
        candidate.id === returnCandidate.candidate &&
        candidate.statement.property.id === returnCandidate.property,
    );
  const startOver = () => {
    if (!visit.live()) return;
    setReturnCandidate(undefined);
    void read(undefined, firstProviderQueuePage());
  };
  const nextPage = () => {
    if (!visit.live() || page.state !== 'ready' || !page.page.next) return;
    const next = nextProviderQueuePage(historyRef.current, page.page.next);
    if (next !== historyRef.current) void read(page.page.next, next);
  };
  const previousPage = () => {
    if (!visit.live()) return;
    const previous = previousProviderQueuePage(historyRef.current);
    if (previous !== historyRef.current) void read(providerQueueCursor(previous), previous);
  };
  if (!visit.live()) return null;
  return (
    <div className="flex flex-col gap-5" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">
        {providerSourceLabel(scope.source)} · {choice.label} ·{' '}
        {scope.status === 'pending' ? m.prq_pending() : m.prq_accepted()}
      </p>
      {page.state !== 'ready' ? (
        <ContentItemFrame as="div" className="flex flex-col gap-3 p-5" aria-busy={busy}>
          <ContentItemHeading
            level={2}
            role={page.state === 'invalid' || page.state === 'unavailable' ? 'alert' : 'status'}
          >
            {messages[page.state]()}
          </ContentItemHeading>
          {page.state === 'invalid' && returnCandidate && (
            <p role="status">{m.prq_return_unavailable()}</p>
          )}
          {page.state === 'unavailable' && (
            <Button type="button" disabled={busy || custodyLocked || actionHeld || !canWrite} onClick={() => void prepare()}>
              {m.prq_prepare()}
            </Button>
          )}
          {page.state !== 'loading' && page.state !== 'idle' && page.state !== 'denied' && page.state !== 'missing' && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || custodyLocked || actionHeld}
              onClick={() =>
                page.state === 'preparing' && page.next
                  ? void read(page.next, nextProviderQueuePage(historyRef.current, page.next))
                  : void read()
              }
            >
              {page.state === 'preparing' && page.next ? m.prq_continue() : m.prq_retry()}
            </Button>
          )}
          {page.state === 'invalid' && (
            <Button type="button" variant="outline" disabled={busy || custodyLocked || actionHeld} onClick={startOver}>
              {m.prq_start_over()}
            </Button>
          )}
          {history.index > 0 && (
            <Button type="button" variant="outline" disabled={busy || custodyLocked || actionHeld} onClick={previousPage}>
              {m.prq_previous()}
            </Button>
          )}
          {page.state === 'idle' && (
            <Button type="button" variant="outline" disabled={busy || custodyLocked || actionHeld} onClick={() => void read()}>
              {m.prq_refresh()}
            </Button>
          )}
        </ContentItemFrame>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy || custodyLocked || actionHeld} onClick={() => void read()}>
              {m.prq_retry_page()}
            </Button>
            <Button type="button" variant="outline" disabled={busy || custodyLocked || actionHeld} onClick={startOver}>
              {m.prq_start_over()}
            </Button>
            {history.index > 0 && (
              <Button type="button" variant="outline" disabled={busy || custodyLocked || actionHeld} onClick={previousPage}>
                {m.prq_previous()}
              </Button>
            )}
            {page.page.next && (
              <Button type="button" variant="outline" disabled={busy || custodyLocked || actionHeld} onClick={nextPage}>
                {m.prq_next()}
              </Button>
            )}
          </div>
          {history.truncated && <p role="status">{m.prq_history_truncated()}</p>}
          {returnCandidate && <p role="status">{returnFound ? m.prq_return_found() : m.prq_return_moved()}</p>}
          {!page.page.freshness.caught_up && <p role="status">{m.prq_lagging()}</p>}
          {!page.page.candidates.length && (
            <ContentItemFrame as="div" className="p-5">
              <ContentItemHeading level={2} role="status">
                {m.prq_empty()}
              </ContentItemHeading>
            </ContentItemFrame>
          )}
        </>
      )}
      <ProviderReviewActions
        key={actionEpoch}
        page={presentation.ok ? presentation.page : undefined}
        currentScope={scope}
        renderDetails={(row, locked) => {
          if (!row.href.startsWith('/') || row.href.startsWith('//') || row.href.includes('\\')) return null;
          const address = {
            subject: row.subject,
            property: row.candidate.statement.property.id,
            candidate: row.candidate.id,
          };
          const query = new URLSearchParams({
            reviewProperty: address.property,
            candidate: address.candidate,
            context: scope.context,
            returnTo: 'queue',
          });
          const href = `${row.href.replace(/\/$/, '')}/edit?${query.toString()}`;
          if (locked || busy || custodyLocked || actionHeld)
            return (
              <span className="text-sm text-muted-foreground" aria-disabled="true">
                {m.prq_open_candidate()}
              </span>
            );
          return (
            <Link
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
              to={href as never}
              onClick={(event) => {
                if (!visit.live()) {
                  event.preventDefault();
                  return;
                }
                const saved = onReviewCandidate?.({
                  scope,
                  contextLabel: choice.label,
                  history: historyRef.current,
                  candidate: address,
                  ...(session.current ? { session: session.current } : {}),
                });
                if (saved === false) event.preventDefault();
              }}
            >
              {m.prq_open_candidate()}
            </Link>
          );
        }}
        locale={locale}
        disabled={!canWrite}
        current={actionCurrent}
        onCustodyChange={(held, phase) => {
          if (visit.live()) {
            actionOwned.current = held;
            onActionHeldChange(held);
            custodyBusy.current = held && phase !== 'settled';
            setCustodyLocked(custodyBusy.current);
          }
        }}
        concealRows={page.state === 'denied' || page.state === 'missing'}
        transport={reviewTransport}
        onRefresh={(queue) => {
          if (!visit.live()) return;
          const next = refreshed.current.get(queue) ?? { state: 'unavailable' as const };
          setPage(next);
          if (next.state === 'ready') session.current = next.session;
        }}
      />
    </div>
  );
}
/** Thin queue insertion seam; producer reads and native decision drafts have separate lifetimes. */
export function ProviderQueueView({
  result,
  locale,
  transport,
  onRetry,
  onRead,
}: {
  result: ProviderQueueRead | { ok: false; reason: 'loading' };
  locale: string;
  transport: ProviderReviewTransport;
  onRetry: () => Promise<ProviderQueueRead>;
  onRead: (read: ProviderQueueRead) => void;
}) {
  const o = { locale: locale as never };
  const current = result;
  const visit = useProviderVisit(providerAlwaysCurrent, transport);
  const [busy, setBusy] = useState(false);
  async function retry() {
    if (!visit.live() || busy) return;
    setBusy(true);
    try {
      const next = await onRetry();
      if (visit.live()) onRead(next);
    } catch {
      if (visit.live()) onRead({ ok: false, reason: 'unavailable' });
    } finally {
      if (visit.live()) setBusy(false);
    }
  }
  return (
    <article className="mx-auto w-full max-w-5xl flex flex-col gap-6 p-4 sm:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold sm:text-3xl">{m.provider_title({}, o)}</h1>
        <p className="text-muted-foreground">{m.provider_intro({}, o)}</p>
      </header>
      {current.ok ? (
        <>
          <p>
            {current.page.sourceLabel} · {current.page.contextLabel} · {current.page.statusLabel}
          </p>
          {!current.page.rows.length && (
            <ContentItemFrame as="div" className="p-4">
              <ContentItemHeading level={2} role="status">
                {m.provider_empty({}, o)}
              </ContentItemHeading>
            </ContentItemFrame>
          )}
        </>
      ) : current.reason === 'loading' ? (
        <ContentItemFrame as="div" aria-busy className="p-4">
          <ContentItemHeading level={2} role="status">
            {m.candidate_loading({}, o)}
          </ContentItemHeading>
        </ContentItemFrame>
      ) : (
        <ContentItemFrame as="div" role="alert" className="flex flex-col gap-3 p-4">
          <ContentItemHeading level={2}>{providerOutcomeText(current, locale)}</ContentItemHeading>
          <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void retry()}>
            {m.provider_refresh({}, o)}
          </Button>
        </ContentItemFrame>
      )}
      <ProviderReviewActions
        page={current.ok ? current.page : undefined}
        locale={locale}
        transport={transport}
        current={visit.live}
        onRefresh={(next) => {
          if (visit.live()) onRead(next);
        }}
        concealRows={!current.ok && (current.reason === 'denied' || current.reason === 'missing')}
      />
    </article>
  );
}
