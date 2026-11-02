import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useId, useLayoutEffect, useRef, useState } from 'react';
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
  const focusAfterClose = useRef<HTMLElement | undefined>(undefined);
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
  async function load(key = stream?.key, next?: string) {
    if (!slice.active()) return;
    if (running.current) return;
    if (key !== stream?.key || next !== cursor.current) {
      slice.retire();
      sliceRevision.current++;
    }
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
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  function open(row: PartRow, selected: PartStream, returnFocus: HTMLElement) {
    if (!slice.active()) return;
    const correction = partCorrection(row, selected);
    if (!correction) return;
    const key = `${row.holder}:${row.statementId}`;
    const instance = ++nextDraftInstance.current;
    setDrafts((previous) =>
      previous.some((draft) => draft.key === key)
        ? previous
        : [...previous, { ...correction, key, session: read?.session, instance, returnFocus, confirmClose: false }],
    );
  }
  function add(returnFocus: HTMLElement) {
    if (!slice.active()) return;
    if (!stream || !part[0]) return;
    const holder = stream.direction === 'forward' ? id : part[0].id;
    const target = stream.direction === 'forward' ? part[0].id : id;
    const key = `${holder}:${stream.property}:${target}`;
    const instance = ++nextDraftInstance.current;
    setDrafts((previous) =>
      previous.some((draft) => draft.key === key)
        ? previous
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
      {concealed && <p role="alert">{failed}</p>}
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
            {!read.streams.length && <p>{m.work_parts_no_stream({}, o)}</p>}
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
                <p role="status">
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
                                  onClick={(event) => open(row, stream, event.currentTarget)}
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
                      onClick={() => void load(stream.key, read.next ?? undefined)}
                    >
                      {m.work_parts_more({}, o)}
                    </Button>
                  )}
                  <Button
                    className={actionClassName}
                    variant="outline"
                    disabled={busy}
                    onClick={() => void load(stream.key)}
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
                    onClick={(event) => add(event.currentTarget)}
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
          onClick={() => void load(stream?.key, cursor.current)}
        >
          {m.candidate_reload({}, o)}
        </Button>
      )}
    </article>
  );
}
