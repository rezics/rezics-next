import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import type { ShelfLabelOutcome } from './shelf-selection';

type Controls = ReturnType<typeof useShelfRows>;
type LabelPage = Awaited<ReturnType<typeof readSubjectLabelPage>>;

/** A single current signed search page supplies both the label ID and its recognizable name. */
export function ShelfLabelAction({ controls }: { controls: Controls }) {
  const listAdmitted = useOperation('library_label.list');
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [choiceId, setChoiceId] = useState('');
  const [page, setPage] = useState<LabelPage | null>(null);
  const requestId = useRef(0);
  const blocked = controls.pending || controls.labelSelectionBlocked;
  const invalidate = () => {
    requestId.current++;
    setPage(null);
    setChoiceId('');
  };
  const changeOpen = (value: boolean) => {
    invalidate();
    setQuery('');
    setOpen(value);
  };
  useLayoutEffect(
    () => () => {
      requestId.current++;
    },
    [],
  );
  useEffect(() => {
    const id = ++requestId.current;
    setPage(null);
    setChoiceId('');
    if (!open || !listAdmitted || session.state !== 'signed-in') return;
    const timeout = setTimeout(() => {
      void readSubjectLabelPage({ data: { query } })
        .then((result) => {
          if (id === requestId.current) setPage(result);
        })
        .catch(() => {
          if (id === requestId.current) setPage({ state: 'unavailable', labels: [] });
        });
    }, 250);
    return () => {
      clearTimeout(timeout);
      requestId.current++;
    };
  }, [open, query, listAdmitted, session.state, session.subject]);
  const ready =
    listAdmitted && session.state === 'signed-in' && page?.state === 'loaded' && !labelReadMessage(page.reason);
  const choice = ready ? page.labels.find((label) => label.id === choiceId) : undefined;
  const currentRequest = requestId.current;
  if (!controls.labelWriteAdmitted) return null;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button variant="outline" disabled={blocked || !controls.selected.length} />}>
        {m.library_selected_labels_open()}
      </DialogTrigger>
      {open ? (
        <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{m.library_selected_labels_open()}</DialogTitle>
            <DialogDescription>{m.library_selected_labels_description()}</DialogDescription>
          </DialogHeader>
          <label className="grid min-w-0 gap-1 text-sm font-medium">
            {m.library_selected_labels_search()}
            <input
              autoComplete="off"
              maxLength={200}
              value={query}
              onChange={(event) => {
                invalidate();
                setQuery(event.currentTarget.value);
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
                        onCheckedChange={(checked) => setChoiceId(checked ? label.id : '')}
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
                next={page.next ?? null}
                onPage={(result) => {
                  if (currentRequest !== requestId.current) return;
                  setChoiceId('');
                  setPage(result);
                }}
              />
            </div>
          )}
          {choice ? (
            <p role="status" className="break-words">
              {m.library_selected_labels_confirm({ name: choice.name, count: controls.selected.length })}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => changeOpen(false)}>
              {m.library_collection_cancel()}
            </Button>
            <Button
              disabled={!choice || blocked || !controls.selected.length}
              onClick={() => {
                if (!choice || blocked) return;
                void controls.assignSelectedLabel(choice);
                changeOpen(false);
              }}
            >
              {m.library_selected_labels_apply()}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const outcomeLabels: Record<ShelfLabelOutcome['status'], () => string> = {
  assigned: () => m.library_selected_labels_assigned(),
  failed: () => m.library_selection_failed(),
  unknown: () => m.library_selection_unknown_label(),
  'not-attempted': () => m.library_selection_not_attempted(),
};

export function ShelfLabelOutcomes({ controls }: { controls: Controls }) {
  if (!controls.labelOutcomes.length) return null;
  return (
    <section aria-label={m.library_selected_labels_results()} className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="break-words">{m.library_selected_labels_result_name({ name: controls.assignedLabelName })}</p>
      <p>{m.library_selected_labels_partial()}</p>
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
                    : m.library_sign_in()}
              </span>
            ) : null}
            {outcome.status === 'unknown' ? (
              <>
                <span>{m.library_selected_labels_unknown()}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={controls.pending || !controls.labelWriteAdmitted}
                  onClick={() => void controls.retryLabel(outcome.subjectId)}
                  aria-label={m.library_selected_labels_retry_title({
                    title: outcome.title,
                    name: controls.assignedLabelName,
                  })}
                >
                  {m.library_selected_labels_retry()}
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
