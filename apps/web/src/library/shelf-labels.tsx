import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@rezics/ui/shadcn/dialog';
import { useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { readSubjectLabelPage } from './labels-actions';
import { labelReadMessage, SubjectLabelMore, SubjectLabelReadNotice } from './subject-labels.tsx';
import type { useShelfRows } from './shelf-rows';
import type { ShelfLabelKind } from './shelf-label-request';
import type { ShelfLabelOutcome } from './shelf-selection';
import { PersonalShelfOrigin } from './personal-shelf-origin';

type Controls = ReturnType<typeof useShelfRows>;
type LabelPage = Awaited<ReturnType<typeof readSubjectLabelPage>>;

/** A single current signed search page supplies both the label ID and its recognizable name. */
export function ShelfLabelAction({ controls, kind = 'assign' }: { controls: Controls; kind?: ShelfLabelKind }) {
  const removing = kind === 'unassign';
  const heading = removing ? m.library_selected_labels_remove_open() : m.library_selected_labels_open();
  const listAdmitted = useOperation('library_label.list');
  const session = useSession();
  const origin = useContext(PersonalShelfOrigin);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [choiceId, setChoiceId] = useState('');
  const [page, setPage] = useState<LabelPage | null>(null);
  const requestId = useRef(0);
  const livePage = useRef<LabelPage | null>(null);
  const liveChoice = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const blocked = controls.pending || controls.labelSelectionBlocked;
  const selected = controls.selected.join(':');
  const searchScope = useMemo(
    () => ({}),
    [
      open,
      query,
      session.state,
      session.subject,
      controls.labelVersion,
      selected,
      controls.labelSelectionIdentity,
      kind,
    ],
  );
  const scope = useMemo(
    () => ({ active: true, current: controls.captureLabel(kind) }),
    [searchScope, controls.labelEpoch, origin],
  );
  const previous = useRef({ scope, searchScope });
  const cancelTimer = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const invalidate = () => {
    scope.active = false;
    requestId.current++;
    cancelTimer();
    livePage.current = null;
    liveChoice.current = '';
    setPage(null);
    setChoiceId('');
  };
  if (previous.current.scope !== scope) {
    previous.current.scope.active = false;
    const changedSearch = previous.current.searchScope !== searchScope;
    previous.current = { scope, searchScope };
    requestId.current++;
    cancelTimer();
    liveChoice.current = '';
    setChoiceId('');
    // Observation churn retires callbacks, but does not replay an accepted search.
    // An interrupted first read can be retried by reopening the chooser.
    const next = changedSearch ? null : (livePage.current ?? { state: 'unavailable' as const, labels: [] });
    livePage.current = next;
    setPage(next);
  }
  const isCurrent = () => mounted.current && scope.active && scope.current();
  const retainedCurrent = () => isCurrent() && page === livePage.current;
  const changeOpen = (value: boolean) => {
    if (!retainedCurrent() || value === open) return;
    invalidate();
    setQuery('');
    setOpen(value);
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current++;
      clearTimeout(timer.current);
    };
  }, []);
  useLayoutEffect(
    () =>
      origin?.watch(() => {
        if (scope.current()) return;
        scope.active = false;
        requestId.current++;
        clearTimeout(timer.current);
      }),
    [origin, scope],
  );
  const accept = (result: LabelPage, request: { query: string; cursor?: string }) => {
    if (!isCurrent()) return false;
    const provenance = result.provenance;
    if (!provenance) return result.state !== 'loaded' && !result.labels.length;
    const viewer = origin ? origin.viewer() : session.state === 'signed-in' ? session.subject : null;
    return (
      !!viewer &&
      provenance.viewer === viewer &&
      provenance.query === request.query &&
      provenance.cursor === request.cursor
    );
  };
  useEffect(() => {
    const id = ++requestId.current;
    if (!open || !listAdmitted || !isCurrent()) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (id !== requestId.current || !isCurrent()) return;
      void readSubjectLabelPage({ data: { query } })
        .then((result) => {
          if (id !== requestId.current || !isCurrent()) return;
          liveChoice.current = '';
          setChoiceId('');
          const next: LabelPage = accept(result, { query }) ? result : { state: 'unavailable', labels: [] };
          livePage.current = next;
          setPage(next);
        })
        .catch(() => {
          if (id === requestId.current && isCurrent()) {
            const next: LabelPage = { state: 'unavailable', labels: [] };
            livePage.current = next;
            setPage(next);
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer.current);
      requestId.current++;
    };
  }, [searchScope]);
  const ready = isCurrent() && listAdmitted && page?.state === 'loaded' && !labelReadMessage(page.reason);
  const choice = ready ? page.labels.find((label) => label.id === choiceId) : undefined;
  const acceptedMore = useRef<LabelPage | null>(null);
  if (!(removing ? controls.labelRemoveAdmitted : controls.labelWriteAdmitted)) return null;
  return (
    <Dialog open={open && isCurrent()} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button variant="outline" disabled={blocked || !controls.selected.length} />}>
        {heading}
      </DialogTrigger>
      {open && isCurrent() ? (
        <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription>
              {removing ? m.library_selected_labels_remove_description() : m.library_selected_labels_description()}
            </DialogDescription>
          </DialogHeader>
          <label className="grid min-w-0 gap-1 text-sm font-medium">
            {m.library_selected_labels_search()}
            <input
              autoComplete="off"
              maxLength={200}
              value={query}
              onChange={(event) => {
                const value = event.currentTarget.value.slice(0, 200);
                if (!retainedCurrent() || value === query) return;
                invalidate();
                setQuery(value);
              }}
              className="h-11 w-full min-w-0 rounded-md border bg-background px-3"
            />
          </label>
          {session.state === 'signed-out' ? (
            <p role="status">{m.library_sign_in()}</p>
          ) : !listAdmitted ? (
            <p role="status">{m.library_subject_label_closed()}</p>
          ) : !page ? (
            <p role="status">{m.library_selected_labels_loading()}</p>
          ) : labelReadMessage(page.reason) ? (
            <SubjectLabelReadNotice {...(page.reason !== undefined ? { reason: page.reason } : {})} />
          ) : page.state === 'closed' ? (
            <p role="status">{m.library_subject_label_closed()}</p>
          ) : page.state === 'signed-out' ? (
            <p role="status">{m.library_sign_in()}</p>
          ) : page.state === 'unavailable' ? (
            <p role="alert">{m.library_subject_label_unavailable()}</p>
          ) : (
            <div className="space-y-3">
              <ul aria-label={m.library_selected_labels_search()} className="max-h-64 space-y-1 overflow-y-auto">
                {page.labels.map((label) => (
                  <li key={label.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 hover:bg-muted">
                      <Checkbox
                        aria-label={label.name}
                        checked={choiceId === label.id}
                        disabled={blocked}
                        onCheckedChange={(checked) => {
                          if (retainedCurrent() && !blocked) {
                            liveChoice.current = checked ? label.id : '';
                            setChoiceId(liveChoice.current);
                          }
                        }}
                      />
                      <span className="min-w-0 break-words">{label.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {!page.labels.length ? (
                <p role="status">
                  {query || page.next ? m.library_selected_labels_no_matches() : m.library_labels_empty()}
                </p>
              ) : null}
              <SubjectLabelMore
                key={`${query}:${requestId.current}`}
                query={query}
                next={page.next && page.next.length <= 4096 ? page.next : null}
                isCurrent={retainedCurrent}
                acceptPage={(result, request) => {
                  if (!retainedCurrent()) return false;
                  if (
                    request.query !== query ||
                    (request.cursor !== undefined && request.cursor !== page.next) ||
                    !accept(result, request)
                  ) {
                    const unavailable: LabelPage = { state: 'unavailable', labels: [] };
                    requestId.current++;
                    liveChoice.current = '';
                    livePage.current = unavailable;
                    setChoiceId('');
                    setPage(unavailable);
                    return false;
                  }
                  acceptedMore.current = result;
                  return true;
                }}
                onPage={(result) => {
                  if (!retainedCurrent() || acceptedMore.current !== result) return;
                  acceptedMore.current = null;
                  requestId.current++;
                  liveChoice.current = '';
                  livePage.current = result;
                  setChoiceId('');
                  setPage(result);
                }}
              />
            </div>
          )}
          {choice ? (
            <p role="status" className="break-words">
              {removing
                ? m.library_selected_labels_remove_confirm({ name: choice.name, count: controls.selected.length })
                : m.library_selected_labels_confirm({ name: choice.name, count: controls.selected.length })}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => changeOpen(false)}>
              {m.library_collection_cancel()}
            </Button>
            <Button
              disabled={!choice || blocked || !controls.selected.length}
              onClick={() => {
                if (
                  !retainedCurrent() ||
                  !choice ||
                  choice.id !== liveChoice.current ||
                  blocked ||
                  !controls.captureLabel(kind)()
                )
                  return;
                void controls.assignSelectedLabel(choice, kind);
                changeOpen(false);
              }}
            >
              {removing ? m.library_selected_labels_remove_apply() : m.library_selected_labels_apply()}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const outcomeLabels: Record<ShelfLabelOutcome['status'], () => string> = {
  assigned: () => m.library_selected_labels_assigned(),
  removed: () => m.library_subject_label_removed_status(),
  unchanged: () => m.library_selected_labels_absent(),
  conflicted: () => m.library_selection_conflicted(),
  failed: () => m.library_selection_failed(),
  unknown: () => m.library_selection_unknown_label(),
  'not-attempted': () => m.library_selection_not_attempted(),
};

export function ShelfLabelOutcomes({ controls }: { controls: Controls }) {
  if (!controls.labelOutcomes.length) return null;
  return (
    <section aria-label={m.library_selected_labels_results()} className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="break-words">{m.library_selected_labels_result_name({ name: controls.assignedLabelName })}</p>
      <p>
        {controls.labelKind === 'unassign'
          ? m.library_selected_labels_remove_partial()
          : m.library_selected_labels_partial()}
      </p>
      <dl role="status" className="flex flex-wrap gap-x-4 gap-y-1">
        {Object.entries(outcomeLabels).map(([status, label]) => (
          <div key={status} className="flex gap-1">
            <dt>{label()}</dt>
            <dd>{controls.labelOutcomes.filter((outcome) => outcome.status === status).length}</dd>
          </div>
        ))}
      </dl>
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {controls.labelOutcomes.map((outcome) => (
          <li key={outcome.subjectId} data-label-outcome={outcome.status} className="flex flex-wrap items-center gap-2">
            <span>
              {outcome.title}: {outcomeLabels[outcome.status]()}
            </span>
            {outcome.reason ? (
              <span>
                {outcome.reason === 'capacity'
                  ? m.library_subject_label_capacity()
                  : outcome.reason === 'closed'
                    ? m.library_subject_label_closed()
                    : outcome.reason === 'signed-out'
                      ? m.library_sign_in()
                      : m.library_subject_label_unavailable()}
              </span>
            ) : null}
            {outcome.status === 'conflicted' ? <span>{m.library_selected_labels_conflict()}</span> : null}
            {outcome.status === 'unknown' ? (
              <>
                <span>
                  {controls.labelKind === 'unassign'
                    ? m.library_selected_labels_remove_unknown()
                    : m.library_selected_labels_unknown()}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    controls.pending ||
                    !controls.canRetryLabel(outcome.subjectId) ||
                    !(controls.labelKind === 'unassign' ? controls.labelRemoveAdmitted : controls.labelWriteAdmitted)
                  }
                  onClick={() => void controls.retryLabel(outcome.subjectId)}
                  aria-label={(controls.labelKind === 'unassign'
                    ? m.library_selected_labels_remove_retry_title
                    : m.library_selected_labels_retry_title)({
                    title: outcome.title,
                    name: controls.assignedLabelName,
                  })}
                >
                  {controls.labelKind === 'unassign'
                    ? m.library_selected_labels_remove_retry()
                    : m.library_selected_labels_retry()}
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
