'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { Children, useRef, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { commandLane, type WriteRound } from '../api/command.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import {
  browserZoneAuthoring,
  browserZoneNavigation,
  browserZoneTheme,
  commitCommand,
  type PageChoice,
  type PublishedSite,
  type WriteResult,
  type ZoneAuthoringClient,
  type ZoneNavigationClient,
  type ZoneThemeClient,
} from './api.ts';
import { EditorActions } from './editor-actions.tsx';
import { CollectionPageLookup } from './collection-page-lookup.tsx';
import { PageSearchPicker } from './page-search-picker.tsx';
import { useZoneEditorDraft, useZoneEditorExitActions, useZoneEditorRef, useZoneEditorSessionState } from './draft-provider.tsx';
import { confirmPublicationReview, readSavedPublicationSelection, reviewedPublicationChoice, stagePublicationReview,
  type PublicationReview } from './publication-review.ts';
import { PublicationReviewPanel } from './publication-review-panel.tsx';
import type { ZoneEditorMessages } from './messages.ts';
import {
  preparedHomeDocument, canPublish,
  isDirty,
  publicationChoice,
  reduceEditor,
  type EditorState,
  type PublicationChoice,
} from './model.ts';
import {
  commitNavigation,
  isNavigationDirty,
  hasInvalidNavigationPaths,
  isSegment,
  NAV_COMMAND_LIMIT,
  pathEditBlocked,
  reduceNavigation,
  segmentFor,
  type NavigationSaveProgress,
  type NavigationState,
  type SiteLink,
} from './navigation.ts';

const choiceClass = 'h-auto min-h-9 w-auto whitespace-normal px-3 sm:h-9 sm:whitespace-nowrap';
type SavedLinks = { head: string; links: SiteLink[]; replayed: boolean };
const fieldClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Edit the Zone's navigation and publish it with the home page.
 * A lost response retries the same command key. A stale save keeps the author's links.
 * Readers see a page's own name; the path is only the address.
 */
export function ZoneNavigationEditor({
  zoneId,
  actingSubject,
  locale,
  copy,
  initial,
  home,
  previewHref,
  siteHref,
  signInHref,
  api,
  authoring,
  themeApi,
}: {
  zoneId: string;
  zoneIri: string;
  actingSubject: string;
  locale: UiLocale;
  copy: ZoneEditorMessages;
  initial: NavigationState;
  home: EditorState;
  previewHref: string;
  siteHref: string;
  signInHref: string;
  api?: ZoneNavigationClient;
  authoring?: ZoneAuthoringClient;
  themeApi?: ZoneThemeClient;
}) {
  const [state, dispatch, draftReady] = useZoneEditorDraft('navigation', initial, isNavigationDirty, isNavigationState);
  const [page, setPage, pageReady] = useZoneEditorDraft('home', home, isDirty, isEditorState);
  const [busy, setBusy] = useZoneEditorSessionState<null | 'save' | 'publish' | 'load' | 'continue'>('navigation-busy', null);
  const [intent, setIntent] = useZoneEditorSessionState<null | 'save' | 'publish' | 'load' | 'continue' | 'review'>('navigation-intent', null);
  const [review, setReview] = useZoneEditorSessionState<PublicationReview | null>('navigation-review', null);
  const [query, setQuery] = useZoneEditorSessionState('navigation-query', '');
  const [picked, setPicked] = useZoneEditorSessionState<PageChoice | null>('navigation-picked', null);
  const paths = state.pathBuffers ?? {};
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const [saveCompleted, setSaveCompleted] = useZoneEditorSessionState('navigation-save-completed', 0);
  const saveSession = useZoneEditorRef<{ choice: NavigationState; progress?: NavigationSaveProgress } | null>(
    'navigation-save-session', null,
  );
  const stateRef = useZoneEditorRef('navigation-state', state);
  const pageRef = useZoneEditorRef('navigation-home-state', page);
  stateRef.current = state;
  pageRef.current = page;
  const inflight = useZoneEditorRef('navigation-inflight', 0);
  function put(event: Parameters<typeof reduceNavigation>[1]) {
    dispatch((current) => {
      const next = reduceNavigation(current, event);
      stateRef.current = next;
      return next;
    });
  }
  function putPage(event: Parameters<typeof reduceEditor>[1]) {
    setPage((current) => {
      const next = reduceEditor(current, event);
      pageRef.current = next;
      return next;
    });
  }
  const client = useRef<ZoneNavigationClient | null>(null);
  const pages = useRef<ZoneAuthoringClient | null>(null);
  const theme = useRef<ZoneThemeClient | null>(null);
  if (!client.current) client.current = api ?? browserZoneNavigation();
  if (!pages.current) pages.current = authoring ?? browserZoneAuthoring();
  if (!theme.current) theme.current = themeApi ?? browserZoneTheme();
  const saveLane = useZoneEditorRef<ReturnType<
    typeof commandLane<
      NavigationState,
      WriteResult<{ head: string; links: SiteLink[]; replayed: boolean }>
    >
  > | null>('navigation-save-lane', null);
  const publishLane = useZoneEditorRef<ReturnType<
    typeof commandLane<PublicationChoice, WriteResult<PublishedSite>>
  > | null>('navigation-publish-lane', null);
  const publishChoice = useZoneEditorRef<PublicationChoice | null>('navigation-publish-choice', null);
  if (!saveLane.current) saveLane.current = commandLane({ ok: false, failure: 'unavailable' });
  if (!publishLane.current)
    publishLane.current = commandLane({ ok: false, failure: 'unavailable' });
  const dirty = isNavigationDirty(state);

  useZoneEditorExitActions('navigation', async () => {
    const current = stateRef.current;
    if (inflight.current || !current.complete || hasInvalidNavigationPaths(current) || current.notice.kind === 'stale') return false;
    if (publishChoice.current) {
      const published = await publishLane.current!.submit(publishChoice.current, applyPublish);
      if (!published.ok) return false;
    }
    if (!saveSession.current && !isNavigationDirty(stateRef.current)) return true;
    const result = await saveLane.current!.submit(saveSession.current?.choice ?? current, applySave);
    if (result.ok) put({ type: 'saved', ...result.data });
    else if (result.failure === 'stale') put({ type: 'stale', currentHead: result.currentHead });
    else put({ type: 'failed', failure: result.failure });
    return result.ok && !isNavigationDirty(stateRef.current);
  }, () => {
    saveSession.current = null;
    publishChoice.current = null;
    dispatch(current => ({ ...current, links: current.saved, pending: [], pathBuffers: {}, notice: { kind: 'idle' } }));
  }, () => saveSession.current !== null || publishChoice.current !== null);

  function track(kind: 'save' | 'publish' | 'load' | 'continue', work: Promise<unknown>) {
    inflight.current += 1;
    setBusy(kind);
    setIntent(kind);
    void work.finally(() => {
      inflight.current -= 1;
      if (inflight.current === 0) setBusy(null);
    });
  }

  function applySave(chosen: NavigationState, round: WriteRound): Promise<WriteResult<SavedLinks>> {
    if (!chosen.complete) return Promise.resolve({ ok: false, failure: 'unavailable' });
    return commitCommand(round, async (key) => {
      saveSession.current ??= { choice: chosen };
      const session = saveSession.current;
      const result = await commitNavigation(
        chosen.saved,
        chosen.links,
        chosen.head,
        key,
        (op, opKey, expectedHead) => {
          if (op.kind === 'remove') {
            return client.current!.removeMount(
              zoneId,
              op.occurrence.slice(-36),
              { expectedHead, actingSubject },
              opKey,
            );
          }
          if (op.kind === 'move') {
            return client.current!.moveMount(
              chosen.navigation,
              {
                expectedHead,
                occurrence: op.occurrence,
                position: op.position,
                actingSubject,
              },
              opKey,
            );
          }
          return client.current!.insertMount(
            zoneId,
            {
              expectedHead,
              target: op.target,
              routeSegment: op.segment,
              disclosure: op.disclosure,
              position: op.position,
              actingSubject,
            },
            opKey,
          );
        },
        chosen.pending,
        session.progress,
        (progress) => {
          session.progress = progress;
          if (progress.completed > 0 && progress.completed % NAV_COMMAND_LIMIT === 0) {
            put({ type: 'progress', progress });
            setSaveCompleted(progress.completed);
          }
        },
      );
      put({ type: 'progress', progress: result.progress });
      setSaveCompleted(result.ok ? 0 : result.progress.completed);
      if (result.ok || result.failure !== 'unavailable') saveSession.current = null;
      if (result.ok)
        return {
          ok: true,
          data: { head: result.head, links: result.links, replayed: result.replayed },
        };
      if (result.failure === 'stale')
        return { ok: false, failure: 'stale', currentHead: result.currentHead };
      return { ok: false, failure: result.failure };
    });
  }

  function applyPublish(chosen: PublicationChoice, round: WriteRound) {
    return commitCommand(round, (key) => pages.current!.publish(chosen, actingSubject, key, zoneId)).then(
      (result) => {
        if (result.ok)
          putPage({
            type: 'published',
            ...result.data,
            revisionId: chosen.revisionId,
          });
        else if (result.failure === 'stale') { setReview(null); putPage({ type: 'publish-stale', problem: result.problem }); }
        else putPage({ type: 'failed', failure: result.failure, problem: result.problem });
        if (result.ok || result.failure !== 'unavailable') publishChoice.current = null;
        return result;
      },
    );
  }

  function save(next: NavigationState = stateRef.current) {
    if (busy || !draftReady || !pageReady || !next.complete || !isNavigationDirty(next) || hasInvalidNavigationPaths(next)) return;
    track(
      'save',
      saveLane
        .current!.submit(saveSession.current?.choice ?? next, applySave)
        .then(async (result) => {
          if (result.ok)
            put({
              type: 'saved',
              links: result.data.links,
              head: result.data.head,
              replayed: result.data.replayed,
            });
          else if (result.failure === 'stale') {
            put({ type: 'stale', currentHead: result.currentHead });
            await reloadForReview();
          } else put({ type: 'failed', failure: result.failure });
        }),
    );
  }

  function siteChoice(navHead: string): PublicationChoice | null {
    const choice = publicationChoice(pageRef.current);
    if (
      !choice || !draftReady || !pageReady ||
      !stateRef.current.complete ||
      saveSession.current ||
      isNavigationDirty(stateRef.current)
    )
      return null;
    return { ...choice, navigationRevision: navHead, routesRevision: navHead };
  }

  function publish() {
    const choice = publishChoice.current ?? siteChoice(stateRef.current.head);
    if (!choice || busy || !draftReady || !pageReady) return;
    publishChoice.current = choice;
    track('publish', publishLane.current!.submit(choice, applyPublish));
  }

  async function reloadForReview() {
    const result = await client.current!.readNavigation(zoneId, actingSubject);
    // Keep the stale notice (and editing lock) if the review cannot load fully.
    if (!result.ok) return;
    const snapshot = result.data;
    const links = [...snapshot.links];
    let after = snapshot.after;
    let complete = snapshot.complete;
    const cursors = new Set<string>();
    while (!complete) {
      if (!after || cursors.has(after)) return;
      cursors.add(after);
      const page = await client.current!.continueNavigation(zoneId, actingSubject, {
        head: snapshot.head,
        after,
      });
      if (
        !page.ok ||
        page.data.head !== snapshot.head ||
        page.data.navigation !== snapshot.navigation
      )
        return;
      links.push(...page.data.links);
      after = page.data.after;
      complete = page.data.complete;
    }
    saveSession.current = null;
    setSaveCompleted(0);
    put({ type: 'review', links, head: snapshot.head, navigation: snapshot.navigation });
  }

  function reviewAgain() {
    if (busy || !draftReady || !pageReady) return;
    track('load', reloadForReview());
  }

  function continueLoading() {
    const current = stateRef.current;
    if (busy || !draftReady || !pageReady || current.complete || !current.after) return;
    track(
      'continue',
      client
        .current!.continueNavigation(zoneId, actingSubject, {
          head: current.head,
          after: current.after,
        })
        .then((result) => {
          if (!result.ok) {
            put({
              type: 'failed',
              failure: result.failure === 'stale' ? 'conflict' : result.failure,
            });
            return;
          }
          put({
            type: 'continued',
            links: result.data.links,
            complete: result.data.complete,
            after: result.data.after,
          });
        }),
    );
  }

  function refreshAndPublish() {
    if (
      busy || !draftReady || !pageReady ||
      !stateRef.current.complete ||
      isNavigationDirty(stateRef.current) ||
      saveSession.current
    )
      return;
    setReview(null);
    const work = readSavedPublicationSelection(zoneId, actingSubject, {
      authoring: pages.current!, navigation: client.current!, theme: theme.current!,
    }).then(result => {
      if (result.ok) setReview(stagePublicationReview(result.data));
      else if (result.failure === 'stale') putPage({ type: 'publish-stale' });
      else putPage({ type: 'failed', failure: result.failure });
    }).catch(() => putPage({ type: 'failed', failure: 'unavailable' }));
    track('load', work);
    setIntent('review');
  }

  function publishReviewed() {
    if (!review || busy || !publishable) return;
    const confirmed = confirmPublicationReview(review);
    const choice = reviewedPublicationChoice(pageRef.current, confirmed);
    if (!choice) return;
    setReview(null);
    putPage({ type: 'heads', zoneHead: review.selection.zoneHead, navigationRevision: review.selection.navigationRevision });
    put({ type: 'review', links: review.selection.navigation, head: review.selection.navigationRevision,
      navigation: review.selection.navigationId });
    publishChoice.current = choice;
    track('publish', publishLane.current!.submit(choice, applyPublish));
  }

  function tryAgain() {
    if (intent === 'review') refreshAndPublish();
    else if (page.notice.kind === 'publish-stale') refreshAndPublish();
    else if (intent === 'publish') publish();
    else if (intent === 'load') reviewAgain();
    else if (intent === 'continue') continueLoading();
    else save();
  }

  function addLink() {
    if (!picked) return;
    const segment = segmentFor(
      picked.name,
      state.links.map((link) => link.segment),
    );
    if (!segment) {
      setAddNotice(copy.pathInvalid);
      return;
    }
    if (state.links.some((link) => link.target === picked.target || link.segment === segment)) {
      setAddNotice(copy.duplicatePath);
      return;
    }
    setAddNotice(null);
    put({
      type: 'add',
      link: {
        id: crypto.randomUUID(),
        occurrence: null,
        target: picked.target,
        name: picked.name,
        segment,
        disclosure: 'public',
      },
    });
    setPicked(null);
    setQuery('');
  }

  function onPath(link: SiteLink, value: string) {
    if (pathEditBlocked(link)) return;
    put({ type: 'path-input', id: link.id, value });
  }

  const savedNotice =
    state.notice.kind === 'saved'
      ? copy.navSaved
      : state.notice.kind === 'loaded'
        ? copy.navLoaded
        : null;
  const published =
    page.notice.kind === 'published'
      ? page.notice.replayed
        ? copy.publishedReplayed
        : copy.published
      : null;
  const publishable = Boolean(siteChoice(state.head));
  const resumable = !!saveSession.current && !busy;
  const editingDisabled = !draftReady || !!busy || resumable || !state.complete || state.notice.kind === 'stale';

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby="zone-navigation-title">
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2
            id="zone-navigation-title"
            className="font-semibold text-lg tracking-tight sm:text-xl"
          >
            {copy.navTitle}
          </h2>
          <EditorActions
            copy={resumable ? { ...copy, save: copy.navResume } : copy}
            canEdit
            busy={busy === 'continue' ? null : busy}
            saveDisabled={!draftReady || !!busy || !dirty || !state.complete || hasInvalidNavigationPaths(state) || state.notice.kind === 'stale'}
            publishDisabled={
              !draftReady || !pageReady || !!busy || !publishable || !state.complete || page.notice.kind === 'publish-stale'
            }
            onSave={() => save()}
            onPublish={() => publish()}
            previewHref={previewHref}
            siteHref={siteHref}
          />
        </div>
        <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{copy.navHelp}</p>
        <p className="text-sm" role="status">
          {copy.navStatus}
        </p>
      </div>
      {!state.complete ? (
        <Alert
          variant="warning"
          role="status"
          className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div className="min-w-0 space-y-1">
            <AlertTitle>{copy.navTitle}</AlertTitle>
            <AlertDescription>{copy.navIncomplete}</AlertDescription>
          </div>
          {state.after ? (
            <Button
              variant="outline"
              size="sm"
              className={choiceClass}
              disabled={!!busy}
              isLoading={busy === 'continue'}
              onClick={() => continueLoading()}
            >
              {copy.navContinue}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {savedNotice ? (
        <p className="text-sm" role="status">
          {savedNotice}
        </p>
      ) : null}
      {saveCompleted > 0 && state.notice.kind !== 'saved' ? (
        <div role="status" className="space-y-1 text-sm">
          <p>
            {copy.navSaveProgress} {saveCompleted.toLocaleString(locale)}
          </p>
          {!busy ? (
            <p className="text-pretty text-muted-foreground">{copy.navSaveRemaining}</p>
          ) : null}
        </div>
      ) : null}
      {state.notice.kind === 'saved' ? (
        <p className="text-pretty text-muted-foreground text-sm">{copy.navSavedHint}</p>
      ) : null}
      {published ? (
        <p className="text-sm" role="status">
          {published}
        </p>
      ) : null}
      {dirty ? (
        <p className="text-pretty text-muted-foreground text-sm">{copy.navSaveFirst}</p>
      ) : null}
      {!dirty && !canPublish(page) ? (
        <p className="text-pretty text-muted-foreground text-sm">{copy.saveFirst}</p>
      ) : null}
      <NavNotice
        copy={copy}
        state={state}
        page={page}
        busy={busy}
        signInHref={signInHref}
        ready={draftReady && pageReady}
        review={review}
        reviewPublishDisabled={!!busy || !publishable || !!review && !reviewedPublicationChoice(page, confirmPublicationReview(review))}
        onReview={reviewAgain}
        onRefresh={refreshAndPublish}
        onPublishReviewed={publishReviewed}
        onRetry={tryAgain}
      />
      {state.links.length ? (
        <ul aria-label={copy.linksLabel} className="grid gap-2">
          {state.links.map((link, index) => {
            const savedPath = pathEditBlocked(link);
            const typed = savedPath ? undefined : paths[link.id];
            const invalid = typed !== undefined && typed !== link.segment && !isSegment(typed);
            const taken =
              typed !== undefined &&
              isSegment(typed) &&
              state.links.some((other) => other.id !== link.id && other.segment === typed);
            return (
              <li key={link.id} className="grid gap-2 rounded-xl border border-border/60 p-3">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <p className="min-w-0 truncate font-medium">{link.name}</p>
                  {link.disclosure === 'private' ? (
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {copy.privateLink}
                    </span>
                  ) : null}
                </div>
                <label className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">{copy.pathLabel}</span>
                  <input
                    className={fieldClass}
                    aria-label={`${copy.pathLabel} ${link.name}`}
                    aria-describedby={savedPath ? `path-note-${link.id}` : undefined}
                    value={typed ?? link.segment}
                    spellCheck={false}
                    readOnly={savedPath}
                    disabled={editingDisabled}
                    onChange={(event) => onPath(link, event.target.value)}
                  />
                </label>
                {invalid ? <p className="text-destructive text-sm">{copy.pathInvalid}</p> : null}
                {taken ? <p className="text-destructive text-sm">{copy.duplicatePath}</p> : null}
                {savedPath ? (
                  <p
                    id={`path-note-${link.id}`}
                    className="text-pretty text-muted-foreground text-sm"
                  >
                    {copy.pathEditLimited}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${copy.moveUp} ${link.name}`}
                    disabled={editingDisabled || index === 0}
                    onClick={() => put({ type: 'move', index, direction: -1 })}
                  >
                    {copy.moveUp}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${copy.moveDown} ${link.name}`}
                    disabled={editingDisabled || index === state.links.length - 1}
                    onClick={() => put({ type: 'move', index, direction: 1 })}
                  >
                    {copy.moveDown}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${copy.removeLink} ${link.name}`}
                    disabled={editingDisabled}
                    onClick={() => put({ type: 'remove', id: link.id })}
                  >
                    {copy.removeLink}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-pretty text-muted-foreground text-sm">{copy.emptyLinks}</p>
      )}
      <CollectionPageLookup actingSubject={actingSubject} copy={copy} disabled={editingDisabled} signInHref={signInHref}
        onChoose={choice => { setPicked(choice); setQuery(choice.name); setAddNotice(null); }} />
      <div className="grid max-w-md gap-2">
        <PageSearchPicker query={query} picked={picked} locale={locale} copy={copy} disabled={editingDisabled}
          signInHref={signInHref} api={client.current!}
          onQueryChange={value => { setPicked(null); setAddNotice(null); setQuery(value); }}
          onChoose={choice => { setPicked(choice); setQuery(choice.name); setAddNotice(null); }} />
        {addNotice ? <p className="text-destructive text-sm">{addNotice}</p> : null}
        <Button
          variant="secondary"
          size="sm"
          className="justify-self-start"
          disabled={!picked || editingDisabled}
          onClick={addLink}
        >
          {copy.addLink}
        </Button>
      </div>
    </section>
  );
}

function NavNotice(props: NavNoticeProps) {
  return <><NavigationWriteNotice {...props} /><NavigationPublicationNotice {...props} /></>;
}

type NavNoticeProps = {
  copy: ZoneEditorMessages;
  state: NavigationState;
  page: EditorState;
  busy: string | null;
  signInHref: string;
  ready: boolean;
  review: PublicationReview | null;
  reviewPublishDisabled: boolean;
  onReview: () => void;
  onRefresh: () => void;
  onPublishReviewed: () => void;
  onRetry: () => void;
};

function NavigationWriteNotice({
  copy,
  state,
  busy,
  signInHref,
  onReview,
  onRetry,
}: NavNoticeProps) {
  if (state.notice.kind === 'stale') {
    return (
      <NoticeAlert variant="warning" title={copy.navStaleTitle} body={copy.navStaleBody}>
        <Button
          variant="outline"
          size="sm"
          className={choiceClass}
          disabled={!!busy}
          isLoading={busy === 'load'}
          onClick={onReview}
        >
          {copy.saveLinks}
        </Button>
      </NoticeAlert>
    );
  }
  if (state.notice.kind === 'review') {
    return (
      <NoticeAlert
        variant="warning"
        title={copy.navStaleTitle}
        body={isNavigationDirty(state) ? copy.navReview : copy.navReviewClean}
      >
        {state.notice.dropped.length ? (
          <div className="space-y-1 text-sm">
            <p>{copy.navDropped}</p>
            <ul className="list-inside list-disc">
              {state.notice.dropped.map((edit, index) => (
                <li key={index}>
                  {edit.kind === 'remove' ? copy.removeLink : copy.navMove}: {edit.name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </NoticeAlert>
    );
  }
  const failure = failureCopy(copy, state.notice.kind);
  if (!failure) return null;
  return <FailureNotice copy={copy} kind={state.notice.kind} failure={failure} busy={busy} signInHref={signInHref} onRetry={onRetry} />;
}

function NavigationPublicationNotice({ copy, state, page, busy, signInHref, ready, review, reviewPublishDisabled,
  onRefresh, onPublishReviewed, onRetry }: NavNoticeProps) {
  if (page.notice.kind === 'publish-stale') {
    return (
      <>
        <NoticeAlert variant="warning" title={page.notice.problem?.title ?? copy.publishStaleTitle}
          body={page.notice.problem ? `${copy.publishStaleBody} (${page.notice.problem.code})` : copy.publishStaleBody}>
          {!review ? <Button
            variant="outline"
            size="sm"
            className={choiceClass}
            disabled={!ready || !!busy || !state.complete || isNavigationDirty(state)}
            isLoading={busy === 'load'}
            onClick={onRefresh}
          >
            {copy.refreshAndPublish}
          </Button> : null}
        </NoticeAlert>
        {review ? <PublicationReviewPanel selection={review.selection} copy={copy} busy={reviewPublishDisabled}
          onPublish={onPublishReviewed} /> : null}
      </>
    );
  }
  const failure = failureCopy(copy, page.notice.kind);
  if (!failure) return null;
  const problem = 'problem' in page.notice ? page.notice.problem : undefined;
  return <FailureNotice copy={copy} kind={page.notice.kind}
    failure={problem ? { ...failure, title: problem.title, body: `${failure.body} (${problem.code})` } : failure}
    busy={busy} signInHref={signInHref} onRetry={onRetry} />;
}

function FailureNotice({ copy, kind, failure, busy, signInHref, onRetry }: {
  copy: ZoneEditorMessages;
  kind: string;
  failure: { title: string; body: string; retry: boolean };
  busy: string | null;
  signInHref: string;
  onRetry(): void;
}) {
  return (
    <NoticeAlert
      variant={kind === 'sign-in' ? 'info' : 'destructive'}
      title={failure.title}
      body={failure.body}
    >
      {kind === 'sign-in' ? (
        <LocalizedLink
          href={signInHref}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), choiceClass)}
        >
          {copy.signInTitle}
        </LocalizedLink>
      ) : null}
      {failure.retry ? (
        <Button
          variant="outline"
          size="sm"
          className={choiceClass}
          disabled={!!busy}
          onClick={onRetry}
        >
          {copy.tryAgain}
        </Button>
      ) : null}
    </NoticeAlert>
  );
}

function NoticeAlert({
  variant,
  title,
  body,
  children,
}: {
  variant: 'warning' | 'info' | 'destructive';
  title: string;
  body: string;
  children: ReactNode;
}) {
  const actions = Children.toArray(children).filter(Boolean);
  return (
    <Alert
      variant={variant}
      role="alert"
      className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="min-w-0 space-y-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{body}</AlertDescription>
      </div>
      {actions.length ? (
        <div className="mt-3 flex w-full min-w-0 flex-wrap gap-2 sm:mt-0 sm:w-auto">{actions}</div>
      ) : null}
    </Alert>
  );
}

function failureCopy(
  copy: ZoneEditorMessages,
  kind: NavigationState['notice']['kind'] | EditorState['notice']['kind'],
): { title: string; body: string; retry: boolean } | null {
  switch (kind) {
    case 'unavailable':
      return { title: copy.unavailableTitle, body: copy.unavailableBody, retry: true };
    case 'denied':
      return { title: copy.deniedTitle, body: copy.deniedBody, retry: false };
    case 'missing':
      return { title: copy.missingTitle, body: copy.missingBody, retry: false };
    case 'invalid':
      return { title: copy.invalidTitle, body: copy.invalidBody, retry: true };
    case 'conflict':
      return { title: copy.conflictTitle, body: copy.conflictBody, retry: true };
    case 'sign-in':
      return { title: copy.signInTitle, body: copy.signInBody, retry: false };
    default:
      return null;
  }
}

function isNavigationState(value: unknown): value is NavigationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<NavigationState>;
  return Array.isArray(state.links) && Array.isArray(state.saved) && Array.isArray(state.pending)
    && typeof state.head === 'string' && typeof state.navigation === 'string'
    && typeof state.complete === 'boolean' && !!state.notice && typeof state.notice === 'object';
}

function isEditorState(value: unknown): value is EditorState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<EditorState>;
  return preparedHomeDocument(state) !== null && typeof state.value === 'string' && typeof state.zoneHead === 'string'
    && typeof state.navigationRevision === 'string' && typeof state.expectedHead !== 'undefined'
    && !!state.notice && typeof state.notice === 'object';
}
