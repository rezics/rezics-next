import { catalogueEditor, useEditorLifetime } from '../editor-lifetime';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { pickText } from '@rezics/composition';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { ViewHeading } from '../../pages/view-heading';
import { m } from '../../../paraglide/messages.js';
import { catalogueEntries } from '../catalogue-entry';
import type { RelationTransport, RelationDraft, RelationSlot } from '../../../subject/relation-candidates';
import { RelationEditor } from '../relation-editor';
import { useConsentFocus } from '../statement-consent-focus';
import {
  CharacterRelationshipsGroups,
  characterRelationshipsActionClass,
  characterRelationshipsSummaryClass,
} from '../../pages/character-relationships';
import { associationCorrection } from './correction';
import {
  advanceCharacterRelationshipsCursor,
  associationReadingKey,
  createCharacterRelationshipsVisit,
  type CharacterRelationshipsOrigin,
  type CharacterRelationshipsVisit,
} from './navigation';
import {
  isCurrentCharacterRelationshipsRead,
  type CharacterAssociationRow,
  type CharacterAssociationStream,
  type CharacterRelationshipsRead,
} from './reading';

export type CharacterRelationshipsTransport = {
  read: (stream?: string, cursor?: string, session?: string) => Promise<CharacterRelationshipsRead>;
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

export const CharacterRelationshipsView = catalogueEditor(CharacterRelationshipsLive);

function CharacterRelationshipsLive({
  id,
  locale,
  transport,
  search,
  initial,
  work,
  stream: initialStream,
  cursor: initialCursor,
  origin,
  visit,
  saveVisit,
  signedIn = true,
}: {
  id: string;
  locale: string;
  transport: CharacterRelationshipsTransport;
  search: EntityPickerSearch;
  initial?: CharacterRelationshipsRead | undefined;
  work?: string | undefined;
  stream?: string | undefined;
  cursor?: string | undefined;
  origin?: CharacterRelationshipsOrigin | undefined;
  visit?: CharacterRelationshipsVisit | undefined;
  saveVisit?: (visit: CharacterRelationshipsVisit) => void;
  signedIn?: boolean;
}) {
  const streamId = useId();
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['character-relationships', id, locale], lifetime.generation],
    queryFn: () => transport.read(initialStream, initialCursor),
    initialData: initial,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [page, setPage] = useState<Extract<CharacterRelationshipsRead, { ok: true }>>();
  const [failure, setFailure] = useState<Extract<CharacterRelationshipsRead, { ok: false }>>();
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<OpenDraft[]>([]);
  const [selectedWork, setSelectedWork] = useState(visit ? (visit.work ?? undefined) : work);
  const [returnChanged, setReturnChanged] = useState(false);
  const nextDraftInstance = useRef(0);
  const focusAfterOpen = useRef<OpeningFocus | undefined>(undefined);
  useLayoutEffect(() => () => focusAfterOpen.current?.cancel(), []);
  const focusAfterClose = useRef<HTMLElement | undefined>(undefined);
  const readFocus = useConsentFocus();
  const router = useRouter({ warn: false });
  const readSequence = useRef(0);
  const sliceStatus = useRef<HTMLParagraphElement>(null);
  const readFailure = useRef<HTMLParagraphElement>(null);
  const running = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const cursorAddresses = useRef<(string | null)[]>(visit ? [...visit.cursors] : [initialCursor ?? null]);
  const cursorIndex = useRef(visit?.index ?? 0);
  const cursor = useRef<string | undefined>(cursorAddresses.current[cursorIndex.current] ?? undefined);
  const pageRoot = useRef<HTMLElement>(null);
  const focusAttempted = useRef(false);
  useLayoutEffect(() => {
    const target = focusAfterClose.current;
    if (!target) return;
    focusAfterClose.current = undefined;
    if (target.isConnected) target.focus();
  }, [drafts]);
  useLayoutEffect(() => {
    if (!visit || focusAttempted.current || !query.isSuccess || query.isFetching || !query.data?.ok) return;
    focusAttempted.current = true;
    const workMissing = !!visit.work && !query.data.rows.some((row) => row.holder === visit.work);
    const focus = visit?.focus;
    if (!focus) {
      if (workMissing) setReturnChanged(true);
      return;
    }
    const rowIndex = query.data.rows.findIndex(
      (row) => row.holder === focus.holder && row.statementId === focus.statement,
    );
    if (rowIndex < 0) {
      setReturnChanged(true);
      return;
    }
    if (workMissing) setReturnChanged(true);
    const row = pageRoot.current?.querySelector<HTMLElement>(`[data-relationship-row="${rowIndex}"]`);
    if (
      row?.isConnected &&
      (document.activeElement === document.body || document.activeElement === document.documentElement)
    )
      row.focus();
  }, [query.data, query.isFetching, query.isSuccess, visit]);
  const read = page ?? (query.data?.ok ? query.data : undefined);
  const error = failure ?? (!page && query.data && !query.data.ok ? query.data : undefined);
  const concealed = !!error || (!page && query.isError);
  const stream = read?.stream;
  const sliceRevision = useRef(0);
  const slice = useCatalogueLifetime(
    associationReadingKey(
      { id, stream: stream?.key, cursor: cursor.current, work: selectedWork },
      sliceRevision.current,
    ),
    lifetime,
  );
  const currentRead = isCurrentCharacterRelationshipsRead(query.data, query, {
    id,
    stream: stream?.key,
    cursor: cursor.current,
  });
  useLayoutEffect(() => {
    if (!selectedWork || !read) return;
    if (read.rows.some((row) => row.holder === selectedWork)) return;
    setSelectedWork(undefined);
  }, [read, selectedWork]);
  type ReadAction = 'next' | 'previous' | 'restart' | 'stream' | 'retry';
  function rememberVisit(
    key: string | undefined,
    workValue: string | undefined,
    focus?: { holder: string; statement: string },
  ) {
    const visitOrigin = origin ?? {
      id,
      locale,
      ...(query.data?.ok ? { context: query.data.public.subject.context } : {}),
    };
    const address = createCharacterRelationshipsVisit(visitOrigin, {
      stream: key,
      work: workValue,
      cursors: cursorAddresses.current,
      index: cursorIndex.current,
      ...(focus ? { focus } : {}),
    });
    if (address) saveVisit?.(address);
  }
  async function load(
    key = stream?.key,
    next?: string,
    event?: MouseEvent<HTMLButtonElement>,
    action: ReadAction = 'retry',
  ) {
    if (!slice.active()) return;
    readFocus.cancel();
    if (running.current) return;
    if (action !== 'retry') setReturnChanged(false);
    if (key !== stream?.key || next !== cursor.current) {
      slice.retire();
      sliceRevision.current++;
      if (key !== stream?.key) setSelectedWork(undefined);
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
      if (action === 'stream' || action === 'restart') {
        cursorAddresses.current = [null];
        cursorIndex.current = 0;
      } else if (action === 'previous') {
        cursorIndex.current = Math.max(0, cursorIndex.current - 1);
      } else if (action === 'next' && next) {
        const advanced = advanceCharacterRelationshipsCursor(cursorAddresses.current, cursorIndex.current, next);
        cursorAddresses.current = advanced.cursors;
        cursorIndex.current = advanced.index;
      }
      const workValue =
        key !== stream?.key || !value.rows.some((row) => row.holder === selectedWork) ? undefined : selectedWork;
      if (workValue !== selectedWork) setSelectedWork(workValue);
      rememberVisit(key, workValue);
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
  function open(
    row: CharacterAssociationRow,
    selected: CharacterAssociationStream,
    returnFocus: HTMLElement,
    keyboard: boolean,
  ) {
    if (!slice.active() || !signedIn) return;
    const correction = associationCorrection(row, selected);
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
  function closeDraft(instance: number) {
    setDrafts((previous) => {
      const closing = previous.find((draft) => draft.instance === instance);
      if (!closing) return previous;
      focusAfterClose.current = closing.returnFocus;
      return previous.filter((draft) => draft.instance !== instance);
    });
  }
  function selectWork(next: string | undefined) {
    if (!slice.active()) return;
    setSelectedWork(next);
  }
  function visitTarget(row: CharacterAssociationRow, event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !slice.active()
    )
      return;
    rememberVisit(stream?.key, selectedWork, { holder: row.holder, statement: row.statementId });
    if (router) {
      event.preventDefault();
      const target = new URL(event.currentTarget.href);
      void router.navigate({ to: `${target.pathname}${target.search}${target.hash}` as never });
    }
  }
  const failed =
    error?.reason === 'denied'
      ? m.candidate_denied({}, o)
      : error?.reason === 'stale'
        ? m.relation_stale({}, o)
        : error?.reason === 'invalid'
          ? m.candidate_invalid({}, o)
          : m.candidate_unavailable({}, o);
  const changes = catalogueEntries.changes({
    id,
    title: pickText(read?.public.subject.labels ?? {}, locale).text,
    locale,
  });
  return (
    <article
      ref={pageRoot}
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={busy || query.isPending}
    >
      <ViewHeading label={m.character_relationships_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.character_relationships_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {concealed && (
        <p ref={readFailure} role="alert" tabIndex={-1}>
          {failed}
        </p>
      )}
      <div hidden={concealed} className="space-y-6">
        {read && (
          <>
            <CharacterRelationshipsGroups
              id={id}
              locale={locale}
              read={read}
              streamId={streamId}
              selectedWork={selectedWork}
              busy={busy}
              sliceStatus={sliceStatus}
              onSelectStream={(key) => void load(key, undefined, undefined, 'stream')}
              onSelectWork={selectWork}
              {...(signedIn && currentRead ? { onCorrect: open } : {})}
              onTargetVisit={visitTarget}
              canPrevious={cursorIndex.current > 0}
              returnChanged={returnChanged}
              onPrevious={(event) => {
                const previous = cursorAddresses.current[cursorIndex.current - 1];
                if (cursorIndex.current > 0) void load(stream?.key, previous ?? undefined, event, 'previous');
              }}
              onMore={(event) => void load(stream?.key, read.next ?? undefined, event, 'next')}
              onRestart={(event) => void load(stream?.key, undefined, event, 'restart')}
            />
            <p>
              <a
                className={buttonVariants({ variant: 'outline', className: characterRelationshipsActionClass })}
                href={changes.href}
              >
                {m.character_relationships_changes({}, o)}
              </a>
            </p>
            <details className="rounded-lg border border-border p-4 text-sm">
              <summary className={characterRelationshipsSummaryClass}>{m.catalogue_technical_details({}, o)}</summary>
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
              <summary className={characterRelationshipsSummaryClass}>{m.catalogue_technical_details({}, o)}</summary>
              <p className="mt-3 break-all">
                {m.character_relationships_holder({}, o)}: <code>{draft.id}</code>
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
          className={characterRelationshipsActionClass}
          variant="outline"
          disabled={busy}
          onClick={(event) => void load(stream?.key, cursor.current, event, 'retry')}
        >
          {m.candidate_reload({}, o)}
        </Button>
      )}
    </article>
  );
}
