import { buttonVariants, Button } from '@rezics/ui/shadcn/button';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { SubjectRef, type SubjectReference } from '../subject-ref';
import { ReceivedCollectionDetails } from '../subject-collection-choice-reading/details';
import { collectionReadFailure, emptyCollectionPage, firstCollectionVisit, isCuratedWriteDestination, nextCollectionVisit, previousCollectionVisit, replaceCollectionPage, type BoundCollectionPage, type CapturedChooserTarget, type ChooserCollectionRow, type SubjectCollectionVisit } from './model';

const rowClass = 'h-auto min-h-7 w-full min-w-0 justify-between gap-2 text-start whitespace-normal';

export type ChooserCollectionsRead = {
  collections: ChooserCollectionRow[] | null;
  next: string | null;
  state: 'loaded' | 'expired' | 'closed' | 'unavailable';
};

type InspectedDestination = {
  row: ChooserCollectionRow;
  page: BoundCollectionPage<ChooserCollectionRow>;
  episode: number;
  trigger: HTMLButtonElement;
};

type ChooserFocusIntent = {
  episode: number;
  mount: object;
  control: HTMLElement;
  startingFocus: HTMLElement;
};

type ReceivedFocusRegion = 'inspection' | 'rows' | 'other';

function receivedFocusRegion(element: Element | null): ReceivedFocusRegion {
  if (!element) return 'other';
  if (element.closest('[data-collection-inspection]')) return 'inspection';
  if (element.closest('[data-collection-rows]')) return 'rows';
  return 'other';
}

function isVisibleAndExposed(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.matches(':disabled')) return false;
  const view = element.ownerDocument.defaultView;
  if (!view || element.getClientRects().length === 0) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (
      ancestor.hidden ||
      ancestor.hasAttribute('inert') ||
      ancestor.getAttribute('aria-hidden')?.toLowerCase() === 'true'
    )
      return false;
    const style = view.getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

export function CollectionChooserPanel({
  subject,
  locale,
  action,
  readerHref,
  csrfToken,
  admitted,
  hydrated,
  loaded,
  collections,
  next,
  problem,
  pending,
  addedId,
  current,
  readPage,
  onSelect,
  onConfirm,
}: {
  subject: SubjectReference;
  locale: string;
  action: string;
  readerHref: string;
  csrfToken: string | null;
  admitted: boolean;
  hydrated: boolean;
  loaded: boolean;
  collections: ChooserCollectionRow[] | null;
  next: string | null;
  problem: 'closed' | 'unavailable' | 'expired' | null;
  pending: boolean;
  addedId: string | null;
  current: () => boolean;
  readPage: (cursor?: string) => Promise<ChooserCollectionsRead>;
  onSelect: (target: CapturedChooserTarget | null) => void;
  onConfirm: (collectionId: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef(true);
  const version = useRef(0);
  const mountEpisode = useRef({});
  const focusIntent = useRef<ChooserFocusIntent | null>(null);
  const receivedFocus = useRef<{ region: ReceivedFocusRegion; element: Element | null }>({
    region: 'other',
    element: null,
  });
  const windowBlurred = useRef(false);
  const callbacks = useRef({ current, readPage, onSelect, hydrated, csrfToken, admitted });
  callbacks.current = { current, readPage, onSelect, hydrated, csrfToken, admitted };
  const [page, setPage] = useState<BoundCollectionPage<ChooserCollectionRow>>(() =>
    loaded ? replaceCollectionPage(undefined, collections ?? [], next, firstCollectionVisit()) : emptyCollectionPage(),
  );
  const [issue, setIssue] = useState<'expired' | 'closed' | 'unavailable' | null>(problem);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<CapturedChooserTarget | null>(null);
  const [inspection, setInspection] = useState<InspectedDestination | null>(null);
  const inspectionRef = useRef(inspection);
  const pageRef = useRef(page);
  pageRef.current = page;
  const busyRef = useRef(false);
  const issueRef = useRef(issue);
  issueRef.current = issue;
  const received = useRef({ collections, next, loaded, problem });

  // External refresh replaces the received page, independently of the captured add target.
  // An in-flight explicit read already retires its page and installs its own response below.
  useLayoutEffect(() => {
    const previous = received.current;
    received.current = { collections, next, loaded, problem };
    if (
      previous.collections === collections &&
      previous.next === next &&
      previous.loaded === loaded &&
      previous.problem === problem
    )
      return;
    if (busyRef.current) return;
    version.current++;
    const document = heading.current?.ownerDocument;
    const activeElement = document?.activeElement;
    const activeRegion = activeElement instanceof Element ? receivedFocusRegion(activeElement) : 'other';
    const lastFocus = receivedFocus.current;
    const focusWasInChoices =
      !windowBlurred.current &&
      (activeRegion !== 'other' ||
        ((activeElement === document?.body || activeElement === document?.documentElement) &&
          lastFocus.region !== 'other' &&
          !!lastFocus.element &&
          !lastFocus.element.isConnected));
    focusIntent.current = null;
    retireInspection();
    setIssue(problem);
    setPage((previousPage) =>
      loaded ? replaceCollectionPage(previousPage, collections ?? [], next, previousPage.visit) : emptyCollectionPage(),
    );
    if (focusWasInChoices && callbacks.current.current()) focusVisibleHeading();
  }, [collections, next, loaded, problem]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      version.current++;
      focusIntent.current = null;
      inspectionRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const document = heading.current?.ownerDocument;
    const window = document?.defaultView;
    if (!document || !window) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const targetIsDocumentFocus = target === document.body || target === document.documentElement;
      if (target && !targetIsDocumentFocus) {
        receivedFocus.current = { region: receivedFocusRegion(target), element: target };
      } else if (
        !(
          receivedFocus.current.region !== 'other' &&
          receivedFocus.current.element &&
          !receivedFocus.current.element.isConnected
        )
      ) {
        receivedFocus.current = { region: 'other', element: target };
      }

      const intent = focusIntent.current;
      if (!intent || intent.episode !== version.current || intent.mount !== mountEpisode.current) return;
      const focusMovedToRetiredDocument =
        targetIsDocumentFocus &&
        !isVisibleAndExposed(intent.startingFocus) &&
        !isVisibleAndExposed(intent.control);
      if (target !== intent.startingFocus && target !== intent.control && !focusMovedToRetiredDocument)
        focusIntent.current = null;
    };
    const onPointerDown = (event: PointerEvent) => {
      const intent = focusIntent.current;
      const target = event.target instanceof Node ? event.target : null;
      if (!intent || !target) return;
      if (intent.control.contains(target) || intent.startingFocus.contains(target)) return;
      focusIntent.current = null;
    };
    const onWindowBlur = () => {
      windowBlurred.current = true;
      focusIntent.current = null;
      receivedFocus.current = { region: 'other', element: null };
    };
    const onWindowFocus = () => {
      windowBlurred.current = false;
      receivedFocus.current = { region: 'other', element: null };
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  const retained = (episode: number) => live.current && episode === version.current && callbacks.current.current();

  function retireInspection() {
    inspectionRef.current = null;
    setInspection(null);
  }

  function focusVisibleHeading() {
    const target = heading.current;
    if (isVisibleAndExposed(target)) target.focus();
  }

  function beginFocusIntent(episode: number, control: HTMLElement) {
    const document = control.ownerDocument;
    const activeElement = document.activeElement;
    const startingFocus = activeElement instanceof HTMLElement ? activeElement : control;
    const intent = { episode, mount: mountEpisode.current, control, startingFocus };
    focusIntent.current = intent;
    return intent;
  }

  function finishFocusIntent(intent: ChooserFocusIntent) {
    if (focusIntent.current !== intent) return;
    focusIntent.current = null;
    const document = intent.control.ownerDocument;
    const activeElement = document.activeElement;
    const activeIsDocumentFocus = activeElement === document.body || activeElement === document.documentElement;
    const sourceLostFocus =
      activeIsDocumentFocus &&
      !isVisibleAndExposed(intent.startingFocus) &&
      !isVisibleAndExposed(intent.control);
    if (
      live.current &&
      intent.mount === mountEpisode.current &&
      intent.episode === version.current &&
      callbacks.current.current() &&
      (activeElement === intent.startingFocus || activeElement === intent.control || sourceLostFocus)
    )
      focusVisibleHeading();
  }

  function rowCurrent(source: BoundCollectionPage<ChooserCollectionRow>, row: ChooserCollectionRow, episode: number) {
    return (
      retained(episode) &&
      !busyRef.current &&
      !issueRef.current &&
      pageRef.current === source &&
      source.rows.includes(row)
    );
  }

  function inspect(row: ChooserCollectionRow, trigger: HTMLButtonElement) {
    if (!callbacks.current.hydrated || !rowCurrent(page, row, version.current)) return;
    const receivedRow = { row, page, episode: version.current, trigger };
    inspectionRef.current = receivedRow;
    setInspection(receivedRow);
  }

  function closeInspection(receivedRow: InspectedDestination) {
    if (inspectionRef.current !== receivedRow) return;
    const restoreTrigger =
      rowCurrent(receivedRow.page, receivedRow.row, receivedRow.episode) &&
      isVisibleAndExposed(receivedRow.trigger);
    retireInspection();
    if (restoreTrigger) receivedRow.trigger.focus();
    else focusVisibleHeading();
  }

  async function load(visit: SubjectCollectionVisit, control: HTMLElement) {
    const episode = ++version.current;
    const intent = beginFocusIntent(episode, control);
    busyRef.current = true;
    retireInspection();
    setBusy(true);
    setIssue(null);
    setPage((currentPage) => replaceCollectionPage(currentPage, [], null, visit));
    try {
      const response = await callbacks.current.readPage(visit.cursor);
      if (!retained(episode)) return;
      if (response.state !== 'loaded' || response.collections === null) {
        setIssue(response.state === 'loaded' ? 'unavailable' : response.state);
        return;
      }
      setPage((currentPage) => replaceCollectionPage(currentPage, response.collections ?? [], response.next, visit));
    } catch (error) {
      if (retained(episode)) setIssue(collectionReadFailure(error));
    } finally {
      if (retained(episode)) {
        finishFocusIntent(intent);
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function choose(row: ChooserCollectionRow, source: BoundCollectionPage<ChooserCollectionRow>, episode: number) {
    const admission = callbacks.current;
    if (
      !rowCurrent(source, row, episode) ||
      !isCuratedWriteDestination(row) ||
      !admission.hydrated ||
      !admission.csrfToken ||
      !admission.admitted
    )
      return;
    const target = { id: row.id, title: row.title };
    setSelected(target);
    callbacks.current.onSelect(target);
  }

  const destinations = issue ? [] : page.rows.filter(isCuratedWriteDestination);
  const selectedStill = selected;
  const episode = version.current;
  const inspected = inspection && rowCurrent(inspection.page, inspection.row, inspection.episode) ? inspection : null;
  return (
    <div className="max-h-[70vh] w-full min-w-0 overflow-y-auto p-4 sm:w-80">
      <h3 ref={heading} tabIndex={-1} className="mb-2 text-sm font-medium">
        {m.library_subject_chooser_heading()}
      </h3>
      <p className="mb-3 text-sm text-muted-foreground">
        {m.library_subject_add_subject()} <SubjectRef subject={subject} />
      </p>
      {busy ? <p role="status">{m.library_subject_chooser_preparing()}</p> : null}
      {!loaded && page.generation === 0 && !busy ? (
        <form
          method="get"
          action={action}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void load(
              firstCollectionVisit(),
              event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]') ?? event.currentTarget,
            );
          }}
        >
          <input type="hidden" name="slot" value="collections" />
          <Button variant="outline" type="submit">
            {m.library_subject_load_collections()}
          </Button>
        </form>
      ) : null}
      {loaded || page.generation > 0 || busy ? (
        <>
          {issue ? (
            <div role="alert" className="space-y-2 text-sm text-muted-foreground">
              <p>
                {issue === 'expired'
                  ? m.library_subject_continuation_expired()
                  : issue === 'closed'
                    ? m.library_subject_closed()
                    : m.library_subject_unavailable()}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !hydrated}
                onClick={(event) => void load(firstCollectionVisit(), event.currentTarget)}
              >
                {m.library_subject_continuation_restart()}
              </Button>
            </div>
          ) : null}
          {!issue && !busy && destinations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {page.next
                ? m.library_subject_chooser_empty_page()
                : page.visit.page > 1
                  ? m.library_subject_continuation_exhausted()
                  : m.library_subject_no_curated_collections()}
            </p>
          ) : null}
          {!issue && destinations.length ? (
            <ul className="space-y-2" data-collection-rows>
              {destinations.map((collection) => (
                <li key={collection.id}>
                  <Button
                    variant="outline" className={rowClass}
                    type="button"
                    aria-pressed={selectedStill?.id === collection.id}
                    disabled={!hydrated || !csrfToken || !admitted}
                    onClick={() => choose(collection, page, episode)}
                  >
                    <span className="h-auto min-w-0 [overflow-wrap:anywhere]">{collection.title}</span>
                    <span className="shrink-0 text-muted-foreground">{collection.memberCount}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    data-collection-inspect
                    aria-label={m.library_destination_inspect_named({ title: collection.title })}
                    aria-expanded={inspected?.row === collection}
                    disabled={!hydrated}
                    onClick={(event) => inspect(collection, event.currentTarget)}
                  >
                    {m.library_destination_inspect()}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {inspected ? (
            <ReceivedCollectionDetails
              row={inspected.row}
              canChoose={hydrated && !!csrfToken && admitted}
              onClose={() => closeInspection(inspected)}
              onChoose={() => {
                if (inspectionRef.current !== inspected) return;
                choose(inspected.row, inspected.page, inspected.episode);
                closeInspection(inspected);
              }}
            />
          ) : null}
          {!issue ? (
            <div className="mt-3 flex min-w-0 flex-wrap gap-2">
              {previousCollectionVisit(page.visit) ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !hydrated}
                  onClick={(event) => {
                    const previous = previousCollectionVisit(page.visit);
                    if (previous) void load(previous, event.currentTarget);
                  }}
                >
                  {m.library_subject_continuation_previous()}
                </Button>
              ) : null}
              {page.visit.page > 1 ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !hydrated}
                  onClick={(event) => void load(firstCollectionVisit(), event.currentTarget)}
                >
                  {m.library_subject_continuation_restart()}
                </Button>
              ) : null}
              {page.next && !issue ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !hydrated}
                  onClick={(event) => void load(nextCollectionVisit(page.visit, page.next), event.currentTarget)}
                >
                  {m.library_subject_continuation_next()}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {selectedStill ? (
        <div data-add-collection-review className="mt-4 space-y-2 border-t border-border pt-3">
          <p role="status" className="h-auto text-sm [overflow-wrap:anywhere]">
            {m.library_subject_chooser_selected({ title: selectedStill.title })}
          </p>
          <p className="h-auto text-sm [overflow-wrap:anywhere]">
            {m.library_subject_add_review({ title: selectedStill.title })}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!hydrated || !csrfToken || !admitted || pending}
            onClick={() => onConfirm(selectedStill.id)}
          >
            {m.library_subject_add_confirm()}
          </Button>
        </div>
      ) : null}
      {addedId ? (
        <nav className="mt-3 flex flex-col gap-2" aria-label={m.library_subject_heading()}>
          <a
           className={buttonVariants({ variant: 'link', className: 'h-auto min-h-7 [overflow-wrap:anywhere]' })}
            href={`/${encodeURIComponent(locale)}/collections/${encodeURIComponent(addedId)}`}
          >
            {m.library_subject_collection_open({
              title: selectedStill?.id === addedId ? selectedStill.title : addedId,
            })}
          </a>
          <a className={buttonVariants({ variant: 'link' })} href={readerHref}>
            {m.library_subject_return_reader()}
          </a>
        </nav>
      ) : null}
    </div>
  );
}
