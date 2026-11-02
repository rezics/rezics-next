import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowLink } from '@rezics/ui/list-row';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { CandidateValue } from '../pages/data';
import { ViewHeading } from '../pages/view-heading';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import type { RelationTransport, RelationDraft, RelationSlot } from '../../subject/relation-candidates';
import { m } from '../../paraglide/messages.js';
import { RelationEditor } from './relation-editor';
import { useConsentFocus } from './statement-consent-focus';
import { partCorrection, type WorkPartsRead, type PartStream, type PartRow } from './work-parts';

export type WorkPartsTransport = {
  read: (stream?: string, cursor?: string, session?: string) => Promise<WorkPartsRead>;
  relation: (holder: string) => RelationTransport;
};
type Correction = {
  key: string;
  id: string;
  statement: RelationDraft;
  slot?: RelationSlot;
  positionEditable: boolean;
  session?: string | undefined;
};
type OpeningFocus = { instance: number; active: () => boolean; cancel: () => void };

type OpenDraft = Correction & {
  instance: number;
  returnFocus: HTMLElement;
  confirmClose: boolean;
};

const actionClassName =
  'h-auto min-h-8 max-w-full whitespace-normal [overflow-wrap:anywhere] py-1.5 max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const summaryClassName =
  'cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';
const linkClassName =
  'block w-fit max-w-full font-sans font-semibold underline max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';

/** Each opened assertion owns the existing editor's independent draft, request key and exact-slot review. */
export const WorkPartsPage = catalogueEditor(WorkPartsPageLive);

function WorkPartsPageLive({
  id,
  locale,
  transport,
  search,
  initial,
}: {
  id: string;
  locale: string;
  transport: WorkPartsTransport;
  search: EntityPickerSearch;
  initial?: WorkPartsRead | undefined;
}) {
  const streamId = useId();
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['work-parts', id, locale], lifetime.generation],
    queryFn: () => transport.read(),
    initialData: initial,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [page, setPage] = useState<Extract<WorkPartsRead, { ok: true }>>();
  const [failure, setFailure] = useState<Extract<WorkPartsRead, { ok: false }>>();
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<OpenDraft[]>([]);
  const nextDraftInstance = useRef(0);
  const focusAfterOpen = useRef<OpeningFocus | undefined>(undefined);
  useLayoutEffect(() => () => focusAfterOpen.current?.cancel(), []);
  const focusAfterClose = useRef<HTMLElement | undefined>(undefined);
  const readFocus = useConsentFocus();
  const readSequence = useRef(0);
  const sliceStatus = useRef<HTMLParagraphElement>(null);
  const readFailure = useRef<HTMLParagraphElement>(null);
  const [part, setPart] = useState<EntityPickerSubject[]>([]);
  const running = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const cursor = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const target = focusAfterClose.current;
    if (!target) return;
    focusAfterClose.current = undefined;
    if (target.isConnected) target.focus();
  }, [drafts]);
  const read = page ?? (query.data?.ok ? query.data : undefined);
  const error = failure ?? (!page && query.data && !query.data.ok ? query.data : undefined);
  const concealed = !!error || (!page && query.isError);
  const stream = read?.stream;
  const sliceRevision = useRef(0);
  // Slice controls retire separately from independently opened corrections.
  const slice = useCatalogueLifetime(JSON.stringify([stream?.key, cursor.current, sliceRevision.current]), lifetime);
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  async function load(key = stream?.key, next?: string, event?: MouseEvent<HTMLButtonElement>) {
    if (!slice.active()) return;
    // A new read action cancels orientation even when the transport is already busy.
    readFocus.cancel();
    if (running.current) return;
    if (key !== stream?.key || next !== cursor.current) {
      slice.retire();
      sliceRevision.current++;
    }
    const sequence = ++readSequence.current;
    const revision = sliceRevision.current;
    const opener = event?.currentTarget;
    let complete = false;
    let outcome: 'slice' | 'failure' = 'slice';
    readFocus.begin(
      event,
      // The requesting slice can retire at start; the resulting slice owns completion.
      () => lifetime.active() && readSequence.current === sequence && sliceRevision.current === revision,
      () => {
        const survives =
          opener?.isConnected && !opener.disabled && !opener.closest('[hidden], [inert], [aria-hidden="true"]');
        if (survives) return opener;
        const boundary = outcome === 'slice' ? sliceStatus.current : readFailure.current;
        return boundary?.closest('[hidden]') ? null : boundary;
      },
      () => complete,
    );
    running.current = true;
    setBusy(true);
    try {
      const value = await transport.read(
        key,
        next,
        session.current ?? (query.data?.ok ? query.data.session : undefined),
      );
      if (!lifetime.active()) return;
      if (!value.ok) {
        outcome = 'failure';
        setFailure(value);
        return;
      }
      setPage(value);
      session.current = value.session ?? session.current;
      cursor.current = next;
      setFailure(undefined);
      setPart([]);
    } catch {
      if (!lifetime.active()) return;
      outcome = 'failure';
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      complete = true;
      running.current = false;
      setBusy(false);
    }
  }
  function orientOpening(instance: number, opener: HTMLElement, keyboard: boolean) {
    focusAfterOpen.current?.cancel();
    focusAfterOpen.current = undefined;
    const document = opener.ownerDocument;
    if (!keyboard || document.activeElement !== opener) return;
    let moved = false;
    const cancel = () => {
      moved = true;
      document.removeEventListener('focusin', cancel);
    };
    document.addEventListener('focusin', cancel);
    focusAfterOpen.current = {
      instance,
      active: () =>
        !moved && slice.active() && lifetime.active() && opener.isConnected && document.activeElement === opener,
      cancel,
    };
  }
  function focusOpening(instance: number, heading: HTMLHeadingElement) {
    const intent = focusAfterOpen.current;
    if (!intent || intent.instance !== instance) return;
    focusAfterOpen.current = undefined;
    const admitted = intent.active();
    intent.cancel();
    if (admitted && heading.isConnected && !heading.closest('[hidden]')) heading.focus();
  }
  function open(row: PartRow, selected: PartStream, returnFocus: HTMLElement, keyboard: boolean) {
    if (!slice.active()) return;
    const correction = partCorrection(row, selected);
    if (!correction) return;
    const key = `${row.holder}:${row.statementId}`;
    const instance = drafts.find((draft) => draft.key === key)?.instance ?? ++nextDraftInstance.current;
    orientOpening(instance, returnFocus, keyboard);
    setDrafts((previous) =>
      previous.some((draft) => draft.key === key)
        ? [...previous]
        : [...previous, { ...correction, key, session: read?.session, instance, returnFocus, confirmClose: false }],
    );
  }
  function add(returnFocus: HTMLElement, keyboard: boolean) {
    if (!slice.active()) return;
    if (!stream || !part[0]) return;
    const holder = stream.direction === 'forward' ? id : part[0].id;
    const target = stream.direction === 'forward' ? part[0].id : id;
    const key = `${holder}:${stream.property}:${target}`;
    const instance = drafts.find((draft) => draft.key === key)?.instance ?? ++nextDraftInstance.current;
    orientOpening(instance, returnFocus, keyboard);
    setDrafts((previous) =>
      previous.some((draft) => draft.key === key)
        ? [...previous]
        : [
            ...previous,
            {
              key,
              id: holder,
              positionEditable: stream.positionEditable,
              session: read?.session,
              statement: {
                property: { id: stream.property, data_type: 'wikibase-item' },
                value: { type: 'value', content: target },
                qualifiers: [],
                references: [],
              },
              instance,
              returnFocus,
              confirmClose: true,
            },
          ],
    );
  }
  function closeDraft(instance: number) {
    setDrafts((previous) => {
      const closing = previous.find((draft) => draft.instance === instance);
      if (!closing) return previous;
      focusAfterClose.current = closing.returnFocus;
      return previous.filter((draft) => draft.instance !== instance);
    });
  }
  const failed =
    error?.reason === 'denied'
      ? m.candidate_denied({}, o)
      : error?.reason === 'stale'
        ? m.relation_stale({}, o)
        : error?.reason === 'invalid'
          ? m.candidate_invalid({}, o)
          : m.candidate_unavailable({}, o);
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={busy || query.isPending}
    >
      <ViewHeading label={m.work_parts_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.work_parts_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {concealed && (
        <p ref={readFailure} role="alert" tabIndex={-1}>
          {failed}
        </p>
      )}
      <div hidden={concealed} className="space-y-6">
        {read && (
          <>
            <a
              className={`${linkClassName} text-xl`}
              lang={title.lang ?? undefined}
              href={subjectHref({ id, label: title.text }, locale).href}
            >
              {title.text || m.subject_value_unlabelled({}, o)}
            </a>
            {!read.streams.length && (
              <p ref={sliceStatus} role="status" tabIndex={-1}>
                {m.work_parts_no_stream({}, o)}
              </p>
            )}
            {stream && (
              <>
                <Field>
                  <FieldLabel htmlFor={streamId}>{m.work_parts_relation({}, o)}</FieldLabel>
                  <NativeSelect
                    id={streamId}
                    className="min-w-0 max-w-full max-md:[&_select]:min-h-11 max-md:[&_select]:min-w-11 pointer-coarse:[&_select]:min-h-11 pointer-coarse:[&_select]:min-w-11"
                    value={stream.key}
                    disabled={busy}
                    onChange={(event) => void load(event.target.value)}
                  >
                    {read.streams.map((item) => (
                      <NativeSelectOption key={item.key} value={item.key} lang={item.label.lang ?? undefined}>
                        {item.label.text || m.subject_value_unlabelled({}, o)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <p ref={sliceStatus} role="status" tabIndex={-1}>
                  {m.work_parts_slice({}, o)}{' '}
                  {read.count &&
                    m.work_parts_count(
                      {
                        count: read.count.value,
                        accuracy: read.count.exact ? m.work_parts_exact({}, o) : m.work_parts_at_least({}, o),
                      },
                      o,
                    )}
                </p>
                {!read.caughtUp && <p role="status">{m.work_parts_pending({}, o)}</p>}
                {!stream.positionEditable && (
                  <p className="text-sm text-muted-foreground">{m.work_parts_order_readonly({}, o)}</p>
                )}
                {!read.rows.length && <p>{m.work_parts_empty({}, o)}</p>}
                <ul>
                  {read.rows.map((row, index) => (
                    <li
                      key={`${row.holder}:${row.statementId}`}
                      data-slot="list-row"
                      aria-labelledby={`${streamId}-part-${index}`}
                    >
                      <ContentItemFrame as="div" className="min-w-0 space-y-3 py-3 sm:py-4">
                        {row.summary && (
                          <ListRowLink
                            href={
                              subjectHref({ id: row.summary.id, label: row.summary.label?.value ?? '' }, locale).href
                            }
                            lang={row.summary.label?.language}
                            aria-labelledby={`${streamId}-part-${index}`}
                          >
                            {row.summary.label?.value || m.subject_value_unlabelled({}, o)}
                          </ListRowLink>
                        )}
                        <ContentItemHeading
                          id={`${streamId}-part-${index}`}
                          lang={row.summary?.label?.language}
                          className="font-sans text-[17px] leading-snug font-semibold whitespace-normal [overflow-wrap:anywhere] sm:text-lg md:text-xl"
                        >
                          {row.summary
                            ? row.summary.label?.value || m.subject_value_unlabelled({}, o)
                            : m.work_parts_unresolved({}, o)}
                        </ContentItemHeading>
                        <div
                          data-content-item-slot="preview"
                          className="min-w-0 space-y-3 text-sm leading-relaxed [&_a]:relative [&_a]:z-10 [&_a]:whitespace-normal [&_a]:[overflow-wrap:anywhere] [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_button]:relative [&_button]:z-10 [&_summary]:relative [&_summary]:z-10"
                        >
                          {row.statement ? (
                            <div className="space-y-3 text-sm">
                              <div>
                                <p
                                  lang={read.labels[row.statement.property.id]?.lang ?? undefined}
                                  className="text-muted-foreground"
                                >
                                  {read.labels[row.statement.property.id]?.text || m.subject_value_unlabelled({}, o)}
                                </p>
                                <CandidateValue snak={row.statement} related={row.related} locale={locale} />
                              </div>
                              {row.statement.qualifiers.map((snak, index) => (
                                <div key={index}>
                                  <p
                                    lang={read.labels[snak.property.id]?.lang ?? undefined}
                                    className="text-muted-foreground"
                                  >
                                    {read.labels[snak.property.id]?.text || m.subject_value_unlabelled({}, o)}
                                  </p>
                                  <CandidateValue snak={snak} related={row.related} locale={locale} />
                                </div>
                              ))}
                              <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
                                <h3 className="font-medium">{m.sources_citations({}, o)}</h3>
                                {row.statement.references.length ? (
                                  row.statement.references.map((reference, index) => (
                                    <div key={index} className="space-y-2">
                                      {reference.parts.length ? (
                                        reference.parts.map((snak, at) => (
                                          <div key={at}>
                                            <p
                                              lang={read.labels[snak.property.id]?.lang ?? undefined}
                                              className="text-muted-foreground"
                                            >
                                              {read.labels[snak.property.id]?.text || m.subject_value_unlabelled({}, o)}
                                            </p>
                                            <CandidateValue snak={snak} related={row.related} locale={locale} />
                                          </div>
                                        ))
                                      ) : (
                                        <p>{m.value_reference_unavailable({}, o)}</p>
                                      )}
                                    </div>
                                  ))
                                ) : (
                                  <p>{m.sources_no_citations({}, o)}</p>
                                )}
                              </section>
                              {partCorrection(row, stream) && (
                                <Button
                                  className={actionClassName}
                                  variant="outline"
                                  onClick={(event) => open(row, stream, event.currentTarget, event.detail === 0)}
                                >
                                  {m.work_parts_correct({}, o)}
                                </Button>
                              )}
                            </div>
                          ) : (
                            <p>{m.work_parts_assertion_unavailable({}, o)}</p>
                          )}
                          <details className="rounded-lg border border-border p-3 text-sm">
                            <summary className={summaryClassName}>{m.catalogue_technical_details({}, o)}</summary>
                            <dl className="mt-3 space-y-2 [&_dd]:break-all [&_dd]:font-mono [&_dd]:text-xs">
                              <div>
                                <dt>{m.work_parts_holder({}, o)}</dt>
                                <dd>{row.holder}</dd>
                              </div>
                              <div>
                                <dt>{m.work_parts_relation({}, o)}</dt>
                                <dd>{stream.property}</dd>
                              </div>
                              <div>
                                <dt>{m.catalogue_statement_id({}, o)}</dt>
                                <dd>{row.statementId}</dd>
                              </div>
                            </dl>
                            {row.statement && (
                              <pre className="mt-3 whitespace-pre-wrap break-all text-xs">
                                {JSON.stringify(row.statement, null, 2)}
                              </pre>
                            )}
                          </details>
                        </div>
                      </ContentItemFrame>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  {read.next && (
                    <Button
                      className={actionClassName}
                      variant="outline"
                      disabled={busy}
                      onClick={(event) => void load(stream.key, read.next ?? undefined, event)}
                    >
                      {m.work_parts_more({}, o)}
                    </Button>
                  )}
                  <Button
                    className={actionClassName}
                    variant="outline"
                    disabled={busy}
                    onClick={(event) => void load(stream.key, undefined, event)}
                  >
                    {m.work_parts_restart({}, o)}
                  </Button>
                </div>
                <section className="space-y-3 rounded-lg border border-border p-4">
                  <h2 className="font-sans text-lg font-semibold">{m.work_parts_add({}, o)}</h2>
                  <EntityPicker
                    label={m.work_parts_pick({}, o)}
                    search={search}
                    src={coverSrc}
                    value={part}
                    onValueChange={(items) => slice.active() && setPart(items)}
                  />
                  <Button
                    className={actionClassName}
                    variant="outline"
                    disabled={!part.length}
                    onClick={(event) => add(event.currentTarget, event.detail === 0)}
                  >
                    {m.work_parts_draft({}, o)}
                  </Button>
                </section>
              </>
            )}
            <details className="rounded-lg border border-border p-4 text-sm">
              <summary className={summaryClassName}>{m.catalogue_technical_details({}, o)}</summary>
              <dl className="mt-3 space-y-2 [&_dd]:break-all [&_dd]:font-mono [&_dd]:text-xs">
                <div>
                  <dt>{m.creator_editions_subject({}, o)}</dt>
                  <dd>{id}</dd>
                </div>
                <div>
                  <dt>{m.catalogue_create_type({}, o)}</dt>
                  <dd>{read.public.subject.type}</dd>
                </div>
                {read.streams.map((item) => (
                  <div key={item.key}>
                    <dt lang={item.label.lang ?? undefined}>{item.label.text || m.subject_value_unlabelled({}, o)}</dt>
                    <dd>{item.key}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </>
        )}
        {drafts.map((draft) => (
          <section key={draft.instance} className="space-y-3 border-t border-border pt-6">
            <details className="text-sm">
              <summary className={summaryClassName}>{m.catalogue_technical_details({}, o)}</summary>
              <p className="mt-3 break-all">
                {m.work_parts_holder({}, o)}: <code>{draft.id}</code>
              </p>
            </details>
            <RelationEditor
              id={draft.id}
              locale={locale}
              transport={transport.relation(draft.id)}
              search={search}
              composition={draft}
              requireCloseConfirmation={draft.confirmClose}
              onOpeningFocus={(heading) => focusOpening(draft.instance, heading)}
              onClose={() => closeDraft(draft.instance)}
              onSelected={() => load(stream?.key, cursor.current)}
            />
          </section>
        ))}
      </div>
      {(read || concealed) && (
        <Button
          className={actionClassName}
          variant="outline"
          disabled={busy}
          onClick={(event) => void load(stream?.key, cursor.current, event)}
        >
          {m.candidate_reload({}, o)}
        </Button>
      )}
    </article>
  );
}
