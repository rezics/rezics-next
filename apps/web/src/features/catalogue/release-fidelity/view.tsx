import { CatalogueCurrentReading, catalogueEditor, useEditorLifetime } from '../editor-lifetime';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowLink } from '@rezics/ui/list-row';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { CandidateValue } from '../../pages/data';
import { ViewHeading } from '../../pages/view-heading';
import { subjectHref } from '../../../subject/subject-href';
import type { CandidateTransport } from '../../../subject/candidate-review';
import {
  relationDraft,
  validRelationSlot,
  type RelationTransport,
  type RelationSlot,
} from '../../../subject/relation-candidates';
import { m } from '../../../paraglide/messages.js';
import { EditorFailure, PartValue } from '../statement-editor-view';
import { RelationEditor } from '../relation-editor';
import { SubjectFacts } from '../subject-facts-view';
import type { FactsTransport } from '../subject-facts';
import { useConsentFocus } from '../statement-consent-focus';
import { catalogueEntries } from '../catalogue-entry';
import { PublicationEditorEntry } from '../publication-editor-entry';
import { SubjectChangesLink } from '../subject-changes-link';
import { useCatalogueEditorNavigation } from '../publication-editor-navigation';
import { fileProfileReleased, relatedTarget, scalarFields, type ReleaseStream } from './model';
import { type ReleaseFidelityRead, type ReleaseRow } from './read';

export type ReleaseFidelityTransport = {
  read: (stream?: string, cursor?: string, detail?: string, session?: string) => Promise<ReleaseFidelityRead>;
  facts: FactsTransport;
  relation: (holder: string) => RelationTransport;
  review: (property: string, session?: string) => CandidateTransport;
};

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';
const summaryClass =
  'cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';

function rowTarget(row: ReleaseRow): string | undefined {
  return row.statement ? (relatedTarget(row.statement) ?? row.holder) : row.holder;
}

function relationSlot(row: ReleaseRow, stream: ReleaseStream): RelationSlot | undefined {
  if (!row.statement) return;
  const statement = relationDraft(row.statement);
  const key = stream.property;
  const target = relatedTarget(row.statement);
  const external = statement.qualifiers.find((part) => part.property.id === 'schema:sameAs');
  const slot: RelationSlot = {
    property: stream.property,
    ...(target
      ? { target }
      : statement.value.type === 'somevalue' &&
          external?.value.type === 'value' &&
          typeof external.value.content === 'string'
        ? { sameAs: external.value.content }
        : {}),
  };
  return slot.property === key && validRelationSlot(slot) ? slot : undefined;
}

export const ReleaseFidelityPage = catalogueEditor(ReleaseFidelityLive);

function ReleaseFidelityLive({
  id,
  locale,
  transport,
  search,
  initialReview,
}: {
  id: string;
  locale: string;
  transport: ReleaseFidelityTransport;
  search: EntityPickerSearch;
  initialReview?: { property: string; candidate: string } | undefined;
}) {
  const headingId = useId();
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['release-fidelity', id, locale], lifetime.generation],
    queryFn: () => transport.read(),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [page, setPage] = useState<Extract<ReleaseFidelityRead, { ok: true }>>();
  const [failure, setFailure] = useState<Extract<ReleaseFidelityRead, { ok: false }>>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{
    holder: string;
    slot: RelationSlot;
    statement: ReturnType<typeof relationDraft>;
    session?: string;
  }>();
  const session = useRef<string | undefined>(undefined);
  const cursor = useRef<string | undefined>(undefined);
  const streamKey = useRef<string | undefined>(undefined);
  const detailId = useRef<string | undefined>(undefined);
  const sliceRevision = useRef(0);
  const running = useRef(false);
  const readSequence = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const readFailure = useRef<HTMLParagraphElement>(null);
  const sliceStatus = useRef<HTMLParagraphElement>(null);
  const readFocus = useConsentFocus();
  const slice = useCatalogueLifetime(
    JSON.stringify([streamKey.current, cursor.current, detailId.current, sliceRevision.current]),
    lifetime,
  );
  const read = page ?? (query.data?.ok ? query.data : undefined);
  const error = failure ?? (!page && query.data && !query.data.ok ? query.data : undefined);
  const readable = !!read && !error && !query.isFetching;
  if (read?.session) session.current = read.session;
  const blocker = useCatalogueEditorNavigation(() => !!draft);
  async function load(
    next?: { stream?: string | undefined; cursor?: string | undefined; detail?: string | undefined },
    event?: MouseEvent<HTMLButtonElement>,
  ) {
    if (!slice.active()) return;
    readFocus.cancel();
    if (running.current) return;
    const key = next?.stream ?? streamKey.current ?? read?.stream?.key;
    const continuation = next && 'cursor' in next ? next.cursor : cursor.current;
    const selected = next && 'detail' in next ? next.detail : detailId.current;
    if (key !== streamKey.current || continuation !== cursor.current || selected !== detailId.current) {
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
      const value = await transport.read(key, continuation, selected, session.current);
      if (!lifetime.active()) return;
      if (!value.ok) {
        outcome = 'failure';
        setFailure(value);
        return;
      }
      setPage(value);
      session.current = value.session ?? session.current;
      streamKey.current = value.stream?.key;
      cursor.current = continuation;
      detailId.current = selected;
      setFailure(undefined);
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
  useLayoutEffect(() => {
    if (query.data?.ok && !page) {
      setPage(query.data);
      streamKey.current = query.data.stream?.key;
      session.current = query.data.session;
    }
  }, [query.data, page]);
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const href = subjectHref({ id, label: title.text }, locale).href;
  const workHref =
    read?.work.id && read.work.readability === 'readable'
      ? subjectHref({ id: read.work.id, label: read.work.label?.text ?? '' }, locale).href
      : undefined;
  return (
    <section className="flex flex-col gap-4" data-slot="release-fidelity" aria-busy={busy}>
      {!readable && (
        <div className="flex flex-col gap-4 p-6">
          <ViewHeading label={m.release_fidelity_title({}, o)} headingClassName="font-sans" headingRef={heading} />
          {query.isError || error?.reason === 'unavailable' ? (
            <EditorFailure reason="unavailable" locale={locale} />
          ) : error ? (
            <p ref={readFailure} tabIndex={-1} role="status">
              {error.reason === 'denied'
                ? m.release_fidelity_concealed({}, o)
                : error.reason === 'invalid'
                  ? m.release_fidelity_not_release({}, o)
                  : m.release_fidelity_concealed({}, o)}
            </p>
          ) : (
            <p role="status">{m.candidate_loading({}, o)}</p>
          )}
          <button
            type="button"
            className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`}
            onClick={(event) => void load({}, event)}
          >
            {m.release_fidelity_reload({}, o)}
          </button>
        </div>
      )}
      {read && (
        <CatalogueCurrentReading visible={readable} ready={readable} revision={`${lifetime.generation}:${read.digest}`}>
          <div hidden={!readable} className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-6 p-4 sm:p-6">
            <ViewHeading
              label={m.release_fidelity_title({}, o)}
              headingClassName="font-sans"
              headingRef={heading}
              headingTabIndex={-1}
            />
            <p className="text-muted-foreground">{m.release_fidelity_intro({}, o)}</p>
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span lang={title.lang ?? undefined}>
                <a href={href} className={linkClass}>
                  {title.text || m.subject_value_unlabelled({}, o)}
                </a>
              </span>
              <span
                lang={pickText(read.release.types[read.public.subject.type]?.labels ?? {}, locale).lang ?? undefined}
              >
                {pickText(read.release.types[read.public.subject.type]?.labels ?? {}, locale).text}
              </span>
            </p>
            <section className="space-y-2" data-slot="release-work">
              <ContentItemHeading level={2} className="text-lg font-semibold">
                {m.release_fidelity_work({}, o)}
              </ContentItemHeading>
              {read.work.readability === 'absent' && <p>{m.release_fidelity_work_absent({}, o)}</p>}
              {read.work.readability === 'unreadable' && <p>{m.release_fidelity_work_unreadable({}, o)}</p>}
              {read.work.readability === 'concealed' && <p>{m.release_fidelity_work_concealed({}, o)}</p>}
              {workHref && (
                <a href={workHref} className={linkClass} lang={read.work.label?.lang ?? undefined}>
                  {read.work.label?.text || m.subject_value_unlabelled({}, o)}
                </a>
              )}
              {read.work.historical && (
                <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
              )}
              {workHref && <PublicationEditorEntry work={read.work.id!} locale={locale} />}
            </section>
            <section className="space-y-2" data-slot="release-date">
              <ContentItemHeading level={2} className="text-lg font-semibold">
                {m.release_fidelity_date({}, o)}
              </ContentItemHeading>
              <p>
                {read.date.kind === 'tba'
                  ? m.release_fidelity_date_tba({}, o)
                  : read.date.kind === 'absent'
                    ? m.release_fidelity_date_absent({}, o)
                    : read.date.kind === 'none'
                      ? m.release_fidelity_date_none({}, o)
                      : read.date.kind === 'partial'
                        ? m.release_fidelity_date_partial({ value: read.date.text ?? '' }, o)
                        : (read.date.text ?? m.release_fidelity_date_absent({}, o))}
              </p>
              {read.date.historical && (
                <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
              )}
              {!read.statusProperty && <p>{m.release_fidelity_status_unavailable({}, o)}</p>}
              {!read.regionProperty && <p>{m.release_fidelity_region_unavailable({}, o)}</p>}
            </section>
            {(['classification', 'credits', 'identifiers', 'facts'] as const).map((group) =>
              read.facts[group]?.length ? (
                <section key={group} className="space-y-3" data-slot={`release-${group}`}>
                  <ContentItemHeading level={2} className="text-lg font-semibold">
                    {group === 'classification'
                      ? m.release_fidelity_classification({}, o)
                      : group === 'credits'
                        ? m.release_fidelity_credits({}, o)
                        : group === 'identifiers'
                          ? m.release_fidelity_identifiers({}, o)
                          : m.release_fidelity_facts({}, o)}
                  </ContentItemHeading>
                  {read.facts[group]!.map((fact) => (
                    <ContentItemFrame key={fact.property} as="div" className="min-w-0 space-y-2 p-4">
                      <p lang={fact.label.lang ?? undefined} className="text-sm text-muted-foreground">
                        {fact.label.text}
                      </p>
                      {fact.statements.map((statement) => (
                        <div key={statement.id} className="space-y-2">
                          <PartValue part={statement} read={read} locale={locale} />
                          {statement.qualifiers.map((part, index) => (
                            <div key={index} className="text-sm">
                              <PartValue part={part} read={read} locale={locale} />
                            </div>
                          ))}
                          {historicalNote(statement.rezics.release !== read.digest, o)}
                        </div>
                      ))}
                    </ContentItemFrame>
                  ))}
                </section>
              ) : null,
            )}
            <section className="space-y-2" data-slot="release-sources">
              <ContentItemHeading level={2} className="text-lg font-semibold">
                {m.release_fidelity_sources({}, o)}
              </ContentItemHeading>
              {!read.sources.length && <p>{m.sources_no_citations({}, o)}</p>}
              <ul className="space-y-2">
                {read.sources.map((source) => (
                  <li key={source.url} className="min-w-0">
                    <a href={source.url} className={linkClass} rel="nofollow">
                      {source.name}
                    </a>
                    {source.licence?.id && (
                      <p className="text-sm text-muted-foreground">
                        {source.licence.id}
                        {source.attribution ? ` · ${source.attribution}` : ''}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <a href={`${href}/sources`} className={linkClass}>
                {m.subject_sources({}, o)}
              </a>
            </section>
            <section className="space-y-3" data-slot="release-related">
              <ContentItemHeading level={2} className="text-lg font-semibold">
                {m.release_fidelity_related({}, o)}
              </ContentItemHeading>
              {!read.streams.length && <p>{m.release_fidelity_related_empty({}, o)}</p>}
              {read.streams.length > 0 && (
                <Field className="min-w-0">
                  <FieldLabel htmlFor={`${headingId}-stream`}>{m.release_fidelity_related({}, o)}</FieldLabel>
                  <NativeSelect
                    id={`${headingId}-stream`}
                    value={read.stream?.key ?? ''}
                    onChange={(event) => {
                      streamKey.current = event.currentTarget.value;
                      cursor.current = undefined;
                      detailId.current = undefined;
                      void load({ stream: event.currentTarget.value, cursor: undefined, detail: undefined });
                    }}
                  >
                    {read.streams.map((item) => (
                      <NativeSelectOption key={item.key} value={item.key}>
                        {item.label.text || item.property}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <p ref={sliceStatus} tabIndex={-1} className="sr-only">
                {m.release_fidelity_related({}, o)}
              </p>
              {!read.rows.length && read.stream && <p>{m.release_fidelity_related_empty({}, o)}</p>}
              <ul className="space-y-3">
                {read.rows.map((row) => {
                  const target = rowTarget(row);
                  const summaryLabel = row.summary?.label?.value || m.subject_value_unlabelled({}, o);
                  const companion =
                    read.stream?.kind === 'file' && target
                      ? `${subjectHref({ id: target, label: summaryLabel }, locale).href}/file`
                      : target
                        ? `${subjectHref({ id: target, label: summaryLabel }, locale).href}/release`
                        : undefined;
                  return (
                    <li key={`${row.holder}:${row.statementId}`}>
                      <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
                        {row.summary && companion && (
                          <ListRowLink href={companion} lang={row.summary.label?.language}>
                            {summaryLabel}
                          </ListRowLink>
                        )}
                        <p>
                          {row.readability === 'concealed'
                            ? m.release_fidelity_concealed({}, o)
                            : row.readability === 'unreadable'
                              ? m.release_fidelity_work_unreadable({}, o)
                              : summaryLabel}
                        </p>
                        {row.statement && <CandidateValue snak={row.statement} related={row.related} locale={locale} />}
                        {row.provenance.map((code) => (
                          <p key={code} className="text-sm text-muted-foreground">
                            {m.release_fidelity_related_unknown({ code }, o)}
                          </p>
                        ))}
                        {row.historical && (
                          <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                        )}
                        {target && (
                          <Button
                            type="button"
                            variant="outline"
                            className={actionClass}
                            onClick={(event) => void load({ detail: target }, event)}
                          >
                            {m.release_fidelity_select_detail({}, o)}
                          </Button>
                        )}
                        {read.stream && relationSlot(row, read.stream) && row.statement && (
                          <Button
                            type="button"
                            variant="outline"
                            className={actionClass}
                            onClick={() =>
                              setDraft({
                                holder: row.holder,
                                slot: relationSlot(row, read.stream!)!,
                                statement: relationDraft(row.statement!),
                                ...(read.session ? { session: read.session } : {}),
                              })
                            }
                          >
                            {m.correction_title({}, o)}
                          </Button>
                        )}
                      </ContentItemFrame>
                    </li>
                  );
                })}
              </ul>
              {read.next && (
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  onClick={(event) => void load({ cursor: read.next ?? undefined }, event)}
                >
                  {m.release_fidelity_next({}, o)}
                </Button>
              )}
              {detailId.current && !read.detail && <p>{m.release_fidelity_detail_unavailable({}, o)}</p>}
              {read.detail && (
                <ContentItemFrame as="div" className="space-y-2 p-4" data-slot="release-detail">
                  <p lang={pickText(read.detail.subject.labels, locale).lang ?? undefined}>
                    {pickText(read.detail.subject.labels, locale).text || m.subject_value_unlabelled({}, o)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {pickText(read.release.types[read.detail.subject.type]?.labels ?? {}, locale).text ||
                      read.detail.subject.type}
                  </p>
                </ContentItemFrame>
              )}
            </section>
            {!fileProfileReleased(read.release) && (
              <p data-slot="release-files-unavailable">{m.release_fidelity_files_unavailable({}, o)}</p>
            )}
            {draft && (
              <RelationEditor
                id={draft.holder}
                locale={locale}
                search={search}
                transport={transport.relation(draft.holder)}
                composition={{
                  statement: draft.statement,
                  slot: draft.slot,
                  positionEditable: false,
                  ...(draft.session ? { session: draft.session } : {}),
                }}
              />
            )}
            {blocker.status === 'blocked' && (
              <div role="dialog" className="space-y-2 rounded-xl border p-4">
                <p>{m.release_fidelity_leave({}, o)}</p>
                <Button type="button" className={actionClass} onClick={() => blocker.reset?.()}>
                  {m.library_collection_draft_navigation_stay({}, o)}
                </Button>
                <Button type="button" variant="outline" className={actionClass} onClick={() => blocker.proceed?.()}>
                  {m.library_collection_draft_navigation_leave({}, o)}
                </Button>
              </div>
            )}
            <details className="space-y-3">
              <summary className={summaryClass}>{m.release_fidelity_current_edit({}, o)}</summary>
              <p>{m.release_fidelity_correction_review({}, o)}</p>
              <SubjectFacts
                initial={{ ok: true, public: read.public, release: read.release, source: null }}
                locale={locale}
                transport={transport.facts}
                review={transport.review}
                initialReview={initialReview}
                embedded
                profile={{
                  properties: (current) => scalarFields(current.release, current.public.subject.type),
                  title: m.release_fidelity_current_edit({}, o),
                  intro: m.release_fidelity_correction_review({}, o),
                  empty: m.release_fidelity_empty({}, o),
                  path: 'release',
                }}
              />
            </details>
            <nav className="flex flex-wrap gap-2" data-slot="release-return">
              {workHref && (
                <a href={workHref} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} ${actionClass}`}>
                  {m.release_fidelity_return({}, o)}
                </a>
              )}
              <a
                href={`${href}/changes`}
                className={`${buttonVariants({ variant: 'outline', size: 'sm' })} ${actionClass}`}
              >
                {catalogueEntries.changes({ id, title: title.text, locale }).label}
              </a>
              <SubjectChangesLink id={id} title={title.text} locale={locale} />
              <Button type="button" variant="outline" className={actionClass} onClick={(event) => void load({}, event)}>
                {m.release_fidelity_reload({}, o)}
              </Button>
            </nav>
          </div>
        </CatalogueCurrentReading>
      )}
    </section>
  );
}

function historicalNote(historical: boolean, o: { locale: never }) {
  return historical ? <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p> : null;
}
