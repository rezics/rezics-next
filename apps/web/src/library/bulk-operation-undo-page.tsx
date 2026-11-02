import { useEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { csrfHeaders } from '../threads/composer';
import { usePrivateReportOrigin } from './private-report-current-origin';
import { readBulkOperation } from './bulk-operation-recovery-server';
import { prepareBulkOperationUndo } from './bulk-operation-undo-server';
import { receiveUndoEvidence } from './bulk-operation-undo-evidence';
import { restorePersonalLibraryEntryAction } from './entries-actions';
import { EntryRestoreFeedback, EntryUndoForm } from './entry-undo';
import { BulkOperationUndo, undoOperand, type UndoState } from './bulk-operation-undo';

function addressed(href: string) {
  const url = new URL(href, 'https://site.invalid');
  return url.pathname + url.search;
}

export function BulkOperationUndoPage({ id, href }: { id: string; href: string }) {
  const { origin, value, hydrated } = usePrivateReportOrigin(addressed(href), getLocale(), addressed, false);
  return <UndoReader key={value.owner} id={id} href={href} origin={origin} hydrated={hydrated} />;
}

function UndoReader({
  id,
  href,
  origin,
  hydrated,
}: {
  id: string;
  href: string;
  origin: ReturnType<typeof usePrivateReportOrigin>['origin'];
  hydrated: boolean;
}) {
  const model = useRef<BulkOperationUndo | null>(null);
  const attempted = useRef(false);
  const [visible, setVisible] = useState<{ version: string; state: UndoState }>();
  const current = () => hydrated && origin.capture('personal_library')();
  const restore = () => current() && origin.capture('library_entry.restore')();
  const version = origin.version('personal_library');
  const locale = getLocale();
  useEffect(() => {
    const viewer = origin.read().subject;
    if (!viewer) return;
    const { owner, mount } = origin.read();
    const owned = () => current() && origin.read().owner === owner && origin.read().mount === mount;
    attempted.current = false;
    const reader = new BulkOperationUndo(
      { id, viewer },
      {
        current: owned,
        capture: () => origin.capture('personal_library'),
        captureRestore: () => origin.capture('personal_library', 'library_entry.restore'),
        restore,
        csrf: () => origin.read().csrfToken,
        headers: () => new Headers(csrfHeaders()),
      },
      {
        read: async (address) => receiveUndoEvidence(await readBulkOperation({ data: address })),
        prepare: (target, headers) => prepareBulkOperationUndo({ data: target, headers }),
        sender: () => restorePersonalLibraryEntryAction,
      },
      () => setVisible({ version: origin.version('personal_library'), state: reader.state }),
    );
    model.current = reader;
    return () => {
      reader.retire();
      model.current = null;
    };
  }, [id, origin, hydrated]);
  useEffect(() => {
    if (!attempted.current && current() && model.current) {
      attempted.current = true;
      void model.current.read();
    }
  }, [version, hydrated]);
  const allowed = current();
  const state = allowed && visible?.version === version ? visible.state : undefined;
  const operation = state?.read === 'ready' ? state.operation : undefined;
  const busy = model.current?.busy ?? false;
  const write = restore();
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 [overflow-wrap:anywhere]">
      <h1 className="text-2xl font-semibold">{m.library_bulk_undo_title()}</h1>
      <p>{m.library_bulk_undo_intro()}</p>
      <p role="status">
        {!allowed
          ? m.bulk_operation_forbidden()
          : !state
            ? m.bulk_operation_recover_needed()
            : state.read === 'loading'
              ? m.bulk_operation_loading()
              : state.read === 'ready'
                ? ''
                : readMessage(state.read)}
      </p>
      <button
        type="button"
        className="min-h-11 underline"
        disabled={!allowed || state?.read === 'loading' || busy}
        onClick={() => void model.current?.read()}
      >
        {m.bulk_operation_recover()}
      </button>
      {state?.failure && <p role="status">{readMessage(state.failure)}</p>}
      {operation && (
        <>
          <p>
            <code>{operation.id}</code>
          </p>
          {operation.action !== 'remove_from_library' ? (
            <p>{m.library_bulk_undo_other_action()}</p>
          ) : (
            <section aria-label={m.bulk_operation_results()}>
              <h2 className="text-xl font-semibold">{m.bulk_operation_results()}</h2>
              {state?.page?.outcomes.length === 0 && <p>{m.bulk_operation_empty_page()}</p>}
              <ul className="space-y-4">
                {state?.page?.outcomes.map((outcome) => {
                  const attempt = model.current?.attempts.get(outcome.ordinal);
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
                      {state.preparing === outcome.ordinal || attempt?.status === 'sending' ? (
                        <p role="status">{m.library_bulk_undo_sending()}</p>
                      ) : attempt?.status === 'uncertain' ? (
                        <>
                          <p role="status">{m.library_bulk_undo_uncertain()}</p>
                          <EntryUndoForm
                            undo={attempt.command}
                            retry
                            locale={locale}
                            returnTo={addressed(href)}
                            csrfToken={attempt.headers.get('x-csrf-token')}
                            disabled={!write || busy}
                            onSubmit={(event) => {
                              event.preventDefault();
                              void model.current?.restore(outcome.ordinal, true);
                            }}
                          />
                        </>
                      ) : !attempt && operand && write ? (
                        <button
                          type="button"
                          className="min-h-11 underline"
                          disabled={busy || !origin.read().csrfToken}
                          onClick={() => void model.current?.restore(outcome.ordinal)}
                        >
                          {m.editor_undo()}
                        </button>
                      ) : !attempt && outcome.deletion && !operand ? (
                        <p>{m.library_bulk_undo_expired()}</p>
                      ) : null}
                      {attempt?.result && <EntryRestoreFeedback restore={attempt.result} locale={locale} />}
                      {attempt?.result?.ok && <p role="status">{m.library_bulk_undo_restored()}</p>}
                    </li>
                  );
                })}
              </ul>
              {state?.page?.next && (
                <button
                  type="button"
                  className="min-h-11 underline"
                  disabled={busy}
                  onClick={() => void model.current?.more()}
                >
                  {m.bulk_operation_more()}
                </button>
              )}
            </section>
          )}
        </>
      )}
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
