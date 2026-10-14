'use client';

import type { DocumentSnapshot } from '@rezics/document';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { Children, useRef, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { commandLane, type WriteRound } from '../api/command.ts';
import { BodyEditor } from '../document-editor/body-editor.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { browserZoneAuthoring, browserZoneNavigation, browserZoneTheme, choiceWire, commitCommand, type PublishedSite, type SavedDraft, type WriteResult, type ZoneAuthoringClient, type ZoneNavigationClient, type ZoneThemeClient } from './api.ts';
import { EditorActions } from './editor-actions.tsx';
import { ZoneHomeDocument } from './home-document.tsx';
import { useZoneEditorDraft, useZoneEditorExitActions, useZoneEditorRef, useZoneEditorSessionState } from './draft-provider.tsx';
import { confirmPublicationReview, readSavedPublicationSelection, reviewedPublicationChoice, stagePublicationReview,
  type PublicationReview } from './publication-review.ts';
import { PublicationReviewPanel } from './publication-review-panel.tsx';
import type { ZoneEditorMessages } from './messages.ts';
import {
  preparedHomeDocument, blankDocument, canPublish, draftChoice, isDirty, publicationChoice, publicationStatus, reduceEditor,
  type DraftChoice, type EditorState, type PublicationChoice,
} from './model.ts';

const choiceClass = 'h-auto min-h-9 w-auto whitespace-normal px-3 sm:h-9 sm:whitespace-nowrap';

/**
 * Write, save and publish one Zone home page. A lost response retries the same command key.
 * A stale save keeps the text in the field and waits for the author to choose.
 */
export function ZoneHomeEditor({ zoneId, actingSubject, locale, copy, initial, editable, document, previewHref, siteHref, signInHref, api, navigationApi, themeApi }: {
  zoneId: string;
  zoneIri: string;
  actingSubject: string;
  locale: UiLocale;
  copy: ZoneEditorMessages;
  initial: EditorState;
  editable: boolean;
  document: DocumentSnapshot | null;
  previewHref: string;
  siteHref: string;
  signInHref: string;
  api?: ZoneAuthoringClient;
  navigationApi?: ZoneNavigationClient;
  themeApi?: ZoneThemeClient;
}) {
  const [state, dispatch, draftReady] = useZoneEditorDraft('home', initial, isDirty, isEditorState);
  const [canEdit, setCanEdit] = useState(editable);
  const [reading, setReading] = useState(document);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useZoneEditorSessionState<null | 'save' | 'publish' | 'load'>('home-busy', null);
  const [intent, setIntent] = useZoneEditorSessionState<null | 'save' | 'publish' | 'load' | 'review'>('home-intent', null);
  const [review, setReview] = useZoneEditorSessionState<PublicationReview | null>('home-review', null);
  const stateRef = useZoneEditorRef('home-state', state);
  stateRef.current = state;
  const inflight = useZoneEditorRef('home-inflight', 0);
  function put(event: Parameters<typeof reduceEditor>[1]) {
    dispatch(current => {
      const next = reduceEditor(current, event);
      stateRef.current = next;
      return next;
    });
  }
  const client = useRef<ZoneAuthoringClient | null>(null);
  const navigation = useRef<ZoneNavigationClient | null>(null);
  const theme = useRef<ZoneThemeClient | null>(null);
  if (!client.current) client.current = api ?? browserZoneAuthoring();
  if (!navigation.current) navigation.current = navigationApi ?? browserZoneNavigation();
  if (!theme.current) theme.current = themeApi ?? browserZoneTheme();
  const saveLane = useZoneEditorRef<ReturnType<typeof commandLane<DraftChoice, WriteResult<SavedDraft>>> | null>('home-save-lane', null);
  const publishLane = useZoneEditorRef<ReturnType<typeof commandLane<PublicationChoice, WriteResult<PublishedSite>>> | null>('home-publish-lane', null);
  const saveChoice = useZoneEditorRef<DraftChoice | null>('home-save-choice', null);
  const publishChoice = useZoneEditorRef<PublicationChoice | null>('home-publish-choice', null);
  if (!saveLane.current) saveLane.current = commandLane({ ok: false, failure: 'unavailable' });
  if (!publishLane.current) publishLane.current = commandLane({ ok: false, failure: 'unavailable' });
  const dirty = isDirty(state) || saveChoice.current !== null;
  useZoneEditorExitActions('home', async () => {
    if (!canEdit || !preparedHomeDocument(stateRef.current) || inflight.current || stateRef.current.notice.kind === 'stale') return false;
    if (publishChoice.current) {
      const published = await publishLane.current!.submit(publishChoice.current, applyPublish);
      if (!published.ok) return false;
    }
    if (!saveChoice.current && !isDirty(stateRef.current)) return true;
    saveChoice.current ??= draftChoice(stateRef.current, actingSubject);
    const result = await saveLane.current!.submit(saveChoice.current, applySave);
    return result.ok && !isDirty(stateRef.current);
  }, () => {
    saveChoice.current = null;
    publishChoice.current = null;
    dispatch(current => ({ ...current, value: current.savedValue ?? blankDocument(), notice: { kind: 'idle' } }));
  }, () => saveChoice.current !== null || publishChoice.current !== null);

  function track(kind: 'save' | 'publish' | 'load', work: Promise<unknown>) {
    inflight.current += 1;
    setBusy(kind);
    setIntent(kind);
    void work.finally(() => {
      inflight.current -= 1;
      if (inflight.current === 0) setBusy(null);
    });
  }

  function applySave(chosen: DraftChoice, round: WriteRound) {
    const live = stateRef.current;
    // A double click queued the same text after this tab's own save moved the head. It is already stored.
    if (live.expectedHead !== chosen.expectedHead && live.savedValue === chosen.savedValue && live.basis) {
      saveChoice.current = null;
      return Promise.resolve({ ok: true as const, data: { ...live.basis, replayed: true } });
    }
    return commitCommand(round, key => client.current!.saveDraft(choiceWire(chosen), key)).then(result => {
      if (result.ok) put({ type: 'saved', captured: chosen.captured, savedValue: chosen.savedValue, basis: result.data, replayed: result.data.replayed });
      else if (result.failure === 'stale') put({ type: 'stale', currentHead: result.currentHead });
      else put({ type: 'failed', failure: result.failure });
      if (result.ok || result.failure !== 'unavailable') saveChoice.current = null;
      return result;
    });
  }

  function applyPublish(chosen: PublicationChoice, round: WriteRound) {
    return commitCommand(round, key => client.current!.publish(chosen, actingSubject, key, zoneId)).then(result => {
      if (result.ok) put({ type: 'published', ...result.data, revisionId: chosen.revisionId });
      else if (result.failure === 'stale') { setReview(null); put({ type: 'publish-stale', problem: result.problem }); }
      else put({ type: 'failed', failure: result.failure, problem: result.problem });
      if (result.ok || result.failure !== 'unavailable') publishChoice.current = null;
      return result;
    });
  }

  function save(next: EditorState = stateRef.current) {
    if (!canEdit || !preparedHomeDocument(next) || busy || !draftReady) return;
    saveChoice.current ??= draftChoice(next, actingSubject);
    track('save', saveLane.current!.submit(saveChoice.current, applySave));
  }

  function publish(next: EditorState = stateRef.current) {
    const choice = publishChoice.current ?? publicationChoice(next);
    if (!choice || busy || !draftReady) return;
    publishChoice.current = choice;
    track('publish', publishLane.current!.submit(choice, applyPublish));
  }

  function saveOver() {
    const notice = stateRef.current.notice;
    if (notice.kind !== 'stale' || !notice.currentHead || busy) return;
    const next = reduceEditor(stateRef.current, { type: 'retarget', currentHead: notice.currentHead });
    stateRef.current = next;
    put({ type: 'retarget', currentHead: notice.currentHead });
    save(next);
  }

  function loadTheirs() {
    if (busy || !draftReady) return;
    track('load', client.current!.readDraft(zoneId, actingSubject).then(result => {
      if (!result.ok) {
        put({ type: 'failed', failure: result.failure === 'stale' ? 'conflict' : result.failure });
        return;
      }
      put({ type: 'loaded', ...result.data });
      setCanEdit(result.data.editable);
      setReading(result.data.document);
      setGeneration(current => current + 1);
    }));
  }

  function refreshAndPublish() {
    if (busy || !draftReady) return;
    setReview(null);
    const work = readSavedPublicationSelection(zoneId, actingSubject, {
      authoring: client.current!, navigation: navigation.current!, theme: theme.current!,
    }).then(result => {
      if (result.ok) setReview(stagePublicationReview(result.data));
      else if (result.failure === 'stale') put({ type: 'publish-stale' });
      else put({ type: 'failed', failure: result.failure });
    }).catch(() => put({ type: 'failed', failure: 'unavailable' }));
    track('load', work);
    setIntent('review');
  }

  function publishReviewed() {
    if (!review || busy) return;
    const confirmed = confirmPublicationReview(review);
    const choice = reviewedPublicationChoice(stateRef.current, confirmed);
    if (!choice) return;
    setReview(null);
    put({ type: 'heads', zoneHead: review.selection.zoneHead,
      navigationRevision: review.selection.navigationRevision });
    publishChoice.current = choice;
    track('publish', publishLane.current!.submit(choice, applyPublish));
  }

  function tryAgain() {
    if (intent === 'review') refreshAndPublish();
    else if (state.notice.kind === 'publish-stale') refreshAndPublish();
    else if (intent === 'publish') publish();
    else if (intent === 'load') loadTheirs();
    else save();
  }

  const status = publicationStatus(state);
  const statusText = status === 'live' ? copy.statusLive : status === 'behind' ? copy.statusBehind : copy.statusPrivate;
  const notice = state.notice.kind === 'saved' ? (state.notice.replayed ? copy.savedReplayed : copy.saved)
    : state.notice.kind === 'published' ? (state.notice.replayed ? copy.publishedReplayed : copy.published)
    : state.notice.kind === 'loaded' ? copy.loaded : null;

  return <section className="grid min-w-0 gap-3" aria-labelledby="zone-home-title">
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="zone-home-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.homeTitle}</h2>
        <EditorActions copy={copy} canEdit={canEdit} busy={busy}
          saveDisabled={!draftReady || !preparedHomeDocument(state) || !!busy || !dirty || state.notice.kind === 'stale'}
          publishDisabled={!draftReady || !!busy || saveChoice.current !== null || !canPublish(state) || state.notice.kind === 'publish-stale'}
          onSave={() => save()} onPublish={() => publish()} previewHref={previewHref} siteHref={siteHref} />
      </div>
      <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{copy.homeHelp}</p>
      <p className="text-sm" role="status">{statusText}</p>
    </div>
    {notice ? <p className="text-sm" role="status">{notice}</p> : null}
    {dirty && canEdit ? <p className="text-pretty text-muted-foreground text-sm">{copy.saveFirst}</p> : null}
    {!canEdit ? <Alert variant="info">
      <AlertTitle>{copy.protectedTitle}</AlertTitle>
      <AlertDescription>{copy.protectedBody}</AlertDescription>
    </Alert> : null}
    <EditorNotice copy={copy} state={state} busy={busy} signInHref={signInHref} review={review}
      onSaveOver={saveOver} onLoad={loadTheirs} onRefresh={refreshAndPublish} onPublishReviewed={publishReviewed} onRetry={tryAgain} />
    {canEdit ? <BodyEditor key={generation} label={copy.editorLabel} locale={locale} allowAdvanced disabled={!draftReady || busy === 'load'} value={state.value}
      lang={state.language.tag === 'und' ? undefined : state.language.tag}
      dir={state.direction === 'none' ? undefined : state.direction}
      onChange={value => put({ type: 'edit', value })} />
      : reading ? <ZoneHomeDocument document={reading} className="max-w-3xl text-pretty leading-7" /> : null}
  </section>;
}

function isEditorState(value: unknown): value is EditorState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<EditorState>;
  return preparedHomeDocument(state) !== null && typeof state.value === 'string' && typeof state.zoneHead === 'string'
    && typeof state.navigationRevision === 'string' && typeof state.expectedHead !== 'undefined'
    && !!state.notice && typeof state.notice === 'object';
}

function EditorNotice({ copy, state, busy, signInHref, review, onSaveOver, onLoad, onRefresh, onPublishReviewed, onRetry }: {
  copy: ZoneEditorMessages;
  state: EditorState;
  busy: string | null;
  signInHref: string;
  review: PublicationReview | null;
  onSaveOver: () => void;
  onLoad: () => void;
  onRefresh: () => void;
  onPublishReviewed: () => void;
  onRetry: () => void;
}) {
  const notice = state.notice;
  if (notice.kind === 'stale') {
    return <NoticeAlert variant="warning" title={copy.staleTitle} body={copy.staleBody}>
      {notice.currentHead ? <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy} onClick={onSaveOver}>{copy.saveOver}</Button> : null}
      <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy} isLoading={busy === 'load'} onClick={onLoad}>{copy.loadTheirs}</Button>
    </NoticeAlert>;
  }
  if (notice.kind === 'publish-stale') {
    return <>
      <NoticeAlert variant="warning" title={notice.problem?.title ?? copy.publishStaleTitle} body={notice.problem ? `${copy.publishStaleBody} (${notice.problem.code})` : copy.publishStaleBody}>
        {!review ? <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy}
          isLoading={busy === 'load'} onClick={onRefresh}>{copy.refreshAndPublish}</Button> : null}
      </NoticeAlert>
      {review ? <PublicationReviewPanel selection={review.selection} copy={copy}
        busy={!!busy || !reviewedPublicationChoice(state, confirmPublicationReview(review))} onPublish={onPublishReviewed} /> : null}
    </>;
  }
  const failure = failureCopy(copy, notice.kind);
  if (!failure) return null;
  const problem = 'problem' in notice ? notice.problem : undefined;
  return <NoticeAlert variant={notice.kind === 'sign-in' ? 'info' : 'destructive'} title={problem?.title ?? failure.title} body={problem ? `${failure.body} (${problem.code})` : failure.body}>
    {notice.kind === 'sign-in' ? <LocalizedLink href={signInHref} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), choiceClass)}>{copy.signInTitle}</LocalizedLink> : null}
    {failure.retry ? <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy} onClick={onRetry}>{copy.tryAgain}</Button> : null}
  </NoticeAlert>;
}

/** A long explanation stays one column on a phone. Beside it, the choices sit on a wider screen. */
function NoticeAlert({ variant, title, body, children }: {
  variant: 'warning' | 'info' | 'destructive'; title: string; body: string; children: ReactNode;
}) {
  const actions = Children.toArray(children).filter(Boolean);
  return <Alert variant={variant} role="alert" className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
    <div className="min-w-0 space-y-1">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </div>
    {actions.length ? <NoticeActions>{actions}</NoticeActions> : null}
  </Alert>;
}

function NoticeActions({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex w-full min-w-0 flex-wrap gap-2 sm:mt-0 sm:w-auto">{children}</div>;
}

function failureCopy(copy: ZoneEditorMessages, kind: EditorState['notice']['kind']): { title: string; body: string; retry: boolean } | null {
  switch (kind) {
    case 'unavailable': return { title: copy.unavailableTitle, body: copy.unavailableBody, retry: true };
    case 'denied': return { title: copy.deniedTitle, body: copy.deniedBody, retry: false };
    case 'missing': return { title: copy.missingTitle, body: copy.missingBody, retry: false };
    case 'invalid': return { title: copy.invalidTitle, body: copy.invalidBody, retry: true };
    case 'conflict': return { title: copy.conflictTitle, body: copy.conflictBody, retry: true };
    case 'sign-in': return { title: copy.signInTitle, body: copy.signInBody, retry: false };
    default: return null;
  }
}
