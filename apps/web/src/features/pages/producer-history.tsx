import { catalogueEditor, useEditorLifetime } from '../catalogue/editor-lifetime';
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
import { CandidateValue } from './data';
import { ViewHeading } from './view-heading';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import type { RelationTransport, RelationDraft, RelationSlot } from '../../subject/relation-candidates';
import { m } from '../../paraglide/messages.js';
import { RelationEditor } from '../catalogue/relation-editor';
import { useConsentFocus } from '../catalogue/statement-consent-focus';
import {
  producerHistoryCorrection,
  type ProducerHistoryMeaning,
  type ProducerHistoryRead,
  type ProducerHistoryRow,
  type ProducerHistoryStream,
} from '../catalogue/producer-history';

export type ProducerHistoryTransport = {
  read: (stream?: string, cursor?: string, session?: string) => Promise<ProducerHistoryRead>;
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

const actionClass =
  'h-auto min-h-8 max-w-full whitespace-normal [overflow-wrap:anywhere] py-1.5 max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const linkClass =
  'block w-fit max-w-full font-sans font-semibold underline max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';

function meaningLabel(meaning: ProducerHistoryMeaning, locale: string) {
  const o = { locale: locale as never };
  return meaning === 'parent'
    ? m.producer_history_parent({}, o)
    : meaning === 'predecessor'
      ? m.producer_history_predecessor({}, o)
      : meaning === 'successor'
        ? m.producer_history_successor({}, o)
        : meaning === 'subsidiary'
          ? m.producer_history_subsidiary({}, o)
          : m.producer_history_credited_role({}, o);
}

export const ProducerHistoryPage = catalogueEditor(ProducerHistoryPageLive);

function ProducerHistoryPageLive({
  id,
  locale,
  transport,
  search,
  initial,
}: {
  id: string;
  locale: string;
  transport: ProducerHistoryTransport;
  search: EntityPickerSearch;
  initial?: ProducerHistoryRead | undefined;
}) {
  const streamId = useId();
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['producer-history', id, locale], lifetime.generation],
    queryFn: () => transport.read(),
    initialData: initial,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [page, setPage] = useState<Extract<ProducerHistoryRead, { ok: true }>>();
  const [failure, setFailure] = useState<Extract<ProducerHistoryRead, { ok: false }>>();
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<OpenDraft[]>([]);
  const [selected, setSelected] = useState('');
  const nextDraftInstance = useRef(0);
  const readFailure = useRef<HTMLParagraphElement>(null);
  const sliceStatus = useRef<HTMLParagraphElement>(null);
  const running = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const cursor = useRef<string | undefined>(undefined);
  const sliceRevision = useRef(0);
  const read = page ?? (query.data?.ok ? query.data : undefined);
  const error = failure ?? (!page && query.data && !query.data.ok ? query.data : undefined);
  const concealed = !!error || (!page && query.isError);
  const stream = read?.stream;
  const slice = useCatalogueLifetime(JSON.stringify([stream?.key, cursor.current, sliceRevision.current]), lifetime);
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const origin = subjectHref({ id, label: title.text }, locale).href;
  const [part, setPart] = useState<EntityPickerSubject[]>([]);
  const readFocus = useConsentFocus();
  const readSequence = useRef(0);
  const focusAfterClose = useRef<HTMLElement | undefined>(undefined);
  useLayoutEffect(() => {
    const target = focusAfterClose.current;
    if (!target) return;
    focusAfterClose.current = undefined;
    if (target.isConnected) target.focus();
  }, [drafts]);
  async function load(key = stream?.key, next?: string, event?: MouseEvent<HTMLButtonElement>) {
    if (!slice.active()) return;
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
      setSelected('');
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
  function open(row: ProducerHistoryRow, selectedStream: ProducerHistoryStream, returnFocus: HTMLElement) {
    if (!slice.active()) return;
    const correction = producerHistoryCorrection(row, selectedStream);
    if (!correction) return;
    const key = `${row.holder}:${row.statementId}`;
    const instance = drafts.find((draft) => draft.key === key)?.instance ?? ++nextDraftInstance.current;
    setDrafts((previous) =>
      previous.some((draft) => draft.key === key)
        ? [...previous]
        : [...previous, { ...correction, key, session: read?.session, instance, returnFocus, confirmClose: false }],
    );
  }
  function add(returnFocus: HTMLElement) {
    if (!slice.active() || !stream || !part[0]) return;
    const holder = stream.direction === 'forward' ? id : part[0].id;
    const target = stream.direction === 'forward' ? part[0].id : id;
    const key = `${holder}:${stream.property}:${target}`;
    const instance = drafts.find((draft) => draft.key === key)?.instance ?? ++nextDraftInstance.current;
    setDrafts((previous) =>
      previous.some((draft) => draft.key === key)
        ? [...previous]
        : [
            ...previous,
            {
              key,
              id: holder,
              positionEditable: false,
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
        ? m.producer_history_stale({}, o)
        : error?.reason === 'invalid'
          ? m.candidate_invalid({}, o)
          : m.producer_history_concealed({}, o);
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={busy || query.isPending}
    >
      <ViewHeading label={m.producer_history_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.producer_history_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {concealed && (
        <p ref={readFailure} role="alert" tabIndex={-1}>
          {failed}
        </p>
      )}
      <div hidden={concealed} className="space-y-6">
        {read && (
          <>
            <a className={`${linkClass} text-xl`} lang={title.lang ?? undefined} href={origin}>
              {title.text || m.subject_value_unlabelled({}, o)}
            </a>
            {!!read.unreleased.length && (
              <p role="status">
                {m.producer_history_unreleased({}, o)}{' '}
                {read.unreleased.map((item) => meaningLabel(item.meaning, locale)).join(' · ')}
              </p>
            )}
            {!read.streams.length && (
              <p ref={sliceStatus} role="status" tabIndex={-1}>
                {m.producer_history_no_stream({}, o)}
              </p>
            )}
            {stream && (
              <>
                <Field>
                  <FieldLabel htmlFor={streamId}>{m.producer_history_relation({}, o)}</FieldLabel>
                  <NativeSelect
                    id={streamId}
                    className="min-w-0 max-w-full max-md:[&_select]:min-h-11 pointer-coarse:[&_select]:min-h-11"
                    value={stream.key}
                    disabled={busy}
                    onChange={(event) => void load(event.target.value)}
                  >
                    {read.streams.map((item) => (
                      <NativeSelectOption key={item.key} value={item.key}>
                        {meaningLabel(item.meaning, locale)}
                        {item.label.text ? ` · ${item.label.text}` : ''}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <p ref={sliceStatus} role="status" tabIndex={-1}>
                  {meaningLabel(stream.meaning, locale)}
                </p>
                {!read.caughtUp && <p role="status">{m.producer_history_incomplete({}, o)}</p>}
                {!read.rows.length && <p>{m.producer_history_empty({}, o)}</p>}
                <ul>
                  {read.rows.map((row, index) => {
                    const stale = selected && selected !== row.statementId;
                    return (
                      <li key={`${row.holder}:${row.statementId}`} data-slot="list-row">
                        <ContentItemFrame as="div" className="min-w-0 space-y-3 py-3 sm:py-4">
                          {row.summary && (
                            <ListRowLink
                              href={`${subjectHref({ id: row.summary.id, label: row.summary.label?.value ?? '' }, locale).href}/producer`}
                              lang={row.summary.label?.language}
                              aria-labelledby={`${streamId}-org-${index}`}
                            >
                              {row.summary.label?.value || m.subject_value_unlabelled({}, o)}
                            </ListRowLink>
                          )}
                          <ContentItemHeading
                            id={`${streamId}-org-${index}`}
                            lang={row.summary?.label?.language}
                            className="font-sans text-[17px] leading-snug font-semibold sm:text-lg md:text-xl"
                          >
                            {row.summary
                              ? row.summary.label?.value || m.subject_value_unlabelled({}, o)
                              : m.producer_history_concealed({}, o)}
                          </ContentItemHeading>
                          {row.statement ? (
                            <div className="space-y-3 text-sm">
                              <CandidateValue snak={row.statement} related={row.related} locale={locale} />
                              {row.statement.qualifiers.map((snak, qualifier) => (
                                <div key={qualifier}>
                                  <p
                                    lang={read.labels[snak.property.id]?.lang ?? undefined}
                                    className="text-muted-foreground"
                                  >
                                    {read.labels[snak.property.id]?.text || m.producer_history_dates({}, o)}
                                  </p>
                                  <CandidateValue snak={snak} related={row.related} locale={locale} />
                                </div>
                              ))}
                              <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
                                <h3 className="font-medium">{m.producer_history_sources({}, o)}</h3>
                                {row.statement.references.length ? (
                                  row.statement.references.map((reference, referenceIndex) => (
                                    <div key={referenceIndex} className="space-y-2">
                                      {reference.parts.map((snak, at) => (
                                        <CandidateValue key={at} snak={snak} related={row.related} locale={locale} />
                                      ))}
                                    </div>
                                  ))
                                ) : (
                                  <p>{m.sources_no_citations({}, o)}</p>
                                )}
                              </section>
                              {producerHistoryCorrection(row, stream) && (
                                <Button
                                  className={actionClass}
                                  variant="outline"
                                  disabled={!!selected && selected !== row.statementId}
                                  onClick={(event) => {
                                    if (selected && selected !== row.statementId) return;
                                    setSelected(row.statementId);
                                    open(row, stream, event.currentTarget);
                                  }}
                                >
                                  {stale ? m.producer_history_stale({}, o) : m.producer_history_correct({}, o)}
                                </Button>
                              )}
                            </div>
                          ) : (
                            <p>{m.producer_history_concealed({}, o)}</p>
                          )}
                          <a className={actionClass + ' inline-flex items-center underline'} href={origin}>
                            {m.producer_history_return({}, o)}
                          </a>
                        </ContentItemFrame>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap gap-2">
                  {read.next && (
                    <Button
                      className={actionClass}
                      variant="outline"
                      disabled={busy}
                      onClick={(event) => void load(stream.key, read.next ?? undefined, event)}
                    >
                      {m.producer_history_more({}, o)}
                    </Button>
                  )}
                  <Button
                    className={actionClass}
                    variant="outline"
                    disabled={busy}
                    onClick={(event) => void load(stream.key, undefined, event)}
                  >
                    {m.candidate_reload({}, o)}
                  </Button>
                </div>
                <section className="space-y-3 rounded-lg border border-border p-4">
                  <h2 className="font-sans text-lg font-semibold">{m.producer_history_correct({}, o)}</h2>
                  <EntityPicker
                    label={m.producer_history_follow({}, o)}
                    search={search}
                    src={coverSrc}
                    value={part}
                    onValueChange={(items) => slice.active() && setPart(items)}
                  />
                  <Button
                    className={actionClass}
                    variant="outline"
                    disabled={!part.length}
                    onClick={(event) => add(event.currentTarget)}
                  >
                    {m.producer_history_draft({}, o)}
                  </Button>
                </section>
              </>
            )}
          </>
        )}
        {drafts.map((draft) => (
          <section key={draft.instance} className="space-y-3 border-t border-border pt-6">
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
    </article>
  );
}
