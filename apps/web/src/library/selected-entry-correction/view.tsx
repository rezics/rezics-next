import { useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { EntryAnnotationCorrectionPage } from '@rezics/client';
import { ChoiceSelect } from '@rezics/ui/choice-select';
import { useSession } from '../../session';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import { PersonalShelfOrigin } from '../personal-shelf-origin';
import type { PersonalLibraryEntry } from '../entries-read';
import type { ShelfMutationLease } from '../shelf-rows';
import { AnnotationNote, AnnotationPriority } from '../rich-private-entry/annotation-review';
import { readPrivateEntryForSubject } from '../rich-private-entry/server';
import { SelectedCorrection } from './controller';
import {
  captureSelection,
  correctionInput,
  correctionIssues,
  initialDraft,
  intended,
  annotationNoteBytes,
  type CorrectionDraft,
  type SelectedEntry,
} from './contract';
import { captureCorrectionSender, readSelectedCorrection, sendSelectedCorrection } from './server';

const button = 'min-h-11 max-w-full whitespace-normal rounded-md border px-3 disabled:opacity-50';
export function SelectedEntryCorrection({
  entries,
  selected,
  isCurrent,
  lease,
  refreshEntries,
}: {
  entries: readonly PersonalLibraryEntry[];
  selected: readonly string[];
  isCurrent: () => boolean;
  lease: ShelfMutationLease;
  refreshEntries: () => Promise<void>;
}) {
  const origin = useContext(PersonalShelfOrigin);
  const session = useSession();
  const createAllowed = useOperation('library_entry_annotation_correction.create');
  const confirmAllowed = useOperation('library_entry_annotation_correction.confirm_item');
  const readAllowed = useOperation('library_entry_annotation_correction.read');
  const cancelAllowed = useOperation('library_entry_annotation_correction.cancel');
  const [visit, setVisit] = useState<{ selection: SelectedEntry[]; current: () => boolean } | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const latest = useRef({ isCurrent, subject: session.subject });
  latest.current = { isCurrent, subject: session.subject };
  const admitted = createAllowed && confirmAllowed && readAllowed && cancelAllowed;
  if (!admitted) return null;
  return (
    <div className="min-w-0 space-y-3">
      <button
        ref={launcher}
        className={button}
        disabled={
          selected.length === 0 ||
          selected.length > 16 ||
          lease.current ||
          !!visit ||
          !isCurrent() ||
          selected.some((id) => !entries.find((entry) => entry.subjectId === id)?.incarnationId)
        }
        onClick={() => {
          const subject = session.subject;
          const captured = origin?.capture(
            'library_entry_annotation_correction.create',
            'library_entry_annotation_correction.confirm_item',
            'library_entry_annotation_correction.read',
            'library_entry_annotation_correction.cancel',
          );
          setVisit({
            selection: captureSelection(entries, selected),
            current: () => latest.current.subject === subject && latest.current.isCurrent() && (captured?.() ?? true),
          });
        }}
      >
        {m.library_selected_correction_title()}
      </button>
      {visit ? (
        <CorrectionVisit
          selection={visit.selection}
          isCurrent={visit.current}
          originWatch={origin?.watch}
          lease={lease}
          refreshEntries={refreshEntries}
          onClose={() => {
            setVisit(null);
            launcher.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

export function CorrectionVisit({
  selection,
  isCurrent,
  originWatch,
  lease,
  refreshEntries,
  onClose,
  makeController,
}: {
  selection: readonly SelectedEntry[];
  isCurrent: () => boolean;
  originWatch?: ((listener: () => void) => () => void) | undefined;
  lease: ShelfMutationLease;
  refreshEntries: () => Promise<void>;
  onClose: () => void;
  makeController?: ((current: () => boolean) => SelectedCorrection) | undefined;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [controller, setController] = useState<SelectedCorrection | null>(null);
  const [preparing, setPreparing] = useState(false);
  const alive = useRef(true);
  const current = () => alive.current && isCurrent();
  const latest = useRef({ current, controller });
  latest.current = { current, controller };
  useEffect(() => {
    alive.current = true;
    const retire = () => {
      if (!latest.current.current()) {
        latest.current.controller?.retire();
        onClose();
      }
    };
    const unwatch = originWatch?.(retire);
    return () => {
      alive.current = false;
      latest.current.controller?.retire();
      unwatch?.();
    };
  }, [originWatch]);
  const issues = correctionIssues(draft);
  const discard = () => {
    controller?.retire();
    setPreparing(true);
    void refreshEntries()
      .then(() => {
        if (current()) onClose();
      })
      .finally(() => {
        if (current()) setPreparing(false);
      });
  };
  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.snapshot ?? (() => null),
    controller?.snapshot ?? (() => null),
  );
  const departure = useAuthoringDeparture(
    () => current(),
    () => preparing || !!controller?.snapshot().command || !!controller?.snapshot().busy,
    JSON.stringify([draft, state?.page?.epoch, state?.command, preparing]),
    discard,
    discard,
    undefined,
    {
      title: m.library_annotation_leave_title(),
      unsaved: m.library_selected_correction_departure(),
      pending: m.library_annotation_unresolved_departure(),
    },
  );
  const review = async () => {
    if (!current() || lease.current || preparing) return;
    setPreparing(true);
    try {
      let visit: SelectedCorrection;
      if (makeController) visit = makeController(current);
      else {
        const identity = await captureCorrectionSender();
        if (!current() || !identity) return;
        visit = new SelectedCorrection(
          {
            send: (command) => sendSelectedCorrection({ data: { identity, command } }),
            read: (reviewId, page) => readSelectedCorrection({ data: { viewer: identity.viewer, reviewId, page } }),
            personal: async (subjectId) => {
              const result = await readPrivateEntryForSubject({ data: { subjectId } });
              return result.kind === 'ready' && result.viewer === identity.viewer
                ? { kind: 'ready', entry: result.entry }
                : { kind: 'unavailable' };
            },
          },
          current,
          refreshEntries,
        );
      }
      setController(visit);
      await visit.create(correctionInput(selection, draft));
    } finally {
      if (current()) setPreparing(false);
    }
  };
  return (
    <section
      aria-label={m.library_selected_correction_title()}
      className="min-w-0 space-y-4 rounded-md border p-3 [overflow-wrap:anywhere]"
    >
      <h3 className="font-semibold">{m.library_selected_correction_title()}</h3>
      <p>{m.library_selected_correction_help({ count: selection.length })}</p>
      {!controller ? (
        <>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <OperationField field="note" draft={draft} onChange={setDraft} disabled={preparing} />
            <OperationField field="priority" draft={draft} onChange={setDraft} disabled={preparing} />
          </div>
          {issues.note ? <p role="alert">{m.library_selected_correction_note_error()}</p> : null}
          {issues.priority ? <p role="alert">{m.library_annotation_priority_error()}</p> : null}
          <button
            className={button}
            disabled={preparing || issues.note || issues.priority}
            onClick={() => void review()}
          >
            {m.library_annotation_review()}
          </button>
        </>
      ) : (
        <CorrectionReview controller={controller} lease={lease} />
      )}
      <button
        className={button}
        disabled={preparing || (!!state?.command && state.command.kind !== 'create') || !!state?.busy}
        onClick={() => departure.requestDiscard(discard)}
      >
        {m.library_selected_correction_return()}
      </button>
    </section>
  );
}

function OperationField({
  field,
  draft,
  onChange,
  disabled,
}: {
  field: 'note' | 'priority';
  draft: CorrectionDraft;
  onChange: (draft: CorrectionDraft) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-2">
      <ChoiceSelect
        id={id}
        label={field === 'note' ? m.library_rich_entry_note() : m.library_rich_entry_priority()}
        fieldClassName="min-w-0 gap-2"
        triggerClassName="min-h-11 w-full rounded-md border bg-background p-2"
        value={draft[field]}
        disabled={disabled}
        onValueChange={(value) => {
          if (value !== null) onChange({ ...draft, [field]: value });
        }}
        options={[
          { value: 'preserve', label: m.library_annotation_unchanged() },
          { value: 'set', label: m.library_annotation_set() },
          { value: 'clear', label: m.library_annotation_clear() },
        ]}
      />
      {draft[field] === 'set' ? (
        field === 'note' ? (
          <>
            <label htmlFor={id + '-value'}>{m.library_annotation_proposed()}</label>
            <textarea
              id={id + '-value'}
              className="min-h-32 w-full rounded-md border bg-background p-2"
              value={draft.noteValue}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, noteValue: event.target.value })}
            />
            <p>{m.library_rich_entry_note_bytes({ count: annotationNoteBytes(draft.noteValue) })}</p>
          </>
        ) : (
          <>
            <label htmlFor={id + '-value'}>{m.library_annotation_proposed()}</label>
            <input
              id={id + '-value'}
              className="min-h-11 w-full rounded-md border bg-background p-2"
              inputMode="numeric"
              value={draft.priorityValue}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, priorityValue: event.target.value })}
            />
            <p>{m.library_annotation_priority_help()}</p>
          </>
        )
      ) : null}
    </div>
  );
}

export function CorrectionReview({ controller, lease }: { controller: SelectedCorrection; lease: ShelfMutationLease }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [state.page?.epoch, state.page?.page]);
  const run = async (action: () => Promise<void>) => {
    if (lease.current) return;
    const owner = Symbol();
    lease.current = true;
    lease.owner = owner;
    lease.listeners.forEach((fn) => fn());
    try {
      await action();
    } finally {
      if (lease.owner === owner) {
        lease.current = false;
        delete lease.owner;
        lease.listeners.forEach((fn) => fn());
      }
    }
  };
  const page = state.page;
  return (
    <div className="min-w-0 space-y-4">
      <h4 tabIndex={-1} ref={heading}>
        {m.library_annotation_review_title()}
      </h4>
      {state.uncertain ? <p role="alert">{m.library_annotation_unresolved_departure()}</p> : null}
      {state.rejected ? <p role="alert">{m.library_selected_correction_rejected()}</p> : null}
      {state.cancellation ? (
        <p role="status">
          {m.library_selected_correction_cancel()} · {state.cancellation.state}
        </p>
      ) : null}
      {state.command && state.command.kind !== 'create' ? (
        <button className={button} disabled={state.busy} onClick={() => void run(() => controller.retry())}>
          {m.library_selected_correction_retry()}
        </button>
      ) : null}
      {state.command?.kind === 'create' && state.uncertain ? (
        <p role="status">{m.library_selected_correction_create_unknown()}</p>
      ) : null}
      {page ? (
        <>
          <p>
            {m.library_selected_correction_page({ page: page.page + 1, count: page.pageCount })} · {page.state} ·{' '}
            {page.expiresAt}
          </p>
          {page.items.map((item, index) => (
            <Comparison
              key={item.selected.subjectId}
              page={page}
              index={index}
              current={state.current[item.selected.subjectId]}
              disabled={state.busy || !!state.command || !!state.cancellation}
              confirm={() => void run(() => controller.confirm(page.page * 4 + index))}
            />
          ))}
          <nav aria-label={m.library_selected_correction_pages()} className="flex flex-wrap gap-2">
            {Array.from({ length: page.pageCount }, (_, number) => (
              <button
                key={number}
                aria-current={number === page.page ? 'page' : undefined}
                className={button}
                disabled={state.busy}
                onClick={() => void controller.reopen(number)}
              >
                {number + 1}
              </button>
            ))}
          </nav>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={state.busy} onClick={() => void controller.reopen()}>
              {m.library_selected_correction_reopen()}
            </button>
            <button
              className={button}
              disabled={state.busy || page.state !== 'open' || !!state.cancellation}
              onClick={() => void run(() => controller.cancel())}
            >
              {m.library_selected_correction_cancel()}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Comparison({
  page,
  index,
  current,
  disabled,
  confirm,
}: {
  page: EntryAnnotationCorrectionPage;
  index: number;
  current: ReturnType<SelectedCorrection['snapshot']>['current'][string] | undefined;
  disabled: boolean;
  confirm: () => void;
}) {
  const item = page.items[index]!;
  return (
    <article className="min-w-0 space-y-3 rounded-md border p-3">
      <h5 className="break-all font-medium">{item.selected.subjectId}</h5>
      <p role="status">
        {item.eligibility} · {item.outcome}
      </p>
      {item.current && item.operation ? (
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div>
            <dt>
              {m.library_annotation_received()} · {m.library_rich_entry_note()}
            </dt>
            <dd>
              <AnnotationNote value={item.current.note} />
            </dd>
          </div>
          <div>
            <dt>
              {m.library_annotation_proposed()} · {item.operation.note.op}
            </dt>
            <dd>
              <AnnotationNote value={intended(item.current.note, item.operation.note)} />
            </dd>
          </div>
          <div>
            <dt>
              {m.library_annotation_received()} · {m.library_rich_entry_priority()}
            </dt>
            <dd>
              <AnnotationPriority value={item.current.priority} />
            </dd>
          </div>
          <div>
            <dt>
              {m.library_annotation_proposed()} · {item.operation.priority.op}
            </dt>
            <dd>
              <AnnotationPriority value={intended(item.current.priority, item.operation.priority)} />
            </dd>
          </div>
        </dl>
      ) : (
        <p>{m.library_selected_correction_fresh_review()}</p>
      )}
      {current?.kind === 'ready' ? (
        <div>
          <p>{m.library_selected_correction_current()}</p>
          <AnnotationNote value={current.entry.note} />
          <AnnotationPriority value={current.entry.priority} />
        </div>
      ) : (
        <p>{m.library_subject_unavailable()}</p>
      )}
      {item.eligibility !== 'ready' ? <p>{m.library_selected_correction_fresh_review()}</p> : null}
      <button
        className={button}
        disabled={disabled || page.state !== 'open' || item.eligibility !== 'ready' || item.outcome !== 'not-started'}
        onClick={confirm}
      >
        {m.library_selected_correction_confirm()}
      </button>
    </article>
  );
}
