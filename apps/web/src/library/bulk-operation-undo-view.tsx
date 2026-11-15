import { useEffect, useId, useRef } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { EntryRestoreFeedback, EntryUndoForm } from './entry-undo';
import { undoOperand, type UndoAttempt, type UndoState } from './bulk-operation-undo';

type Props = {
  href: string;
  authorized: boolean;
  state?: UndoState | undefined;
  busy: boolean;
  writeAvailable: boolean;
  csrfToken?: string | null;
  attempts: ReadonlyMap<string, UndoAttempt>;
  locale: string;
  onRead: () => void;
  onMore: () => void;
  onPrevious: () => void;
  onFirst: () => void;
  onRetryRead: () => void;
  onRestore: (ordinal: string, retry?: boolean) => void;
};

export function BulkOperationUndoView({
  href,
  authorized,
  state,
  busy,
  writeAvailable,
  csrfToken,
  attempts,
  locale,
  onRead,
  onMore,
  onPrevious,
  onFirst,
  onRetryRead,
  onRestore,
}: Props) {
  const operation = state?.operation;
  const visibleOutcomes = state?.read === 'ready' ? (state.page?.outcomes ?? []) : [];
  const visibleOrdinals = new Set(visibleOutcomes.map((outcome) => outcome.ordinal));
  const detachedAttempts = [...attempts].filter(([ordinal]) => !visibleOrdinals.has(ordinal));
  const idPrefix = useId().replace(/:/g, '');
  const windowHeadingId = `${idPrefix}-window`;
  const effectsHeadingId = `${idPrefix}-effects`;
  const windowHeading = useRef<HTMLHeadingElement | null>(null);
  const outcomeTargets = useRef(new Map<string, HTMLLIElement>());
  const attemptTargets = useRef(new Map<string, HTMLElement>());
  const focusIntent = useRef<FocusIntent | undefined>(undefined);
  const restoreFailureOrdinal = useRef<string | undefined>(undefined);

  const outcomeTargetId = (ordinal: string) => `${idPrefix}-outcome-${stableToken(ordinal)}`;
  const outcomeLabelId = (ordinal: string) => `${idPrefix}-outcome-label-${stableToken(ordinal)}`;
  const attemptTargetId = (ordinal: string) => `${idPrefix}-attempt-${stableToken(ordinal)}`;

  function captureOrigin(fallback: HTMLElement) {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body && fallback.contains(active) ? active : fallback;
  }

  function beginWindowAction(callback: () => void, origin: HTMLElement) {
    const element = captureOrigin(origin);
    restoreFailureOrdinal.current = undefined;
    focusIntent.current = { kind: 'window', origin: element, owner: element };
    callback();
  }

  function beginRestore(ordinal: string, callback: () => void, origin: HTMLElement) {
    const element = captureOrigin(origin);
    restoreFailureOrdinal.current = ordinal;
    focusIntent.current = { kind: 'restore', ordinal, origin: element, owner: element };
    callback();
  }

  useEffect(() => {
    function trackFocus(event: FocusEvent) {
      const intent = focusIntent.current;
      const target = event.target;
      if (!intent || !(target instanceof HTMLElement) || target === document.body) return;
      if (intent.origin === target || intent.owner === target) return;
      focusIntent.current = undefined;
    }

    document.addEventListener('focusin', trackFocus);
    return () => document.removeEventListener('focusin', trackFocus);
  }, []);

  useEffect(() => {
    const intent = focusIntent.current;
    if (!intent) return;

    if (intent.kind === 'window') {
      if (!state) return;
      const stage =
        state.read === 'loading'
          ? 'window:loading'
          : `window:${state.read}:${state.operation?.id ?? ''}:${state.cursor ?? ''}`;
      if (intent.stage !== stage) {
        const target = windowHeading.current;
        if (!target) return;
        intent.stage = stage;
        intent.owner = target;
        target.focus({ preventScroll: true });
      }
      if (state.read !== 'loading') focusIntent.current = undefined;
      return;
    }

    const attempt = attempts.get(intent.ordinal);
    if (state?.preparing === intent.ordinal) {
      if (intent.stage !== 'preparing') {
        const target = outcomeTargets.current.get(intent.ordinal);
        if (!target) return;
        intent.stage = 'preparing';
        intent.owner = target;
        target.focus({ preventScroll: true });
      }
      return;
    }

    if (attempt) {
      const stage = `attempt:${attempt.status}:${attempt.result ? 'result' : ''}`;
      if (intent.stage !== stage) {
        const target = attemptTargets.current.get(intent.ordinal) ?? outcomeTargets.current.get(intent.ordinal);
        if (!target) return;
        intent.stage = stage;
        intent.owner = target;
        target.focus({ preventScroll: true });
      }
      if (attempt.status !== 'sending') focusIntent.current = undefined;
      return;
    }

    if (intent.stage === 'preparing') {
      const stage = `outcome:${state?.failure ?? 'settled'}`;
      if (intent.stage !== stage) {
        const target = outcomeTargets.current.get(intent.ordinal);
        if (!target) return;
        intent.stage = stage;
        intent.owner = target;
        target.focus({ preventScroll: true });
      }
      focusIntent.current = undefined;
    }
  });

  function renderAttempt(ordinal: string, attempt: UndoAttempt) {
    const headingId = attemptTargetId(ordinal);
    return (
      <section
        key={ordinal}
        className="min-w-0 max-w-full space-y-2 [overflow-wrap:anywhere]"
        aria-labelledby={headingId}
      >
        <h3
          id={headingId}
          ref={(node) => {
            if (node) attemptTargets.current.set(ordinal, node);
            else attemptTargets.current.delete(ordinal);
          }}
          tabIndex={-1}
          className="text-lg font-semibold [overflow-wrap:anywhere]"
        >
          {m.library_bulk_undo_restore_attempts()} · <code className="break-all">{ordinal}</code> ·{' '}
          <code className="break-all">{attempt.command.subjectId}</code>
        </h3>
        {attempt.status === 'sending' ? (
          <p role="status">{m.library_bulk_undo_sending()}</p>
        ) : attempt.status === 'uncertain' ? (
          <>
            <p role="status">{m.library_bulk_undo_uncertain()}</p>
            <EntryUndoForm
              undo={attempt.command}
              retry
              locale={locale}
              returnTo={href}
              csrfToken={attempt.headers.get('x-csrf-token')}
              disabled={busy || !writeAvailable}
              onSubmit={(event) => {
                event.preventDefault();
                beginRestore(ordinal, () => onRestore(ordinal, true), event.currentTarget);
              }}
            />
          </>
        ) : null}
        {attempt.result && <EntryRestoreFeedback restore={attempt.result} locale={locale} />}
        {attempt.result?.ok && <p role="status">{m.library_bulk_undo_restored()}</p>}
      </section>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 [overflow-wrap:anywhere]">
      <h1 className="text-2xl font-semibold">{m.library_bulk_undo_title()}</h1>
      <p>{m.library_bulk_undo_intro()}</p>
      <p role="status">
        {!authorized
          ? m.bulk_operation_forbidden()
          : !state
            ? m.bulk_operation_recover_needed()
            : state.read === 'loading'
              ? m.bulk_operation_loading()
              : state.read === 'ready'
                ? ''
                : readMessage(state.read)}
      </p>
      <nav className="flex flex-wrap gap-4" aria-label={m.bulk_operation_results()}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!authorized || state?.read === 'loading' || busy}
          onClick={(event) => beginWindowAction(onRead, event.currentTarget)}
        >
          {m.managed_refresh()}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!authorized || state?.read === 'loading' || busy || !state?.previous}
          onClick={(event) => beginWindowAction(onPrevious, event.currentTarget)}
        >
          {m.library_window_previous()}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!authorized || state?.read === 'loading' || busy}
          onClick={(event) => beginWindowAction(onFirst, event.currentTarget)}
        >
          {m.library_window_first()}
        </Button>
        {state?.readRetry && (
          <Button
            type="button"
            variant="outline"
          size="sm"
            disabled={!authorized || busy}
            onClick={(event) => beginWindowAction(onRetryRead, event.currentTarget)}
          >
            {m.library_window_retry()}
          </Button>
        )}
        {state?.read === 'ready' && state.page?.next && (
          <Button
            type="button"
            variant="outline"
          size="sm"
            disabled={!authorized || busy}
            onClick={(event) => beginWindowAction(onMore, event.currentTarget)}
          >
            {m.bulk_operation_more()}
          </Button>
        )}
      </nav>
      {state?.failure && <p role="status">{readMessage(state.failure)}</p>}
      <section className="min-w-0 max-w-full space-y-4 [overflow-wrap:anywhere]" aria-labelledby={windowHeadingId}>
        <h2
          id={windowHeadingId}
          ref={windowHeading}
          tabIndex={-1}
          className="text-xl font-semibold [overflow-wrap:anywhere]"
        >
          {m.bulk_operation_results()}
        </h2>
        {operation && (
          <>
            <p>
              <code className="break-all">{operation.id}</code>
            </p>
            <dl className="space-y-2">
              <dt>{m.bulk_operation_phase()}</dt>
              <dd>{operation.phase}</dd>
              <dt>{m.bulk_operation_deadline()}</dt>
              <dd>
                <time dateTime={operation.expiresAt}>{operation.expiresAt}</time>
              </dd>
              <dt>{m.bulk_operation_results_deadline()}</dt>
              <dd>
                <time dateTime={operation.resultsExpireAt}>{operation.resultsExpireAt}</time>
              </dd>
            </dl>
            {operation.action !== 'remove_from_library' ? (
              <p>{m.library_bulk_undo_other_action()}</p>
            ) : (
              <section
                className="min-w-0 max-w-full space-y-4 [overflow-wrap:anywhere]"
                aria-labelledby={effectsHeadingId}
              >
                <h3 id={effectsHeadingId} className="text-xl font-semibold">
                  {m.library_bulk_undo_native_effects()}
                </h3>
                <p className="text-sm text-muted-foreground">{m.bulk_operation_results()}</p>
                {state?.read === 'ready' && visibleOutcomes.length === 0 && <p>{m.bulk_operation_empty_page()}</p>}
                <ul className="space-y-4">
                  {visibleOutcomes.map((outcome) => {
                    const attempt = attempts.get(outcome.ordinal);
                    const operand = undoOperand(operation, outcome);
                    const targetId = outcomeTargetId(outcome.ordinal);
                    const labelId = outcomeLabelId(outcome.ordinal);
                    const preparationFailure =
                      state?.failure && restoreFailureOrdinal.current === outcome.ordinal && !attempt
                        ? state.failure
                        : undefined;
                    return (
                      <li
                        key={outcome.ordinal}
                        id={targetId}
                        ref={(node) => {
                          if (node) outcomeTargets.current.set(outcome.ordinal, node);
                          else outcomeTargets.current.delete(outcome.ordinal);
                        }}
                        tabIndex={-1}
                        aria-labelledby={labelId}
                        className="min-w-0 max-w-full space-y-2 [overflow-wrap:anywhere]"
                      >
                        <p id={labelId}>
                          <code className="break-all">{outcome.ordinal}</code>
                          {' · '}
                          <code className="break-all">{outcome.subjectId}</code>
                          {' · '}
                          {m.bulk_operation_value({ value: outcome.state })}
                          {outcome.reason && <> · {m.bulk_operation_value({ value: outcome.reason })}</>}
                        </p>
                        {outcome.deletion && (
                          <p>
                            {m.library_bulk_undo_deadline()}{' '}
                            <time dateTime={outcome.deletion.restoreUntil}>{outcome.deletion.restoreUntil}</time>
                          </p>
                        )}
                        {preparationFailure && <p>{readMessage(preparationFailure)}</p>}
                        {state?.preparing === outcome.ordinal ? (
                          <p role="status">{m.library_bulk_undo_sending()}</p>
                        ) : attempt ? (
                          renderAttempt(outcome.ordinal, attempt)
                        ) : !attempt && operand && writeAvailable ? (
                          <Button
                            type="button"
                            variant="outline"
          size="sm"
                            disabled={busy || !csrfToken}
                            onClick={(event) =>
                              beginRestore(outcome.ordinal, () => onRestore(outcome.ordinal), event.currentTarget)
                            }
                          >
                            {m.editor_undo()}
                          </Button>
                        ) : !attempt && outcome.deletion && !operand ? (
                          <p>{m.library_bulk_undo_expired()}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </section>
      {authorized && detachedAttempts.length ? (
        <section className="space-y-4" aria-label={m.library_bulk_undo_restore_attempts()}>
          <h2 className="text-xl font-semibold">{m.library_bulk_undo_restore_attempts()}</h2>
          {detachedAttempts.map(([ordinal, attempt]) => renderAttempt(ordinal, attempt))}
        </section>
      ) : null}
    </main>
  );
}

type FocusIntent =
  | {
      kind: 'window';
      origin: HTMLElement;
      owner: HTMLElement;
      stage?: string;
    }
  | {
      kind: 'restore';
      ordinal: string;
      origin: HTMLElement;
      owner: HTMLElement;
      stage?: string;
    };

function stableToken(value: string) {
  return [...value].map((character) => character.codePointAt(0)!.toString(16)).join('-') || 'empty';
}

function readMessage(state: string) {
  return state === 'forbidden'
    ? m.bulk_operation_forbidden()
    : state === 'expired'
      ? m.bulk_operation_expired()
      : state === 'invalid'
        ? m.bulk_operation_invalid()
        : m.bulk_operation_unavailable();
}
