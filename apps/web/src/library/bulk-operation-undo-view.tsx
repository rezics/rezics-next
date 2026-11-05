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
  const operation = state?.read === 'ready' ? state.operation : undefined;
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
        <button
          type="button"
          className="min-h-11 underline"
          disabled={!authorized || state?.read === 'loading' || busy}
          onClick={onRead}
        >
          {m.managed_refresh()}
        </button>
        <button
          type="button"
          className="min-h-11 underline"
          disabled={!authorized || state?.read === 'loading' || busy || !state?.previous}
          onClick={onPrevious}
        >
          {m.library_window_previous()}
        </button>
        <button
          type="button"
          className="min-h-11 underline"
          disabled={!authorized || state?.read === 'loading' || busy}
          onClick={onFirst}
        >
          {m.library_window_first()}
        </button>
        {state?.readRetry && (
          <button type="button" className="min-h-11 underline" disabled={!authorized || busy} onClick={onRetryRead}>
            {m.library_window_retry()}
          </button>
        )}
        {state?.page?.next && (
          <button type="button" className="min-h-11 underline" disabled={!authorized || busy} onClick={onMore}>
            {m.bulk_operation_more()}
          </button>
        )}
      </nav>
      {state?.failure && <p role="status">{readMessage(state.failure)}</p>}
      {operation && (
        <>
          <p>
            <code>{operation.id}</code>
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
            <section aria-label={m.bulk_operation_results()}>
              <h2 className="text-xl font-semibold">{m.bulk_operation_results()}</h2>
              {state?.page?.outcomes.length === 0 && <p>{m.bulk_operation_empty_page()}</p>}
              <ul className="space-y-4">
                {state?.page?.outcomes.map((outcome) => {
                  const attempt = attempts.get(outcome.ordinal);
                  const operand = undoOperand(operation, outcome);
                  return (
                    <li key={outcome.ordinal} className="space-y-2">
                      <p>
                        <code>{outcome.subjectId}</code>
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
                      {state.preparing === outcome.ordinal ? (
                        <p role="status">{m.library_bulk_undo_sending()}</p>
                      ) : !attempt && operand && writeAvailable ? (
                        <button
                          type="button"
                          className="min-h-11 underline"
                          disabled={busy || !csrfToken}
                          onClick={() => onRestore(outcome.ordinal)}
                        >
                          {m.editor_undo()}
                        </button>
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
      {authorized &&
        [...attempts].map(([ordinal, attempt]) => (
          <section key={ordinal} className="space-y-2" aria-label={attempt.command.subjectId}>
            <p>
              <code>{attempt.command.subjectId}</code>
            </p>
            {attempt.status === 'sending' ? (
              <p role="status">{m.library_bulk_undo_sending()}</p>
            ) : attempt.status === 'uncertain' && writeAvailable ? (
              <>
                <p role="status">{m.library_bulk_undo_uncertain()}</p>
                <EntryUndoForm
                  undo={attempt.command}
                  retry
                  locale={locale}
                  returnTo={href}
                  csrfToken={attempt.headers.get('x-csrf-token')}
                  disabled={busy}
                  onSubmit={(event) => {
                    event.preventDefault();
                    onRestore(ordinal, true);
                  }}
                />
              </>
            ) : null}
            {attempt.result && <EntryRestoreFeedback restore={attempt.result} locale={locale} />}
            {attempt.result?.ok && <p role="status">{m.library_bulk_undo_restored()}</p>}
          </section>
        ))}
    </main>
  );
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
