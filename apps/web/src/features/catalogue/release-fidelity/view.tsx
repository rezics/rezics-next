import { CatalogueCurrentReading, catalogueEditor, useEditorLifetime } from '../editor-lifetime';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useId, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
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
import { releaseVisitFromHash, releaseReturnHref, type ReleaseVisit } from './navigation';
import { subjectVisitReturn, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { SpoilerGate } from '../../pages/values';
import { spoilerLevel } from '../../pages/shared';
import { subjectHref } from '../../../subject/subject-href';
import { candidateContext } from '../../../subject/candidates';
import type { CandidateTransport } from '../../../subject/candidate-review';
import {
  relationDraft,
  validRelationSlot,
  type RelationTransport,
  type RelationSlot,
} from '../../../subject/relation-candidates';
import { m } from '../../../paraglide/messages.js';
import { EditorFailure } from '../statement-editor-view';
import { RelationEditor } from '../relation-editor';
import { SubjectFacts } from '../subject-facts-view';
import type { FactsTransport } from '../subject-facts';
import { useConsentFocus } from '../statement-consent-focus';
import { catalogueEntries } from '../catalogue-entry';
import { useCatalogueEditorNavigation } from '../publication-editor-navigation';
import { timePresentation } from '../../../subject/time-presentation';
import {
  fileProfileReleased,
  isReleaseType,
  relatedTarget,
  scalarFields,
  selectedStatements,
  type ReleaseStream,
} from './model';
import { type ReleaseFidelityRead, type ReleaseRow } from './read';
import { ReleaseDestination, ReleasePartValue as PartValue, ReleaseValueLink } from './reading/value';
import { ReleaseStatementEvidence } from './reading/detail';
import { ReleaseSelectedDetail } from './reading/detail';
import {
  admittedPage,
  admittedRow,
  occurrenceFor,
  pageIntent,
  rowTarget,
  returnReceipt,
  returnReceiptCurrent,
  selectionIntent,
  type ReleaseOccurrence,
  type ReleaseReadIntent,
  type ReleaseReadingState,
  type ReleaseReturnReceipt,
} from './reading/state';

export type ReleaseFidelityTransport = {
  read: (
    stream?: string,
    cursor?: string,
    detail?: string,
    session?: string,
    returning?: ReleaseVisit,
  ) => Promise<ReleaseFidelityRead>;
  facts: FactsTransport;
  relation: (holder: string, context?: string) => RelationTransport;
  review: (property: string, session?: string) => CandidateTransport;
};

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';
const summaryClass =
  'cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';

function relationSlot(row: ReleaseRow, stream: ReleaseStream, context: string): RelationSlot | undefined {
  if (!row.statement) return;
  const statement = relationDraft(row.statement);
  const key = stream.property;
  const target = relatedTarget(row.statement);
  const external = statement.qualifiers.find((part) => part.property.id === 'schema:sameAs');
  const slot: RelationSlot = {
    property: stream.property,
    context,
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
  context,
  locale,
  transport,
  search,
  initialReview,
  returnTo,
}: {
  id: string;
  context: string;
  locale: string;
  transport: ReleaseFidelityTransport;
  search: EntityPickerSearch;
  returnTo?: string | undefined;
  initialReview?: { property: string; candidate: string } | undefined;
}) {
  const headingId = useId();
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [returning] = useState(() => {
    const visit = typeof window === 'undefined' ? undefined : releaseVisitFromHash(window.location.hash);
    return visit?.id === id && visit.context === context ? visit : undefined;
  });
  const [returnNotice, setReturnNotice] = useState(false);
  const restoredFocus = useRef<ReleaseVisit | undefined>(undefined);
  const outgoing = useRef<ReleaseVisit | undefined>(undefined);
  const query = useQuery({
    queryKey: [...['release-fidelity', id, context, locale], lifetime.generation],
    queryFn: () =>
      transport.read(returning?.stream, returning?.cursor, returning?.occurrence?.target, undefined, returning),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [reader, setReader] = useState<ReleaseReadingState>({
    kind: 'loading-page',
    intent: { kind: 'page' },
    revision: 0,
  });
  const [draft, setDraft] = useState<{
    holder: string;
    slot: RelationSlot;
    statement: ReturnType<typeof relationDraft>;
    session?: string;
    receipt?: ReleaseReturnReceipt;
  }>();
  const sliceRevision = useRef(0);
  const readSequence = useRef(0);
  const [history, setHistory] = useState<import('./reading/state').ReleasePageAddress[]>([]);
  const movingBack = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const readFailure = useRef<HTMLParagraphElement>(null);
  const sliceStatus = useRef<HTMLParagraphElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const returnFocus = useRef<ReleaseReturnReceipt | undefined>(undefined);
  const clearFocus = useRef(false);
  const readFocus = useConsentFocus();
  const sliceKey = (() => {
    if (reader.kind === 'loading-page')
      return JSON.stringify(['page', reader.intent.stream, reader.intent.cursor, reader.revision]);
    if (reader.kind === 'loading-recovery') return JSON.stringify(['intent', reader.intent, reader.revision]);
    if (reader.kind === 'failed') return JSON.stringify(['failed', reader.intent, reader.revision]);
    return JSON.stringify([
      'admitted',
      reader.admitted.address.stream,
      reader.admitted.address.cursor,
      reader.admitted.address.digest,
      reader.admitted.address.revision,
      'selection' in reader ? reader.selection.key : undefined,
    ]);
  })();
  const slice = useCatalogueLifetime(sliceKey, lifetime);
  const priorPage = reader.kind === 'loading-page' ? reader.admitted : undefined;
  const admitted = 'admitted' in reader ? reader.admitted : undefined;
  const read = reader.kind === 'loading-recovery' || reader.kind === 'failed' ? undefined : admitted?.read;
  const selection = 'selection' in reader ? reader.selection : undefined;
  const selectedDetail = reader.kind === 'selected' ? reader.detail : undefined;
  const selectionState =
    reader.kind === 'loading-selection'
      ? 'loading'
      : reader.kind === 'selected'
        ? 'available'
        : reader.kind === 'selection-unavailable'
          ? 'unavailable'
          : reader.kind === 'selection-concealed'
            ? 'concealed'
            : reader.kind === 'selection-unreadable'
              ? 'unreadable'
              : reader.kind === 'selection-stale'
                ? 'stale'
                : undefined;
  const detailRow = admitted && selection ? admittedRow(admitted, selection) : undefined;
  const readFailureState = reader.kind === 'failed' ? reader.failure : undefined;
  const streamFailure =
    !!read?.stream && ['withheld', 'unsupported', 'unavailable', 'denied'].includes(read.streamState);
  const busy = query.isFetching || reader.kind.startsWith('loading');
  const readable =
    !!read && !readFailureState && !streamFailure && !query.isFetching && lifetime.active() && slice.active();
  const blocker = useCatalogueEditorNavigation(() => !!draft);
  async function startRead(
    intent: ReleaseReadIntent,
    event?: MouseEvent<HTMLButtonElement>,
    keepPage?: NonNullable<typeof admitted>,
    visit?: ReleaseVisit,
  ) {
    if (!lifetime.active() || !slice.active() || draft) return;
    readFocus.cancel();
    const revision = ++sliceRevision.current;
    const sequence = ++readSequence.current;
    slice.retire();
    const current = readerRef.current;
    const prior = keepPage ?? ('admitted' in current ? current.admitted : undefined);
    const retained = prior && !visit ? { ...prior, address: { ...prior.address, revision } } : undefined;
    const request: ReleaseReadIntent =
      intent.kind === 'selection'
        ? {
            kind: 'selection',
            page: {
              ...intent.page,
              revision,
              ...(retained?.address.session ? { session: retained.address.session } : {}),
            },
            selection: intent.selection,
          }
        : intent;
    if (request.kind === 'selection' && retained) {
      setReader({ kind: 'loading-selection', admitted: retained, selection: request.selection, revision });
    } else if (request.kind === 'page') {
      setReader({ kind: 'loading-page', intent: request, revision, ...(retained ? { admitted: retained } : {}) });
    } else {
      setReader({ kind: 'loading-recovery', intent: request, revision });
    }
    const opener = event?.currentTarget;
    let complete = false;
    let outcome: 'slice' | 'failure' = 'slice';
    if (event)
      readFocus.begin(
        event,
        () => lifetime.active() && readSequence.current === sequence && sliceRevision.current === revision,
        () => {
          const survives =
            opener?.isConnected && !opener.disabled && !opener.closest('[hidden], [inert], [aria-hidden="true"]');
          if (survives) return opener;
          const boundary =
            outcome === 'slice'
              ? request.kind === 'selection'
                ? (detailHeading.current ?? sliceStatus.current)
                : sliceStatus.current
              : readFailure.current;
          return boundary?.closest('[hidden]') ? null : boundary;
        },
        () => complete,
      );
    const stream = request.kind === 'page' ? request.stream : request.page.stream;
    const cursor = request.kind === 'page' ? request.cursor : request.page.cursor;
    const session = request.kind === 'page' ? request.session : request.page.session;
    const detail = request.kind === 'selection' ? request.selection.target : undefined;
    try {
      const value = await transport.read(
        stream,
        cursor,
        visit?.occurrence?.target ?? detail,
        visit ? undefined : session,
        visit,
      );
      if (!lifetime.active() || readSequence.current !== sequence || sliceRevision.current !== revision) return;
      if (value.ok && (value.public.subject.id !== id || value.public.subject.context !== context)) {
        outcome = 'failure';
        setReader({ kind: 'failed', intent: request, failure: { ok: false, reason: 'stale' }, revision });
        return;
      }
      if (!value.ok) {
        outcome = 'failure';
        setReader({ kind: 'failed', intent: request, failure: value, revision });
        return;
      }
      const fresh = admittedPage(
        value,
        value.returned === 'changed' ? { kind: 'page', stream: value.stream?.key } : request,
        revision,
      );
      if (visit) {
        setHistory([]);
        restoredFocus.current = visit;
        setReturnNotice(value.returned !== 'restored');
        setReader(restoredReading(fresh, value, visit));
        return;
      }
      if (request.kind === 'page') {
        const same =
          prior &&
          prior.read.digest === value.digest &&
          prior.read.public.subject.revision === value.public.subject.revision &&
          prior.address.stream === fresh.address.stream;
        if (!same || !request.cursor) setHistory([]);
        else if (!movingBack.current && prior.address.cursor !== request.cursor)
          setHistory((items) => [...items, { ...prior.address, session: undefined }].slice(-8));
        movingBack.current = false;
        setReader({ kind: 'page', admitted: fresh });
        return;
      }
      if (!admittedRow(fresh, request.selection)) {
        setReader({ kind: 'selection-stale', admitted: fresh, selection: request.selection });
      } else if (admittedRow(fresh, request.selection)?.readability !== 'readable') {
        setReader({ kind: 'selection-concealed', admitted: fresh, selection: request.selection });
      } else if (!value.detail) {
        setReader({ kind: 'selection-unavailable', admitted: fresh, selection: request.selection });
      } else if (
        value.detail.subject.id !== request.selection.target ||
        value.detail.subject.context !== value.public.subject.context ||
        !isReleaseType(value.release, value.detail.subject.type)
      ) {
        setReader({ kind: 'selection-stale', admitted: fresh, selection: request.selection });
      } else if (!Object.values(value.detail.subject.labels).some((label) => label.trim())) {
        setReader({ kind: 'selection-concealed', admitted: fresh, selection: request.selection });
      } else {
        setReader({ kind: 'selected', admitted: fresh, selection: request.selection, detail: value.detail });
      }
    } catch {
      if (!lifetime.active() || readSequence.current !== sequence || sliceRevision.current !== revision) return;
      if (request.kind === 'selection' && retained) {
        setReader({
          kind: 'selection-unavailable',
          admitted: retained,
          selection: request.selection,
        });
        return;
      }
      outcome = 'failure';
      setReader({ kind: 'failed', intent: request, failure: { ok: false, reason: 'unavailable' }, revision });
    } finally {
      if (lifetime.active() && readSequence.current === sequence && sliceRevision.current === revision) complete = true;
    }
  }
  function retryCurrent(event?: MouseEvent<HTMLButtonElement>) {
    const current = readerRef.current;
    if (current.kind === 'failed' || current.kind === 'loading-recovery') {
      void startRead(current.intent, event);
      return;
    }
    if (current.kind === 'loading-page') {
      void startRead(current.intent, event, current.admitted);
      return;
    }
    if (current.kind === 'loading-selection') {
      void startRead(selectionIntent(current.admitted.address, current.selection), event, current.admitted);
      return;
    }
    if ('admitted' in current && 'selection' in current) {
      void startRead(selectionIntent(current.admitted.address, current.selection), event, current.admitted);
      return;
    }
    if ('admitted' in current) void startRead(pageIntent(current.admitted.address), event, current.admitted);
  }
  function restart(event?: MouseEvent<HTMLButtonElement>) {
    outgoing.current = undefined;
    setReturnNotice(false);
    setHistory([]);
    if (typeof window !== 'undefined')
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    const current = readerRef.current;
    const intent = current.kind === 'failed' || current.kind === 'loading-recovery' ? current.intent : undefined;
    const address = 'admitted' in current ? current.admitted.address : undefined;
    const page = current.kind === 'loading-page' ? current.intent : undefined;
    const selected = intent?.kind === 'selection' ? intent.page : undefined;
    const stream =
      address?.stream ?? page?.stream ?? selected?.stream ?? (intent?.kind === 'page' ? intent.stream : undefined);
    const session =
      address?.session ?? page?.session ?? selected?.session ?? (intent?.kind === 'page' ? intent.session : undefined);
    void startRead({ kind: 'page', ...(stream ? { stream } : {}), ...(session ? { session } : {}) }, event);
  }
  function clearSelection() {
    const current = readerRef.current;
    if (!('admitted' in current) || draft) return;
    readFocus.cancel();
    const revision = ++sliceRevision.current;
    readSequence.current++;
    slice.retire();
    setReader({ kind: 'page', admitted: { ...current.admitted, address: { ...current.admitted.address, revision } } });
    clearFocus.current = true;
  }
  function inspect(row: ReleaseRow, event: MouseEvent<HTMLButtonElement>) {
    if (!read?.stream || read.stream.kind !== 'release' || row.readability !== 'readable') return;
    const occurrence = occurrenceFor(row, read.stream);
    if (!occurrence || !admitted) return;
    void startRead(selectionIntent(admitted.address, occurrence), event, admitted);
  }
  function correctSelected(occurrence: ReleaseOccurrence) {
    if (!admitted || !read?.stream) return;
    const row = admittedRow(admitted, occurrence);
    if (row?.readability !== 'readable') return;
    const slot = row && relationSlot(row, read.stream, read.public.subject.context);
    if (!row?.statement || !slot) return;
    setDraft({
      holder: row.holder,
      slot,
      statement: relationDraft(row.statement),
      ...(read.session ? { session: read.session } : {}),
      receipt: returnReceipt(admitted, occurrence),
    });
  }
  function closeCorrection() {
    const receipt = draft?.receipt;
    if (receipt && lifetime.active() && returnReceiptCurrent(readerRef.current, receipt)) returnFocus.current = receipt;
    setDraft(undefined);
  }
  useLayoutEffect(() => {
    if (query.data) {
      const current = readerRef.current;
      if (current.kind !== 'loading-page' || current.revision !== 0) return;
      if (query.data.ok && (query.data.public.subject.id !== id || query.data.public.subject.context !== context)) {
        setReader({ kind: 'failed', intent: current.intent, failure: { ok: false, reason: 'stale' }, revision: 0 });
      } else if (query.data.ok) {
        const intent: ReleaseReadIntent =
          returning && query.data.returned === 'restored'
            ? { kind: 'page', stream: returning.stream, cursor: returning.cursor }
            : current.intent;
        const page = admittedPage(query.data, intent, 0);
        if (returning) {
          restoredFocus.current = returning;
          setReturnNotice(query.data.returned !== 'restored');
          setReader(restoredReading(page, query.data, returning));
        } else setReader({ kind: 'page', admitted: page });
      } else setReader({ kind: 'failed', intent: current.intent, failure: query.data, revision: 0 });
    } else if (query.isError) {
      const current = readerRef.current;
      if (current.kind === 'loading-page' && current.revision === 0)
        setReader({
          kind: 'failed',
          intent: current.intent,
          failure: { ok: false, reason: 'unavailable' },
          revision: 0,
        });
    }
  }, [query.data, query.isError]);
  useLayoutEffect(() => {
    if (clearFocus.current) {
      clearFocus.current = false;
      if (lifetime.active() && !draft) listHeading.current?.focus();
    }
    const receipt = returnFocus.current;
    if (receipt) {
      returnFocus.current = undefined;
      if (lifetime.active() && returnReceiptCurrent(readerRef.current, receipt)) detailHeading.current?.focus();
    }
  }, [reader, draft, lifetime]);
  useEffect(() => {
    const resume = () => {
      const visit = outgoing.current ?? releaseVisitFromHash(window.location.hash);
      if (!visit || visit.id !== id || visit.context !== context || !lifetime.active()) return;
      outgoing.current = undefined;
      void startRead({ kind: 'page', stream: visit.stream, cursor: visit.cursor }, undefined, undefined, visit);
    };
    const visible = () => {
      if (document.visibilityState === 'visible' && outgoing.current) resume();
    };
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) resume();
    };
    window.addEventListener('pageshow', shown);
    window.addEventListener('popstate', resume);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('pageshow', shown);
      window.removeEventListener('popstate', resume);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  });
  useLayoutEffect(() => {
    const visit = restoredFocus.current;
    if (!visit || !readable) return;
    restoredFocus.current = undefined;
    const row = visit.occurrence && admitted && admittedRow(admitted, visit.occurrence);
    if (row?.readability === 'readable' && !returnNotice) {
      const selected = document.querySelector<HTMLElement>('[data-selected-occurrence] button');
      if (selected) {
        selected.focus();
        return;
      }
    }
    if (visit.focus === 'work' && !returnNotice) workHeading.current?.focus();
    else if (visit.focus === 'sources' && !returnNotice) sourcesHeading.current?.focus();
    else listHeading.current?.focus();
  }, [reader, readable, returnNotice]);
  const workHeading = useRef<HTMLHeadingElement>(null);
  const sourcesHeading = useRef<HTMLHeadingElement>(null);
  function visitDescriptor(focus: ReleaseVisit['focus'], occurrence = selection): ReleaseVisit | undefined {
    if (!read || !admitted || !readable) return;
    const row = occurrence && admittedRow(admitted, occurrence);
    return {
      id,
      context,
      digest: read.digest,
      revision: read.public.subject.revision,
      stream: admitted.address.stream,
      cursor: admitted.address.cursor,
      focus,
      ...(occurrence && row?.statement && row.readability === 'readable'
        ? { occurrence: { ...occurrence, revision: row.statement.rezics.revision } }
        : {}),
    };
  }
  function destination(
    base: string,
    kind: 'subject' | 'release' | 'file' | 'sources' | 'changes',
    focus: ReleaseVisit['focus'],
    occurrence = selection,
  ) {
    // Only the native release companion accepts a Context override. Other owners expose Global or Realm selection.
    if (context !== candidateContext && kind !== 'release') return;
    const visit = visitDescriptor(focus, occurrence);
    const back = visit && releaseReturnHref(pickText(read?.public.subject.labels ?? {}, locale).text, locale, visit);
    if (!back) return;
    const url = new URL(base, 'https://rezics.invalid');
    if (kind === 'release') url.searchParams.set('context', context);
    return withSubjectVisitReturn(`${url.pathname}${url.search}`, back, locale);
  }
  function rememberDeparture(href: string) {
    const back = new URL(href, 'https://rezics.invalid').searchParams.get('via');
    const visit = back && releaseVisitFromHash(new URL(back, 'https://rezics.invalid').hash);
    if (!visit || !lifetime.active()) return;
    outgoing.current = visit;
    const fragment = new URL(back!, 'https://rezics.invalid').hash;
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}${fragment}`,
    );
  }
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const dateStatement = read?.date.statementId
    ? read.public.subject.statements['schema:datePublished']?.find(
        (statement) => statement.id === read.date.statementId,
      )
    : undefined;
  const datePresentation = dateStatement ? timePresentation(dateStatement.value, locale) : undefined;
  const href = subjectHref({ id, label: title.text }, locale).href;
  const workHref =
    read?.work.id && read.work.readability === 'readable'
      ? destination(
          subjectHref({ id: read.work.id, label: read.work.label?.text ?? '' }, locale).href,
          'subject',
          'work',
        )
      : undefined;
  const selectedSlot =
    detailRow && read?.stream ? relationSlot(detailRow, read.stream, read.public.subject.context) : undefined;
  return (
    <ReleaseDestination.Provider value={(base) => destination(base, 'subject', 'related')}>
      <section
        className="flex flex-col gap-4"
        data-slot="release-fidelity"
        aria-busy={busy}
        onClickCapture={(event) => {
          const anchor = (event.target as Element).closest?.('a');
          const target = anchor?.getAttribute('href');
          if (target && anchor?.hasAttribute('href')) rememberDeparture(target);
        }}
      >
        <p className="px-6 pt-4 break-words" data-slot="release-context">
          {m.context_title({}, o)}: {context === candidateContext ? m.subject_context_global({}, o) : context}
        </p>
        {returnTo && (
          <a className={linkClass} href={subjectVisitReturn(returnTo, locale)}>
            {m.release_fidelity_origin({}, o)}
          </a>
        )}
        {returnNotice && (
          <p role="status" className="px-6">
            {m.release_fidelity_visit_changed({}, o)}
          </p>
        )}
        {!readable && (
          <div className="flex flex-col gap-4 p-6">
            <ViewHeading label={m.release_fidelity_title({}, o)} headingClassName="font-sans" headingRef={heading} />
            {reader.kind === 'failed' ? (
              reader.failure.reason === 'unavailable' ? (
                <div ref={readFailure} tabIndex={-1} role="status">
                  <EditorFailure reason="unavailable" locale={locale} />
                </div>
              ) : (
                <p ref={readFailure} tabIndex={-1} role="status">
                  {reader.failure.reason === 'denied'
                    ? m.release_fidelity_concealed({}, o)
                    : reader.failure.reason === 'invalid'
                      ? m.release_fidelity_not_release({}, o)
                      : reader.intent.kind === 'selection'
                        ? m.release_fidelity_selection_stale({}, o)
                        : m.release_fidelity_related_unavailable({}, o)}
                </p>
              )
            ) : streamFailure ? (
              <p ref={readFailure} tabIndex={-1} role="status">
                {read?.streamState === 'denied'
                  ? m.release_fidelity_related_denied({}, o)
                  : read?.streamState === 'withheld'
                    ? m.release_fidelity_related_withheld({}, o)
                    : read?.streamState === 'unsupported'
                      ? m.release_fidelity_related_unsupported({}, o)
                      : m.release_fidelity_related_unavailable({}, o)}
              </p>
            ) : (
              <p ref={readFailure} tabIndex={-1} role="status">
                {m.candidate_loading({}, o)}
              </p>
            )}
            {(priorPage || (streamFailure && admitted)) && (
              <Field className="min-w-0">
                <FieldLabel htmlFor={`${headingId}-recovery-stream`}>{m.release_fidelity_related({}, o)}</FieldLabel>
                <NativeSelect
                  id={`${headingId}-recovery-stream`}
                  value={
                    reader.kind === 'loading-page'
                      ? (reader.intent.stream ?? '')
                      : (read?.stream?.key ?? priorPage?.read.stream?.key ?? '')
                  }
                  disabled={!!draft}
                  onChange={(event) => {
                    const source = priorPage ?? admitted;
                    void startRead(
                      {
                        kind: 'page',
                        stream: event.currentTarget.value,
                        ...(source?.address.session ? { session: source.address.session } : {}),
                      },
                      undefined,
                      source,
                    );
                  }}
                >
                  {(priorPage?.read.streams ?? read?.streams ?? []).map((item) => (
                    <NativeSelectOption key={item.key} value={item.key}>
                      {item.label.text || item.property}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <a href={destination(href, 'subject', 'related')} className={linkClass}>
              {m.release_fidelity_origin({}, o)}
            </a>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                disabled={busy || !!draft}
                onClick={(event) => retryCurrent(event)}
              >
                {m.release_fidelity_reload({}, o)}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={actionClass}
                disabled={busy || !!draft}
                onClick={(event) => restart(event)}
              >
                {m.release_fidelity_restart({}, o)}
              </Button>
            </div>
          </div>
        )}
        {read && (
          <CatalogueCurrentReading
            visible={readable}
            ready={readable}
            revision={`${lifetime.generation}:${read.digest}`}
          >
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
                  <a href={destination(href, 'subject', 'related')} className={linkClass}>
                    {title.text || m.subject_value_unlabelled({}, o)}
                  </a>
                </span>
                <span
                  lang={pickText(read.release.types[read.public.subject.type]?.labels ?? {}, locale).lang ?? undefined}
                >
                  {pickText(read.release.types[read.public.subject.type]?.labels ?? {}, locale).text}
                </span>
              </p>
              <ReleaseStatementGate
                statement={selectedStatements(read.public.subject.statements['schema:exampleOfWork'])[0]}
                locale={locale}
              >
                <section className="space-y-2" data-slot="release-work">
                  <h2 ref={workHeading} tabIndex={-1} className="text-lg font-semibold">
                    {m.release_fidelity_work({}, o)}
                  </h2>
                  {read.work.readability === 'absent' && <p>{m.release_fidelity_work_absent({}, o)}</p>}
                  {read.work.readability === 'unreadable' && <p>{m.release_fidelity_work_unreadable({}, o)}</p>}
                  {read.work.readability === 'concealed' && <p>{m.release_fidelity_work_concealed({}, o)}</p>}
                  {workHref && (
                    <a href={workHref} className={linkClass} lang={read.work.label?.lang ?? undefined}>
                      {read.work.label?.text || m.subject_value_unlabelled({}, o)}
                    </a>
                  )}
                  {read.work.readability === 'readable' && !workHref && (
                    <p lang={read.work.label?.lang ?? undefined}>{read.work.label?.text}</p>
                  )}
                  {read.work.historical && (
                    <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                  )}
                  {read.work.completeness && (
                    <p data-slot="release-completeness" lang={read.work.completeness.label?.lang ?? undefined}>
                      {read.work.completeness.label?.text || m.release_fidelity_related_unreadable({}, o)}
                    </p>
                  )}
                  {read.work.readability === 'readable' && !workHref && (
                    <p role="status">{m.release_fidelity_visit_unsupported({}, o)}</p>
                  )}
                  {read.work.readability === 'readable' &&
                    selectedStatements(read.public.subject.statements['schema:exampleOfWork']).map((statement) => (
                      <ReleaseStatementEvidence
                        key={statement.id}
                        statement={statement}
                        read={{ release: read.release, public: { related: read.public.related } }}
                        locale={locale}
                      />
                    ))}
                </section>
              </ReleaseStatementGate>
              <section className="space-y-2" data-slot="release-date">
                <ContentItemHeading level={2} className="text-lg font-semibold">
                  {m.release_fidelity_date({}, o)}
                </ContentItemHeading>
                <p>
                  {read.date.kind === 'tba' ? (
                    m.release_fidelity_date_tba({}, o)
                  ) : read.date.kind === 'absent' ? (
                    m.release_fidelity_date_absent({}, o)
                  ) : datePresentation?.state === 'supported' ? (
                    datePresentation.structuredDate ? (
                      <time dateTime={datePresentation.structuredDate}>{datePresentation.text}</time>
                    ) : (
                      datePresentation.text
                    )
                  ) : datePresentation ? (
                    datePresentation.text
                  ) : read.date.kind === 'none' ? (
                    m.release_fidelity_date_none({}, o)
                  ) : read.date.kind === 'invalid' ? (
                    m.release_fidelity_date_invalid({}, o)
                  ) : read.date.kind === 'unsupported' ? (
                    m.release_fidelity_date_unsupported({}, o)
                  ) : (
                    (read.date.text ?? m.release_fidelity_date_absent({}, o))
                  )}
                </p>
                {read.date.historical && (
                  <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                )}
                {dateStatement && (
                  <details className="space-y-2">
                    <summary className={summaryClass}>{m.release_fidelity_date_evidence({}, o)}</summary>
                    <PartValue part={dateStatement} read={read} locale={locale} />
                    {dateStatement.qualifiers.map((part, index) => (
                      <div key={index}>
                        <PartValue part={part} read={read} locale={locale} />
                      </div>
                    ))}
                    {dateStatement.references.map((reference, index) => (
                      <div key={index} className="space-y-1 text-sm">
                        {reference.parts.map((part, at) => (
                          <PartValue key={at} part={part} read={read} locale={locale} />
                        ))}
                      </div>
                    ))}
                  </details>
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
                <h3 ref={sourcesHeading} tabIndex={-1} className="sr-only">
                  {m.subject_sources({}, o)}
                </h3>
                {destination(`${href}/sources`, 'sources', 'sources') ? (
                  <a href={destination(`${href}/sources`, 'sources', 'sources')} className={linkClass}>
                    {m.subject_sources({}, o)}
                  </a>
                ) : (
                  <p>
                    {m.subject_sources({}, o)}: {m.release_fidelity_visit_unsupported({}, o)}
                  </p>
                )}
              </section>
              <section className="min-w-0 space-y-3" data-slot="release-related">
                <h2
                  ref={listHeading}
                  tabIndex={-1}
                  className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {m.release_fidelity_related({}, o)}
                </h2>
                {read.streamState === 'unsupported' && <p>{m.release_fidelity_related_unsupported({}, o)}</p>}
                {read.streamState === 'unavailable' && <p>{m.release_fidelity_related_unavailable({}, o)}</p>}
                {read.streamState === 'withheld' && <p>{m.release_fidelity_related_withheld({}, o)}</p>}
                {read.streamState === 'denied' && <p>{m.release_fidelity_related_denied({}, o)}</p>}
                <p className="text-sm text-muted-foreground">{m.release_fidelity_selection_local({}, o)}</p>
                {read.streams.length > 0 && (
                  <Field className="min-w-0">
                    <FieldLabel htmlFor={`${headingId}-stream`}>{m.release_fidelity_related({}, o)}</FieldLabel>
                    <NativeSelect
                      id={`${headingId}-stream`}
                      value={
                        reader.kind === 'loading-page'
                          ? (reader.intent.stream ?? read.stream?.key ?? '')
                          : (read.stream?.key ?? '')
                      }
                      disabled={!!draft}
                      onChange={(event) => {
                        void startRead(
                          {
                            kind: 'page',
                            stream: event.currentTarget.value,
                            ...(admitted?.address.session ? { session: admitted.address.session } : {}),
                          },
                          undefined,
                          admitted,
                        );
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
                {reader.kind === 'loading-page' && <p role="status">{m.candidate_loading({}, o)}</p>}
                {read.streamState === 'empty' && <p>{m.release_fidelity_related_empty({}, o)}</p>}
                <ul className="space-y-3">
                  {read.rows.map((row) => {
                    const target = read.stream ? rowTarget(row, read.stream) : undefined;
                    const occurrence = read.stream ? occurrenceFor(row, read.stream) : undefined;
                    const isSelected = !!occurrence && occurrence.key === selection?.key;
                    const summaryLabel = row.summary?.label?.value || m.subject_value_unlabelled({}, o);
                    const companion =
                      row.readability === 'readable' &&
                      row.summary?.label?.value &&
                      read.stream?.kind === 'file' &&
                      target
                        ? destination(
                            `${subjectHref({ id: target, label: summaryLabel }, locale).href}/file`,
                            'file',
                            'inspection',
                            occurrence,
                          )
                        : row.readability === 'readable' &&
                            row.summary?.label?.value &&
                            read.stream?.kind === 'release' &&
                            target
                          ? destination(
                              `${subjectHref({ id: target, label: summaryLabel }, locale).href}/release`,
                              'release',
                              'inspection',
                              occurrence,
                            )
                          : undefined;
                    return (
                      <li
                        key={`${row.holder}:${row.statementId}`}
                        aria-current={
                          isSelected &&
                          !row.statement?.qualifiers.some((part) => part.property.id === 'rezics:spoilerLevel')
                            ? 'location'
                            : undefined
                        }
                        data-selected-occurrence={
                          isSelected && (!row.statement || spoilerLevel(row.statement) === 0)
                            ? occurrence?.key
                            : undefined
                        }
                      >
                        <ReleaseAssociationGate
                          key={`${row.holder}:${row.statementId}:${sliceRevision.current}`}
                          row={row}
                          locale={locale}
                        >
                          <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
                            <p className="break-words text-sm">
                              {read.stream?.label.text || read.stream?.property} ·{' '}
                              {read.stream?.direction === 'inverse' ? '←' : '→'}
                            </p>
                            {row.summary && companion && (
                              <ListRowLink href={companion} lang={row.summary.label?.language}>
                                {summaryLabel}
                              </ListRowLink>
                            )}
                            <p>
                              {row.readability === 'concealed'
                                ? m.release_fidelity_related_concealed({}, o)
                                : row.readability === 'unreadable'
                                  ? m.release_fidelity_related_unreadable({}, o)
                                  : summaryLabel}
                            </p>
                            {row.statement && row.readability === 'readable' ? (
                              <CandidateValue
                                snak={row.statement}
                                related={row.related}
                                locale={locale}
                                link={ReleaseValueLink}
                              />
                            ) : null}
                            {row.readability === 'readable' && !companion && (
                              <p>{m.release_fidelity_visit_unsupported({}, o)}</p>
                            )}
                            {row.readability === 'readable' &&
                              row.provenance.map((code, index) => (
                                <p key={`${index}:${code}`} className="break-words text-sm text-muted-foreground">
                                  {m.release_fidelity_related_unknown({ code }, o)}
                                </p>
                              ))}
                            {row.readability === 'readable' && row.historical && (
                              <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                            )}
                            {occurrence && row.readability === 'readable' && (
                              <Button
                                type="button"
                                variant="outline"
                                className={actionClass}
                                disabled={!!draft}
                                aria-current={isSelected ? 'true' : undefined}
                                onClick={(event) => inspect(row, event)}
                              >
                                {isSelected
                                  ? m.release_fidelity_selected({}, o)
                                  : m.release_fidelity_select_detail({}, o)}
                              </Button>
                            )}
                          </ContentItemFrame>
                        </ReleaseAssociationGate>
                      </li>
                    );
                  })}
                </ul>
                {history.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    className={actionClass}
                    disabled={!!draft || busy}
                    onClick={(event) => {
                      const previous = history.at(-1)!;
                      movingBack.current = true;
                      setHistory((items) => items.slice(0, -1));
                      void startRead(
                        {
                          kind: 'page',
                          stream: previous.stream,
                          cursor: previous.cursor,
                          session: admitted?.address.session,
                        },
                        event,
                        admitted,
                      );
                    }}
                  >
                    {m.prq_previous({}, o)}
                  </Button>
                )}
                {read.next && (
                  <Button
                    type="button"
                    variant="outline"
                    className={actionClass}
                    disabled={!!draft || reader.kind === 'loading-page'}
                    onClick={(event) =>
                      void startRead(
                        {
                          kind: 'page',
                          ...(read.stream?.key ? { stream: read.stream.key } : {}),
                          ...(read.next ? { cursor: read.next } : {}),
                          ...(admitted?.address.session ? { session: admitted.address.session } : {}),
                        },
                        event,
                        admitted,
                      )
                    }
                  >
                    {m.release_fidelity_next({}, o)}
                  </Button>
                )}
                {selection && selectionState && admitted && (
                  <ReleaseStatementGate statement={detailRow?.statement} locale={locale}>
                    <ReleaseSelectedDetail
                      page={admitted}
                      occurrence={selection}
                      row={detailRow}
                      locale={locale}
                      state={selectionState}
                      detail={selectedDetail}
                      onRetry={(event) => retryCurrent(event)}
                      onClose={clearSelection}
                      onCorrect={() => correctSelected(selection)}
                      canCorrect={detailRow?.readability === 'readable' && !!detailRow.statement && !!selectedSlot}
                      disabled={!!draft}
                      headingRef={detailHeading}
                    />
                  </ReleaseStatementGate>
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
                  transport={transport.relation(draft.holder, draft.slot.context ?? read.public.subject.context)}
                  composition={{
                    statement: draft.statement,
                    slot: draft.slot,
                    positionEditable: false,
                    ...(draft.session ? { session: draft.session } : {}),
                  }}
                  onClose={closeCorrection}
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
              {read.public.subject.context === candidateContext ? (
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
              ) : (
                <p role="status">{m.relation_context({}, o)}</p>
              )}
              <nav className="flex flex-wrap gap-2" data-slot="release-return">
                {workHref && (
                  <a href={workHref} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} ${actionClass}`}>
                    {m.release_fidelity_return({}, o)}
                  </a>
                )}
                <a
                  href={destination(`${href}/changes`, 'changes', 'related')}
                  className={`${buttonVariants({ variant: 'outline', size: 'sm' })} ${actionClass}`}
                >
                  {catalogueEntries.changes({ id, title: title.text, locale }).label}
                  {context !== candidateContext ? `: ${m.release_fidelity_visit_unsupported({}, o)}` : ''}
                </a>

                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  disabled={!!draft}
                  onClick={(event) => retryCurrent(event)}
                >
                  {m.release_fidelity_reload({}, o)}
                </Button>
                {admitted?.address.cursor && (
                  <Button
                    type="button"
                    variant="outline"
                    className={actionClass}
                    disabled={!!draft}
                    onClick={(event) => restart(event)}
                  >
                    {m.release_fidelity_restart({}, o)}
                  </Button>
                )}
              </nav>
            </div>
          </CatalogueCurrentReading>
        )}
      </section>
    </ReleaseDestination.Provider>
  );
}

function restoredReading(
  page: Parameters<typeof admittedRow>[0],
  read: Extract<ReleaseFidelityRead, { ok: true }>,
  visit: ReleaseVisit,
): ReleaseReadingState {
  const selection = visit.occurrence;
  if (!selection || read.returned !== 'restored' || !admittedRow(page, selection))
    return { kind: 'page', admitted: page };
  if (!read.detail || read.detail.subject.context !== visit.context || read.detail.subject.id !== selection.target)
    return { kind: 'selection-unavailable', admitted: page, selection };
  return { kind: 'selected', admitted: page, selection, detail: read.detail };
}

function ReleaseAssociationGate({
  row,
  locale,
  children,
}: {
  row: ReleaseRow;
  locale: string;
  children: import('react').ReactNode;
}) {
  return (
    <ReleaseStatementGate statement={row.statement} locale={locale}>
      {children}
    </ReleaseStatementGate>
  );
}

function ReleaseStatementGate({
  statement,
  locale,
  children,
}: {
  statement: ReleaseRow['statement'];
  locale: string;
  children: import('react').ReactNode;
}) {
  return statement && spoilerLevel(statement) > 0 ? (
    <SpoilerGate label={m.subject_spoiler_show({}, { locale: locale as never })} unmountOnHide>
      {children}
    </SpoilerGate>
  ) : (
    children
  );
}

function historicalNote(historical: boolean, o: { locale: never }) {
  return historical ? <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p> : null;
}
