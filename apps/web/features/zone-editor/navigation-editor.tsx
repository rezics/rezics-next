'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { commandLane, type WriteRound } from '../api/command.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import {
  browserZoneAuthoring, browserZoneNavigation, commitCommand, pageSearchReady,
  type PageChoice, type WriteResult, type ZoneAuthoringClient, type ZoneNavigationClient,
} from './api.ts';
import { EditorActions } from './editor-actions.tsx';
import type { ZoneEditorMessages } from './messages.ts';
import {
  canPublish, publicationChoice, reduceEditor,
  type EditorState, type PublicationChoice,
} from './model.ts';
import {
  alignLinks, commitNavigation, isNavigationDirty, isSegment, reduceNavigation, segmentFor,
  type NavigationState, type SiteLink,
} from './navigation.ts';

const choiceClass = 'h-auto min-h-9 w-auto whitespace-normal px-3 sm:h-9 sm:whitespace-nowrap';
type SavedLinks = { head: string; links: SiteLink[]; replayed: boolean };
const fieldClass = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Edit the Zone's navigation and publish it with the home page.
 * A lost response retries the same command key. A stale save keeps the author's links.
 * Readers see a page's own name; the path is only the address.
 */
export function ZoneNavigationEditor({ zoneId, zoneIri, actingSubject, locale, copy, initial, home, previewHref, siteHref, signInHref, api, authoring }: {
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
}) {
  const [state, dispatch] = useState(initial);
  const [page, setPage] = useState(home);
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'load'>(null);
  const [intent, setIntent] = useState<null | 'save' | 'publish' | 'load'>(null);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<PageChoice[]>([]);
  const [picked, setPicked] = useState<PageChoice | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [addNotice, setAddNotice] = useState<string | null>(null);
  const [searched, setSearched] = useState<string | null>(null);
  const stateRef = useRef(state);
  const pageRef = useRef(page);
  stateRef.current = state;
  pageRef.current = page;
  const inflight = useRef(0);
  function put(event: Parameters<typeof reduceNavigation>[1]) {
    dispatch(current => {
      const next = reduceNavigation(current, event);
      stateRef.current = next;
      return next;
    });
  }
  function putPage(event: Parameters<typeof reduceEditor>[1]) {
    setPage(current => {
      const next = reduceEditor(current, event);
      pageRef.current = next;
      return next;
    });
  }
  const client = useRef<ZoneNavigationClient | null>(null);
  const pages = useRef<ZoneAuthoringClient | null>(null);
  if (!client.current) client.current = api ?? browserZoneNavigation();
  if (!pages.current) pages.current = authoring ?? browserZoneAuthoring();
  const saveLane = useRef<ReturnType<typeof commandLane<NavigationState, WriteResult<{ head: string; links: SiteLink[]; replayed: boolean }>>> | null>(null);
  const publishLane = useRef<ReturnType<typeof commandLane<PublicationChoice, WriteResult<{ zoneHead: string; replayed: boolean }>>> | null>(null);
  if (!saveLane.current) saveLane.current = commandLane({ ok: false, failure: 'unavailable' });
  if (!publishLane.current) publishLane.current = commandLane({ ok: false, failure: 'unavailable' });
  const dirty = isNavigationDirty(state);

  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  useEffect(() => {
    if (picked && query === picked.name) return;
    if (!pageSearchReady(query)) {
      setChoices([]);
      setSearched(null);
      return;
    }
    let cancel = false;
    setSearched(null);
    const handle = setTimeout(() => {
      void client.current!.findPages(query, locale).then(found => {
        if (cancel) return;
        setChoices(found);
        setSearched(query);
      });
    }, 200);
    return () => {
      cancel = true;
      clearTimeout(handle);
    };
  }, [query, picked, locale]);

  function track(kind: 'save' | 'publish' | 'load', work: Promise<unknown>) {
    inflight.current += 1;
    setBusy(kind);
    setIntent(kind);
    void work.finally(() => {
      inflight.current -= 1;
      if (inflight.current === 0) setBusy(null);
    });
  }

  function applySave(chosen: NavigationState, round: WriteRound): Promise<WriteResult<SavedLinks>> {
    return commitCommand(round, async key => {
      const result = await commitNavigation(chosen.saved, chosen.links, chosen.head, key, (op, opKey, expectedHead) => {
        if (op.kind === 'remove') {
          return client.current!.removeMount(zoneId, op.occurrence.slice(-36), { expectedHead, actingSubject }, opKey);
        }
        return client.current!.insertMount(zoneId, {
          expectedHead, target: op.target, routeSegment: op.segment, disclosure: op.disclosure, position: 'last', actingSubject,
        }, opKey);
      });
      if (result.ok) return { ok: true, data: { head: result.head, links: result.links, replayed: result.replayed } };
      if (result.failure === 'stale') return { ok: false, failure: 'stale', currentHead: result.currentHead };
      return { ok: false, failure: result.failure };
    });
  }

  function applyPublish(chosen: PublicationChoice, round: WriteRound) {
    return commitCommand(round, key => pages.current!.publish(chosen, actingSubject, key)).then(result => {
      if (result.ok) putPage({ type: 'published', zoneHead: result.data.zoneHead, replayed: result.data.replayed });
      else if (result.failure === 'stale') putPage({ type: 'publish-stale' });
      else put({ type: 'failed', failure: result.failure });
      return result;
    });
  }

  function save(next: NavigationState = stateRef.current) {
    if (busy || !isNavigationDirty(next)) return;
    track('save', saveLane.current!.submit(next, applySave).then(result => {
      if (result.ok) put({ type: 'saved', links: result.data.links, head: result.data.head, replayed: result.data.replayed });
      else if (result.failure === 'stale') put({ type: 'stale', currentHead: result.currentHead });
      else put({ type: 'failed', failure: result.failure });
    }));
  }

  function siteChoice(navHead: string): PublicationChoice | null {
    const choice = publicationChoice(pageRef.current, zoneIri);
    if (!choice || isNavigationDirty(stateRef.current)) return null;
    return { ...choice, navigationRevision: navHead, routesRevision: navHead };
  }

  function publish() {
    const choice = siteChoice(stateRef.current.head);
    if (!choice || busy) return;
    track('publish', publishLane.current!.submit(choice, applyPublish));
  }

  function saveOver() {
    if (busy || stateRef.current.notice.kind !== 'stale') return;
    track('save', client.current!.readNavigation(zoneId, actingSubject).then(async read => {
      if (!read.ok) {
        put({ type: 'failed', failure: read.failure === 'stale' ? 'conflict' : read.failure });
        return;
      }
      const links = alignLinks(stateRef.current.links, read.data.links);
      const next = reduceNavigation(stateRef.current, { type: 'retarget', head: read.data.head, saved: read.data.links, links });
      stateRef.current = next;
      put({ type: 'retarget', head: read.data.head, saved: read.data.links, links });
      if (!isNavigationDirty(next)) {
        put({ type: 'saved', links: next.links, head: next.head, replayed: false });
        return;
      }
      const result = await saveLane.current!.submit(next, applySave);
      if (result.ok) put({ type: 'saved', links: result.data.links, head: result.data.head, replayed: result.data.replayed });
      else if (result.failure === 'stale') put({ type: 'stale', currentHead: result.currentHead });
      else put({ type: 'failed', failure: result.failure });
    }));
  }

  function loadTheirs() {
    if (busy) return;
    track('load', client.current!.readNavigation(zoneId, actingSubject).then(result => {
      if (!result.ok) {
        put({ type: 'failed', failure: result.failure === 'stale' ? 'conflict' : result.failure });
        return;
      }
      setPaths({});
      put({ type: 'loaded', links: result.data.links, head: result.data.head });
    }));
  }

  function refreshAndPublish() {
    if (busy) return;
    track('publish', pages.current!.readHeads(zoneId, actingSubject).then(async heads => {
      if (!heads.ok) {
        put({ type: 'failed', failure: heads.failure === 'stale' ? 'conflict' : heads.failure });
        return;
      }
      const nextPage = reduceEditor(pageRef.current, { type: 'heads', zoneHead: heads.data.zoneHead, navigationRevision: heads.data.navigationRevision });
      pageRef.current = nextPage;
      putPage({ type: 'heads', zoneHead: heads.data.zoneHead, navigationRevision: heads.data.navigationRevision });
      if (!isNavigationDirty(stateRef.current) && stateRef.current.head !== heads.data.navigationRevision) {
        const next = reduceNavigation(stateRef.current, {
          type: 'retarget', head: heads.data.navigationRevision, saved: stateRef.current.saved, links: stateRef.current.links,
        });
        stateRef.current = next;
        put({ type: 'retarget', head: heads.data.navigationRevision, saved: next.saved, links: next.links });
      }
      const choice = siteChoice(stateRef.current.head);
      if (!choice) {
        put({ type: 'failed', failure: 'unavailable' });
        return;
      }
      await publishLane.current!.submit(choice, applyPublish);
    }));
  }

  function tryAgain() {
    if (page.notice.kind === 'publish-stale') refreshAndPublish();
    else if (intent === 'publish') publish();
    else if (intent === 'load') loadTheirs();
    else save();
  }

  function addLink() {
    if (!picked) return;
    const segment = segmentFor(picked.name, state.links.map(link => link.segment));
    if (!segment) {
      setAddNotice(copy.pathInvalid);
      return;
    }
    if (state.links.some(link => link.target === picked.target || link.segment === segment)) {
      setAddNotice(copy.duplicatePath);
      return;
    }
    setAddNotice(null);
    put({
      type: 'add',
      link: { id: crypto.randomUUID(), occurrence: null, target: picked.target, name: picked.name, segment, disclosure: 'public' },
    });
    setPicked(null);
    setQuery('');
    setChoices([]);
  }

  function onPath(link: SiteLink, value: string) {
    setPaths(current => ({ ...current, [link.id]: value }));
    if (value === link.segment || !isSegment(value)) return;
    if (state.links.some(other => other.id !== link.id && other.segment === value)) return;
    put({ type: 'segment', id: link.id, segment: value });
  }

  const savedNotice = state.notice.kind === 'saved' ? copy.navSaved : state.notice.kind === 'loaded' ? copy.navLoaded : null;
  const published = page.notice.kind === 'published' ? (page.notice.replayed ? copy.publishedReplayed : copy.published) : null;
  const publishable = Boolean(siteChoice(state.head));

  return <section className="grid min-w-0 gap-3" aria-labelledby="zone-navigation-title">
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="zone-navigation-title" className="font-semibold text-lg tracking-tight sm:text-xl">{copy.navTitle}</h2>
        <EditorActions copy={copy} canEdit busy={busy} dirty={dirty}
          saveDisabled={!!busy || !dirty || state.notice.kind === 'stale'}
          publishDisabled={!!busy || !publishable || page.notice.kind === 'publish-stale'}
          onSave={() => save()} onPublish={() => publish()} previewHref={previewHref} siteHref={siteHref} />
      </div>
      <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{copy.navHelp}</p>
      <p className="text-sm" role="status">{copy.navStatus}</p>
    </div>
    {savedNotice ? <p className="text-sm" role="status">{savedNotice}</p> : null}
    {state.notice.kind === 'saved' ? <p className="text-pretty text-muted-foreground text-sm">{copy.navSavedHint}</p> : null}
    {published ? <p className="text-sm" role="status">{published}</p> : null}
    {dirty ? <p className="text-pretty text-muted-foreground text-sm">{copy.navSaveFirst}</p> : null}
    {!dirty && !canPublish(page) ? <p className="text-pretty text-muted-foreground text-sm">{copy.saveFirst}</p> : null}
    <NavNotice copy={copy} state={state} page={page} busy={busy} signInHref={signInHref}
      onSaveOver={saveOver} onLoad={loadTheirs} onRefresh={refreshAndPublish} onRetry={tryAgain} />
    {state.links.length ? <ul aria-label={copy.linksLabel} className="grid gap-2">
      {state.links.map((link, index) => {
        const typed = paths[link.id];
        const invalid = typed !== undefined && typed !== link.segment && !isSegment(typed);
        const taken = typed !== undefined && isSegment(typed) && state.links.some(other => other.id !== link.id && other.segment === typed);
        return <li key={link.id} className="grid gap-2 rounded-xl border border-border/60 p-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="min-w-0 truncate font-medium">{link.name}</p>
            {link.disclosure === 'private' ? <span className="shrink-0 text-muted-foreground text-xs">{copy.privateLink}</span> : null}
          </div>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">{copy.pathLabel}</span>
            <input className={fieldClass} aria-label={`${copy.pathLabel} ${link.name}`} value={typed ?? link.segment}
              spellCheck={false} onChange={event => onPath(link, event.target.value)} />
          </label>
          {invalid ? <p className="text-destructive text-sm">{copy.pathInvalid}</p> : null}
          {taken ? <p className="text-destructive text-sm">{copy.duplicatePath}</p> : null}
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="sm" aria-label={`${copy.moveUp} ${link.name}`} disabled={!!busy || index === 0}
              onClick={() => put({ type: 'move', index, direction: -1 })}>{copy.moveUp}</Button>
            <Button variant="ghost" size="sm" aria-label={`${copy.moveDown} ${link.name}`} disabled={!!busy || index === state.links.length - 1}
              onClick={() => put({ type: 'move', index, direction: 1 })}>{copy.moveDown}</Button>
            <Button variant="ghost" size="sm" aria-label={`${copy.removeLink} ${link.name}`} disabled={!!busy}
              onClick={() => put({ type: 'remove', id: link.id })}>{copy.removeLink}</Button>
          </div>
        </li>;
      })}
    </ul> : <p className="text-pretty text-muted-foreground text-sm">{copy.emptyLinks}</p>}
    <div className="grid max-w-md gap-2">
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{copy.addPage}</span>
        <input className={fieldClass} value={query} placeholder={copy.addPagePlaceholder}
          onChange={event => { setPicked(null); setAddNotice(null); setQuery(event.target.value); }} />
      </label>
      {searched === query && pageSearchReady(query) && !picked && choices.length === 0 ? <p className="text-muted-foreground text-sm">{copy.noPageMatches}</p> : null}
      {choices.length && !picked ? <ul role="listbox" aria-label={copy.addPage} className="grid rounded-md border border-border/60">
        {choices.map(choice => <li key={choice.target}>
          <button type="button" role="option" aria-selected={false} className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
            onClick={() => { setPicked(choice); setQuery(choice.name); setChoices([]); setAddNotice(null); }}>
            {choice.name}
          </button>
        </li>)}
      </ul> : null}
      {addNotice ? <p className="text-destructive text-sm">{addNotice}</p> : null}
      <Button variant="secondary" size="sm" className="justify-self-start" disabled={!picked || !!busy} onClick={addLink}>{copy.addLink}</Button>
    </div>
  </section>;
}

function NavNotice({ copy, state, page, busy, signInHref, onSaveOver, onLoad, onRefresh, onRetry }: {
  copy: ZoneEditorMessages;
  state: NavigationState;
  page: EditorState;
  busy: string | null;
  signInHref: string;
  onSaveOver: () => void;
  onLoad: () => void;
  onRefresh: () => void;
  onRetry: () => void;
}) {
  if (state.notice.kind === 'stale') {
    return <NoticeAlert variant="warning" title={copy.navStaleTitle} body={copy.navStaleBody}>
      <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy} onClick={onSaveOver}>{copy.saveLinks}</Button>
      <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy} isLoading={busy === 'load'} onClick={onLoad}>{copy.loadLinks}</Button>
    </NoticeAlert>;
  }
  if (page.notice.kind === 'publish-stale') {
    return <NoticeAlert variant="warning" title={copy.publishStaleTitle} body={copy.publishStaleBody}>
      <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy} onClick={onRefresh}>{copy.refreshAndPublish}</Button>
    </NoticeAlert>;
  }
  const failure = failureCopy(copy, state.notice.kind);
  if (!failure) return null;
  return <NoticeAlert variant={state.notice.kind === 'sign-in' ? 'info' : 'destructive'} title={failure.title} body={failure.body}>
    {state.notice.kind === 'sign-in' ? <LocalizedLink href={signInHref} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), choiceClass)}>{copy.signInTitle}</LocalizedLink> : null}
    {failure.retry ? <Button variant="outline" size="sm" className={choiceClass} disabled={!!busy} onClick={onRetry}>{copy.tryAgain}</Button> : null}
  </NoticeAlert>;
}

function NoticeAlert({ variant, title, body, children }: {
  variant: 'warning' | 'info' | 'destructive'; title: string; body: string; children: ReactNode;
}) {
  const actions = Children.toArray(children).filter(Boolean);
  return <Alert variant={variant} role="alert" className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
    <div className="min-w-0 space-y-1">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </div>
    {actions.length ? <div className="mt-3 flex w-full min-w-0 flex-wrap gap-2 sm:mt-0 sm:w-auto">{actions}</div> : null}
  </Alert>;
}

function failureCopy(copy: ZoneEditorMessages, kind: NavigationState['notice']['kind'] | EditorState['notice']['kind']): { title: string; body: string; retry: boolean } | null {
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
