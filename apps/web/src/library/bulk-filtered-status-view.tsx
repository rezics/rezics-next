import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { FilterDocument } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import { libraryEntryStateWrite } from './shelf-params';
import { readBulkOperation } from './bulk-operation-recovery-server';
import {
  captureFilteredStatusCommand,
  previewFilteredStatus,
  confirmFilteredStatus,
} from './bulk-filtered-status-server';
import { captureFilteredStatus, FilteredStatusJourney, type FilteredStatusSender } from './bulk-filtered-status';

const sender: FilteredStatusSender = {
  capture: (data) => captureFilteredStatusCommand({ data, headers: new Headers(data.headers) }),
  preview: (data) => previewFilteredStatus({ data, headers: new Headers(data.headers) }),
  confirm: (data) => confirmFilteredStatus({ data, headers: new Headers(data.headers) }),
  read: (data) => readBulkOperation({ data }),
};
type Source = {
  id: string;
  title: string;
  filter?: FilterDocument | undefined;
  visibility?: string | null | undefined;
  filterStatus?: string | undefined;
  filterIgnored?: string[] | undefined;
};

/** Reader action, independent of loaded selection and editor operations. */
export function CollectionFilteredStatus({
  page,
  address,
  ready,
  isCurrent,
}: {
  page: Source;
  address: string;
  ready: boolean;
  isCurrent?: (() => boolean) | undefined;
}) {
  const locale = getLocale();
  const owner = useCollectionOwnerCurrent(address);
  const signature = JSON.stringify([
    address,
    locale,
    page.id,
    page.filter,
    page.filterIgnored,
    page.filterStatus,
    ready,
    page.visibility,
  ]);
  return (
    <FilteredStatusForm
      key={JSON.stringify([signature, owner.lifetime])}
      page={page}
      owner={owner}
      sourceCurrent={isCurrent}
      ready={ready && !page.filterStatus && !page.filterIgnored?.length}
    />
  );
}
function FilteredStatusForm({
  page,
  owner,
  ready,
  sourceCurrent,
}: {
  page: Source;
  owner: ReturnType<typeof useCollectionOwnerCurrent>;
  ready: boolean;
  sourceCurrent: (() => boolean) | undefined;
}) {
  const id = useId();
  const [requestedState, setRequestedState] = useState('');
  const [journey, setJourney] = useState<FilteredStatusJourney | null>(null);
  const [, render] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const latest = useRef(owner);
  latest.current = owner;
  const mounted = useRef(false);
  const intent = useRef<FilteredStatusJourney | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      intent.current?.retire();
    };
  }, []);
  const current = () => mounted.current && latest.current.isCurrent() && ready && (sourceCurrent?.() ?? true);
  const write = (kind: 'preview' | 'confirm') =>
    current() &&
    !!latest.current.credential() &&
    latest.current.operationCurrent(kind === 'preview' ? 'library_operation.preview' : 'library_operation.confirm');
  function prepare() {
    if (!write('preview') || intent.current || !owner.subject) return;
    try {
      const capture = captureFilteredStatus(page.id, page.filter, requestedState);
      const owning = owner.isOwnerCurrent;
      const value = new FilteredStatusJourney(
        capture,
        owner.subject,
        {
          'x-csrf-token': owner.credential()!,
          'accept-language': getLocale(),
        },
        sender,
        () => mounted.current && owning() && (sourceCurrent?.() ?? true),
        (kind) =>
          kind === 'read'
            ? current() &&
              latest.current.operationCurrent('library_operation.get') &&
              latest.current.operationCurrent('library_operation.outcomes')
            : write(kind),
        () => {
          if (mounted.current) render((n) => n + 1);
        },
        () => latest.current.isCurrent,
      );
      intent.current = value;
      setJourney(value);
      setInvalid(false);
      void value.preview();
    } catch {
      setInvalid(true);
    }
  }
  const state = journey?.state;
  const operation = journey?.visible ? state?.operation : undefined;
  const busy = state?.phase === 'previewing' || state?.phase === 'confirming' || state?.reading;
  const canRead =
    current() &&
    owner.operationCurrent('library_operation.get') &&
    owner.operationCurrent('library_operation.outcomes');
  const result = state?.read;
  return (
    <section className="space-y-3 border-t border-border pt-4" aria-labelledby={`${id}-heading`} aria-busy={busy}>
      <h2 id={`${id}-heading`} className="font-semibold">
        {m.library_filtered_status_heading()}
      </h2>
      <p>{m.library_filtered_status_scope()}</p>
      <p>
        {m.library_filtered_status_source()}: {page.title}
      </p>
      <p className="text-sm text-muted-foreground">{m.library_filtered_status_help()}</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          prepare();
        }}
      >
        <div className="space-y-1">
          <label htmlFor={`${id}-state`}>{m.library_filtered_status_state()}</label>
          <Input
            id={`${id}-state`}
            value={requestedState}
            maxLength={64}
            disabled={!!state && ['confirming', 'confirmation_uncertain', 'confirmed'].includes(state.phase)}
            aria-describedby={`${id}-help`}
            onChange={(event) => {
              intent.current?.retire();
              intent.current = null;
              setJourney(null);
              setInvalid(false);
              setRequestedState(event.target.value);
            }}
          />
          <p id={`${id}-help`} className="text-sm text-muted-foreground">
            {m.library_filtered_status_state_help()}
          </p>
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={!write('preview') || !libraryEntryStateWrite(requestedState) || !!journey}
        >
          {m.library_filtered_status_prepare()}
        </Button>
      </form>
      {!ready || !owner.admitted ? <p role="status">{m.library_filtered_status_unavailable()}</p> : null}
      {invalid ? <p role="alert">{m.library_filtered_status_invalid()}</p> : null}
      {state?.phase === 'previewing' ? <p role="status">{m.library_filtered_status_preparing()}</p> : null}
      {state &&
      ['preparing', 'unsupported', 'denied', 'limit', 'unavailable', 'preview_uncertain'].includes(state.phase) ? (
        <div role="status">
          <p>
            {state.phase === 'preparing'
              ? m.library_filtered_status_preparing()
              : state.phase === 'unsupported'
                ? m.library_filtered_status_unsupported()
                : state.phase === 'denied'
                  ? m.library_filtered_status_denied()
                  : state.phase === 'limit'
                    ? m.library_filtered_status_limit()
                    : state.phase === 'preview_uncertain'
                      ? m.library_filtered_status_preview_uncertain()
                      : m.library_filtered_status_unavailable()}
          </p>
          {['preparing', 'unavailable', 'preview_uncertain'].includes(state.phase) ? (
            <Button
              type="button"
              variant="outline"
              disabled={!write('preview') || busy}
              onClick={() => void journey?.preview()}
            >
              {m.library_filtered_status_retry_preview()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {result && result.state !== 'ready' ? (
        <p role="status">
          {result.state === 'expired' ? m.library_filtered_status_expired() : m.library_filtered_status_unavailable()}
        </p>
      ) : null}
      {state?.operation && !operation ? (
        <Button type="button" variant="outline" disabled={!canRead || busy} onClick={() => void journey?.read()}>
          {m.library_filtered_status_read()}
        </Button>
      ) : null}
      {operation && current() ? (
        <div className="space-y-3">
          {state?.phase === 'previewed' ? <h3>{m.library_filtered_status_complete_preview()}</h3> : null}
          <p>{m.library_filtered_status_targets({ count: operation.counts.targets })}</p>
          <p>
            {m.library_filtered_status_state()}: {journey!.capture.state}
          </p>
          <details>
            <summary>{m.library_filtered_status_predicate()}</summary>
            <pre className="whitespace-pre-wrap break-all">
              {operation.selectionSource?.filter ?? m.library_filtered_status_no_predicate()}
            </pre>
          </details>
          <p>
            {m.library_filtered_status_execution_deadline()}:{' '}
            <time dateTime={operation.expiresAt}>{operation.expiresAt}</time>
          </p>
          <p>
            {m.library_filtered_status_results_deadline()}:{' '}
            <time dateTime={operation.resultsExpireAt}>{operation.resultsExpireAt}</time>
          </p>
          {state?.phase === 'previewed' ? (
            <Button
              type="button"
              disabled={!write('confirm') || !journey?.canConfirm || busy}
              onClick={() => void journey?.confirm().then(() => journey.read())}
            >
              {m.library_filtered_status_confirm()}
            </Button>
          ) : null}
          {state?.phase === 'confirming' ? <p role="status">{m.library_filtered_status_confirming()}</p> : null}
          {state?.phase === 'confirmation_uncertain' ? (
            <div role="status">
              <p>{m.library_filtered_status_confirmation_uncertain()}</p>
              <Button
                type="button"
                disabled={!write('confirm') || busy}
                onClick={() => void journey?.confirm().then(() => journey.read())}
              >
                {m.library_filtered_status_retry_confirm()}
              </Button>
            </div>
          ) : null}
          <p role="status">
            {operation.phase === 'preview'
              ? m.library_filtered_status_awaiting_confirmation()
              : operation.phase === 'completed' || operation.phase === 'completed_with_errors'
                ? m.library_filtered_status_finished()
                : ['cancelled', 'stopped', 'expired'].includes(operation.phase)
                  ? m.library_filtered_status_stopped()
                  : m.library_filtered_status_running()}
          </p>
          <ul>
            <li>
              {m.library_filtered_status_applied()}: {operation.counts.applied}
            </li>
            <li>
              {m.library_filtered_status_unchanged()}: {operation.counts.no_effect}
            </li>
            <li>
              {m.library_filtered_status_changed()}: {operation.counts.conflict}
            </li>
            <li>
              {m.library_filtered_status_denied()}: {operation.counts.denied}
            </li>
            <li>
              {m.library_filtered_status_failed()}: {operation.counts.failed}
            </li>
            <li>
              {m.library_filtered_status_cancelled()}: {operation.counts.cancelled}
            </li>
            <li>
              {m.library_filtered_status_pending()}: {operation.counts.pending + operation.counts.reconciling}
            </li>
          </ul>
          <Button type="button" variant="outline" disabled={!canRead || busy} onClick={() => void journey?.read()}>
            {m.library_filtered_status_read()}
          </Button>
          {result?.state === 'ready' ? (
            <>
              <ol>
                {result.page.outcomes.map((outcome) => (
                  <li key={outcome.ordinal}>
                    {outcome.subjectId}:{' '}
                    {outcome.state === 'conflict'
                      ? m.library_filtered_status_changed()
                      : outcome.state === 'applied'
                        ? m.library_filtered_status_applied()
                        : outcome.state === 'no_effect'
                          ? m.library_filtered_status_unchanged()
                          : outcome.state === 'denied'
                            ? m.library_filtered_status_denied()
                            : outcome.state === 'failed'
                              ? m.library_filtered_status_failed()
                              : outcome.state === 'cancelled'
                                ? m.library_filtered_status_cancelled()
                                : m.library_filtered_status_pending()}
                    {outcome.reason ? ` (${outcome.reason})` : ''}
                  </li>
                ))}
              </ol>
              {result.page.next ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canRead || busy}
                  onClick={() => void journey?.read(result.page.next!)}
                >
                  {m.library_filtered_status_more()}
                </Button>
              ) : null}
            </>
          ) : result ? (
            <p role="status">
              {result.state === 'expired'
                ? m.library_filtered_status_expired()
                : m.library_filtered_status_unavailable()}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
