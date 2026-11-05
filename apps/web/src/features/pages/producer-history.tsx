import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { catalogueEditor, CatalogueCurrentReading, useEditorLifetime } from '../catalogue/editor-lifetime';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { ViewHeading } from './view-heading';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import type { RelationTransport, RelationDraft, RelationSlot } from '../../subject/relation-candidates';
import { m } from '../../paraglide/messages.js';
import { RelationEditor } from '../catalogue/relation-editor';
import { useConsentFocus } from '../catalogue/statement-consent-focus';
import {
  producerHistoryCorrection,
  type ProducerHistoryRead,
  type ProducerHistoryRow,
} from '../catalogue/producer-history';
import { useProducerHistorySlice, type HistoryIntent } from './producer-history-reading/model';
import { HistoryRow } from './producer-history-reading/row';
import { actionClass, linkClass, focusClass, meaningLabel } from './producer-history-reading/presentation';

export type ProducerHistoryTransport = {
  read: (stream?: string, cursor?: string, session?: string) => Promise<ProducerHistoryRead>;
  relation: (holder: string) => RelationTransport;
};
type Correction = {
  instance: number;
  id: string;
  statement: RelationDraft;
  slot?: RelationSlot;
  positionEditable: boolean;
  session?: string | undefined;
  origin: HistoryIntent;
  occurrence: number | undefined;
  revision: number;
  holderLabel: string;
  holderLanguage: string | null;
  returnFocus: HTMLElement;
  confirmClose: boolean;
  retired: boolean;
};

export const ProducerHistoryPage = catalogueEditor(ProducerHistoryPageLive);

function ProducerHistoryPageLive({
  id,
  locale,
  transport,
  search,
  initial,
  returnTo,
}: {
  id: string;
  locale: string;
  transport: ProducerHistoryTransport;
  search: EntityPickerSearch;
  initial?: ProducerHistoryRead | undefined;
  returnTo?: string | undefined;
}) {
  const streamId = useId();
  const lifetime = useEditorLifetime();
  const reader = useProducerHistorySlice({ id, locale, transport, initial });
  const { slice, read } = reader;
  const lease = useCatalogueLifetime(String(slice.revision), lifetime);
  const [selected, setSelected] = useState<{ revision: number; index: number }>();
  const [draft, setDraft] = useState<Correction>();
  const [part, setPart] = useState<EntityPickerSubject[]>([]);
  const nextInstance = useRef(0);
  const sliceHeading = useRef<HTMLHeadingElement>(null);
  const readFocus = useConsentFocus();
  const correctionRefresh = useRef<number | undefined>(undefined);
  const focusAfterClose = useRef<{ target: HTMLElement; revision: number } | undefined>(undefined);
  const o = { locale: locale as never };
  const stream = read?.stream;
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  // The address is route intent. A failure never keeps the previous producer label or body.
  const origin = subjectHref({ id, label: title.text }, locale).href;
  const failure = slice.phase === 'failed' ? slice.failure : undefined;
  const busy = slice.phase === 'loading';
  const returned = read && slice.intent.selection;
  const returnedRow = returned && read?.rows[returned.index];
  const returnedSlot = returnedRow && stream && producerHistoryCorrection(returnedRow, stream)?.slot;
  // Only the same occurrence at the same native origin can be restored; never scan by label or ID.
  const returnedIndex =
    returned &&
    returnedRow?.holder === returned.holder &&
    returnedRow.statementId === returned.statement &&
    returnedRow.statement &&
    JSON.stringify(returnedSlot) === JSON.stringify(returned.slot)
      ? returned.index
      : undefined;
  const selectedIndex = selected?.revision === slice.revision ? selected.index : returnedIndex;
  const admittedSelection = useRef<number | undefined>(undefined);
  admittedSelection.current = returnedIndex;
  const correctionCurrent = !!draft && !draft.retired && draft.revision === slice.revision && !!read;
  useLayoutEffect(() => {
    const intent = focusAfterClose.current;
    focusAfterClose.current = undefined;
    if (!intent || !lease.active() || intent.revision !== slice.revision) return;
    if (intent.target.isConnected) intent.target.focus();
    else sliceHeading.current?.focus();
  }, [draft, lease, slice.revision]);

  function admittedFocus() {
    const index = admittedSelection.current;
    return index === undefined
      ? sliceHeading.current
      : sliceHeading.current?.ownerDocument.getElementById(`${streamId}-org-${index}`);
  }
  function load(intent: HistoryIntent, event?: MouseEvent<HTMLButtonElement>, preserveFocus = false) {
    if (!lifetime.active()) return;
    if (!preserveFocus) {
      readFocus.cancel();
      correctionRefresh.current = undefined;
    }
    lease.retire();
    setSelected(undefined);
    setPart([]);
    // Retirement is permanent for this editor instance, even after equal successful admission.
    setDraft((current) => (current ? { ...current, retired: true } : undefined));
    const pending = reader.request(intent);
    const revision = reader.currentRevision();
    if (preserveFocus) correctionRefresh.current = revision;
    else
      readFocus.begin(
        event,
        () => reader.owned(revision),
        admittedFocus,
        () => reader.admitted(revision),
      );
    void pending;
  }
  function inspect(index: number, button: HTMLButtonElement) {
    if (!lease.active() || !read?.rows[index]) return;
    readFocus.cancel();
    setSelected({ revision: slice.revision, index });
    // Selection is synchronous: focus cannot outlive this slice or move after a later request.
    if (button.ownerDocument.activeElement === button)
      button.closest('li')?.querySelector<HTMLElement>('h2, h3')?.focus();
  }
  function open(row: ProducerHistoryRow, index: number, button: HTMLButtonElement) {
    if (!lease.active() || !stream || draft) return;
    const correction = producerHistoryCorrection(row, stream);
    if (!correction) return;
    setSelected({ revision: slice.revision, index });
    const holder =
      row.holder === id
        ? title
        : {
            text: row.summary?.label?.value ?? m.subject_value_unlabelled({}, o),
            lang: row.summary?.label?.language ?? null,
          };
    setDraft({
      ...correction,
      instance: ++nextInstance.current,
      session: read?.session,
      origin: reader.reload({ index, holder: row.holder, statement: row.statementId, slot: correction.slot }),
      occurrence: index,
      revision: slice.revision,
      holderLabel: holder.text || m.subject_value_unlabelled({}, o),
      holderLanguage: holder.lang,
      returnFocus: button,
      confirmClose: false,
      retired: false,
    });
  }
  function add(button: HTMLButtonElement) {
    if (!lease.active() || !stream || !part[0] || draft) return;
    const target = part[0];
    const holder = stream.direction === 'forward' ? id : target.id;
    setDraft({
      instance: ++nextInstance.current,
      id: holder,
      positionEditable: false,
      session: read?.session,
      statement: {
        property: { id: stream.property, data_type: 'wikibase-item' },
        value: { type: 'value', content: stream.direction === 'forward' ? target.id : id },
        qualifiers: [],
        references: [],
      },
      origin: reader.reload(),
      occurrence: undefined,
      revision: slice.revision,
      holderLabel: stream.direction === 'forward' ? title.text : target.title,
      holderLanguage: stream.direction === 'forward' ? title.lang : null,
      returnFocus: button,
      confirmClose: true,
      retired: false,
    });
  }
  function closeDraft() {
    if (!draft || !lifetime.active()) return;
    readFocus.cancel();
    if (correctionCurrent) focusAfterClose.current = { target: draft.returnFocus, revision: draft.revision };
    setDraft(undefined);
  }
  const failed =
    failure?.reason === 'unavailable'
      ? m.producer_history_unavailable({}, o)
      : failure?.reason === 'stale'
        ? m.producer_history_reader_stale({}, o)
        : failure?.reason === 'invalid'
          ? m.candidate_invalid({}, o)
          : m.candidate_denied({}, o);
  return (
    <article
      className={`mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere] [&_:is(a,button,select):focus-visible]:outline-2 [&_:is(a,button,select):focus-visible]:outline-offset-2 [&_:is(a,button,select):focus-visible]:outline-ring`}
      aria-busy={busy}
    >
      <ViewHeading label={m.producer_history_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.producer_history_intro({}, o)}</p>
      <a className={linkClass} href={returnTo ?? origin}>
        {m.producer_history_back({}, o)}
      </a>
      {read && (
        <p lang={title.lang ?? undefined} className="font-sans text-xl font-semibold">
          {title.text || m.subject_value_unlabelled({}, o)}
        </p>
      )}
      <div className="space-y-3">
        {failure && <p role="alert">{failed}</p>}
        {busy && (
          <p role="status">
            {slice.intent.cursor ? m.producer_history_loading_page({}, o) : m.candidate_loading({}, o)}
          </p>
        )}
        {failure && (
          <div className="flex flex-wrap gap-2">
            {failure.reason === 'unavailable' && (
              <Button className={actionClass} variant="outline" onClick={(event) => load(slice.intent, event)}>
                {m.producer_history_retry({}, o)}
              </Button>
            )}
            <Button className={actionClass} variant="outline" onClick={(event) => load(reader.restart(), event)}>
              {m.producer_history_restart({}, o)}
            </Button>
          </div>
        )}
        {!!reader.streams.length && (
          <Field>
            <FieldLabel htmlFor={streamId}>{m.producer_history_relation({}, o)}</FieldLabel>
            <NativeSelect
              id={streamId}
              className="min-w-0 max-w-full [&_select]:min-h-11"
              value={reader.key ?? ''}
              onChange={(event) => load(reader.replace(event.target.value))}
            >
              {reader.streams.map((item) => (
                <NativeSelectOption key={item.key} value={item.key}>
                  {meaningLabel(item.meaning, locale)}
                  {item.label.text ? ` · ${item.label.text}` : ''}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
      </div>
      {read && (
        <section className="space-y-4" aria-labelledby={`${streamId}-slice`}>
          <h2
            id={`${streamId}-slice`}
            ref={sliceHeading}
            tabIndex={-1}
            className={`font-sans text-xl font-semibold ${focusClass}`}
          >
            {stream ? meaningLabel(stream.meaning, locale) : m.producer_history_no_stream({}, o)}
          </h2>
          <p role="status">
            {slice.intent.cursor ? m.producer_history_later_page({}, o) : m.producer_history_first_page({}, o)}
          </p>
          {!!read.unreleased.length && (
            <p>
              {m.producer_history_unreleased({}, o)}{' '}
              {read.unreleased.map((item) => meaningLabel(item.meaning, locale)).join(' · ')}
            </p>
          )}
          {stream && (
            <>
              {!read.caughtUp && <p role="status">{m.producer_history_incomplete({}, o)}</p>}
              {!read.rows.length && <p>{m.producer_history_empty({}, o)}</p>}
              <ul>
                {read.rows.map((row, index) => (
                  <HistoryRow
                    key={`${slice.revision}:${index}`}
                    row={row}
                    stream={stream}
                    read={read}
                    locale={locale}
                    headingId={`${streamId}-org-${index}`}
                    selected={selectedIndex === index}
                    correctionLocked={!!draft && (draft.retired || draft.occurrence !== index)}
                    select={(button) => inspect(index, button)}
                    correct={(button) => open(row, index, button)}
                  />
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                {reader.previous && (
                  <Button
                    className={actionClass}
                    variant="outline"
                    onClick={(event) => load(reader.previous!(), event)}
                  >
                    {m.producer_history_previous({}, o)}
                  </Button>
                )}
                <Button className={actionClass} variant="outline" onClick={(event) => load(reader.first(), event)}>
                  {m.producer_history_first({}, o)}
                </Button>
                {read.next && (
                  <Button className={actionClass} variant="outline" onClick={(event) => load(reader.more(), event)}>
                    {m.producer_history_more({}, o)}
                  </Button>
                )}
                <Button className={actionClass} variant="outline" onClick={(event) => load(reader.reload(), event)}>
                  {m.candidate_reload({}, o)}
                </Button>
                <Button className={actionClass} variant="outline" onClick={(event) => load(reader.restart(), event)}>
                  {m.producer_history_restart({}, o)}
                </Button>
              </div>
              <section className="space-y-3 rounded-lg border border-border p-4">
                <h2 className="font-sans text-lg font-semibold">{m.producer_history_correct({}, o)}</h2>
                <EntityPicker
                  label={m.producer_history_follow({}, o)}
                  search={search}
                  src={coverSrc}
                  value={part}
                  onValueChange={(items) => lease.active() && setPart(items)}
                />
                <Button
                  className={actionClass}
                  variant="outline"
                  disabled={!part.length || !!draft}
                  onClick={(event) => add(event.currentTarget)}
                >
                  {m.producer_history_draft({}, o)}
                </Button>
              </section>
            </>
          )}
        </section>
      )}
      {draft && (
        <section
          className="space-y-3 border-t border-border pt-6"
          aria-label={m.producer_history_correction_context({}, o)}
          onClickCapture={(event) => {
            const source = event.target instanceof Element ? event.target.closest('button') : null;
            if (!correctionCurrent || !(source instanceof HTMLButtonElement)) return;
            correctionRefresh.current = undefined;
            // Capture keyboard consent before the asynchronous command, not from whichever
            // element happens to have focus when a later selection callback arrives.
            readFocus.begin(
              { currentTarget: source, detail: event.detail },
              () =>
                correctionRefresh.current === undefined ? lease.active() : reader.owned(correctionRefresh.current),
              admittedFocus,
              () => correctionRefresh.current !== undefined && reader.admitted(correctionRefresh.current),
            );
          }}
        >
          {correctionCurrent ? (
            <>
              <h2 className="font-sans text-lg font-semibold">{m.producer_history_correction_context({}, o)}</h2>
              <p>
                {m.producer_history_holder({}, o)}{' '}
                <span lang={draft.holderLanguage ?? undefined}>{draft.holderLabel}</span>
              </p>
              <p>
                {stream && meaningLabel(stream.meaning, locale)} · {stream?.label.text} ·{' '}
                {stream?.direction === 'inverse'
                  ? m.producer_history_inverse({}, o)
                  : m.producer_history_forward({}, o)}
              </p>
              <Button
                className={actionClass}
                variant="outline"
                onClick={() => {
                  if (lease.active()) sliceHeading.current?.focus();
                }}
              >
                {m.producer_history_return({}, o)}
              </Button>
            </>
          ) : (
            <>
              <h2 className="font-sans text-lg font-semibold">{m.producer_history_correction_retired({}, o)}</h2>
              <p role="status">{m.producer_history_retired_explanation({}, o)}</p>
              <p>{m.producer_history_slice_lost({}, o)}</p>
              <Button className={actionClass} variant="outline" onClick={closeDraft}>
                {m.producer_history_retired_close({}, o)}
              </Button>
              {!busy && (
                <Button className={actionClass} variant="outline" onClick={(event) => load(reader.restart(), event)}>
                  {m.producer_history_restart({}, o)}
                </Button>
              )}
            </>
          )}
          <CatalogueCurrentReading
            visible={correctionCurrent}
            ready={correctionCurrent}
            revision={`${draft.instance}:${draft.retired ? 'retired' : draft.revision}`}
          >
            <RelationEditor
              key={draft.instance}
              id={draft.id}
              locale={locale}
              transport={transport.relation(draft.id)}
              search={search}
              composition={draft}
              requireCloseConfirmation={draft.confirmClose}
              onClose={closeDraft}
              onSelected={() => {
                if (correctionCurrent && lease.active()) load(draft.origin, undefined, true);
              }}
            />
          </CatalogueCurrentReading>
        </section>
      )}
    </article>
  );
}
