'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { AutosaveStatus } from '@rezics/ui/autosave-status';
import { Button } from '@rezics/ui/button';
import { Editor, EditorFooter, textStats } from '@rezics/ui/editor';
import { ArrowLeftIcon, InfoIcon, SendIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import Link from '../shell/localized-link.tsx';
import { DraftAutosave, type SaveOutcome } from './autosave.ts';
import { ConflictView } from './conflict-view.tsx';
import { browserStorage, clearLocalDraft, localDraftKey, readLocalDraft, restoreDecision, writeLocalDraft }
  from './local-draft.ts';
import { studioHref } from './agent.ts';
import type { StudioMessages } from './messages.ts';
import { PublishDialog } from './publish-dialog.tsx';
import { studioAgentName } from './studio-frame.tsx';
import { languageName, textHref } from './studio-home.tsx';
import { type Publication, readLatest, saveText } from './text-api.ts';
import { idOf, type Loaded, type MainClient, type MyText, type RealmChoice } from './types.ts';

const rtl = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ug', 'ckb']);
/** The text direction of a content language (not of the interface). */
export const directionOf = (language: string): 'ltr' | 'rtl' => rtl.has(language.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';

export interface TextEditorProps {
  agent: AgentOption;
  work: { id: string; title: { value: string; language: string }; mainVersion: string };
  language: string;
  /** The text (contribution) being edited, or null for a new text in `language`. */
  text: string | null;
  /** Main's text at `head`: its current draft head when known, else the revision the address pinned. */
  initial: { head: string | null; body: string; publication: MyText['publication'] | null };
  realms: Loaded<RealmChoice[]>;
  locale: UiLocale;
  messages: StudioMessages;
  /** Autosave pause in milliseconds; stories shorten it. */
  delay?: number;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: MainClient;
}

/**
 * The writing page: the text in its own language and direction on a plain
 * ground, saved as a draft a moment after typing pauses, kept on this device
 * until Main has it, and stopped at a conflict until the writer chooses.
 * Autosave never publishes; the Publish dialog does, as the Studio Agent.
 */
export function TextEditor({ agent, work, language, text: initialText, initial, realms, locale, messages, delay = 2_500,
  main }: TextEditorProps) {
  const t = materializeData(messages, { locale });
  const dir = directionOf(language);
  const text = useRef(initialText);
  const storage = useMemo(browserStorage, []);
  const deviceKey = useRef(localDraftKey(agent.iri, work.id, initialText ?? `new:${language}`));
  const [notice, setNotice] = useState<string | null>(null);
  const [value, setValue] = useState(initial.body);
  const [theirs, setTheirs] = useState<string | null | undefined>(undefined);
  const [conflictHead, setConflictHead] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publication, setPublication] = useState<{ head: string | null; state: MyText['publication'] | null }>(
    { head: null, state: initial.publication });
  const [autosave] = useState(() => new DraftAutosave({ head: initial.head, body: initial.body, delay,
    save: (body, head, key): Promise<SaveOutcome> => body.trim()
      ? saveText({ actingSubject: agent.iri, work: work.id, language }, text.current, body, head, key, created => {
        text.current = created;
        // The device copy follows the text to its own key.
        const copy = readLocalDraft(storage, deviceKey.current);
        clearLocalDraft(storage, deviceKey.current);
        deviceKey.current = localDraftKey(agent.iri, work.id, created);
        if (copy) writeLocalDraft(storage, deviceKey.current, copy);
      }, main)
      // Main keeps no empty text; the last saved text stays until there is something to save.
      : Promise.resolve({ kind: 'failed', retryable: false }),
    keep: (body, base) => { writeLocalDraft(storage, deviceKey.current, { body, base, changedAt: new Date().toISOString() }); },
    release: () => clearLocalDraft(storage, deviceKey.current) }));
  const snapshot = useSyncExternalStore(autosave.subscribe, () => autosave.snapshot, () => autosave.snapshot);

  // Open with what this device kept: unsaved typing on the same head is restored; typing on an older head is a conflict.
  useEffect(() => {
    const decision = restoreDecision({ head: initial.head, body: initial.body }, readLocalDraft(storage, deviceKey.current));
    if (decision.kind === 'restore') {
      setValue(decision.body);
      autosave.edit(decision.body);
      setNotice(t.restored);
    } else if (decision.kind === 'conflict') {
      setValue(decision.mine);
      autosave.markConflict(decision.mine);
      setTheirs(initial.body);
      setConflictHead(initial.head);
    }
    return () => autosave.dispose();
  }, []);

  // A conflict found while saving: read the version that won, to compare.
  useEffect(() => {
    if (snapshot.state !== 'conflict' || conflictHead !== null || !text.current) return;
    let active = true;
    setTheirs(undefined);
    void readLatest(agent.iri, text.current, main).catch(() => null).then(latest => {
      if (!active) return;
      setTheirs(latest?.body ?? null);
      setConflictHead(latest?.head ?? null);
    });
    return () => { active = false; };
  }, [snapshot.state, conflictHead, agent.iri, main]);

  // Keep the address on the exact revision Studio last saved, so a reload or a shared link opens it.
  useEffect(() => {
    if (!text.current || !snapshot.head) return;
    const href = localizedPath(textHref(agent, work.id, text.current, snapshot.head), locale);
    if (`${location.pathname}${location.search}` !== href) history.replaceState(history.state, '', href);
  }, [snapshot.head, agent, work.id, locale]);

  // Save when the network returns, when the tab hides and before it closes.
  useEffect(() => {
    const flush = () => { void autosave.flush(); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', flush);
    };
  }, [autosave]);

  const change = (next: string) => {
    setValue(next);
    setNotice(next.trim() ? null : t.emptyNotSaved);
    autosave.edit(next);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void autosave.flush();
    }
  };
  const resolveMine = () => {
    autosave.keepMine(conflictHead);
    setConflictHead(null);
    setTheirs(undefined);
  };
  const resolveTheirs = () => {
    if (typeof theirs !== 'string') return;
    autosave.takeTheirs(conflictHead, theirs);
    setValue(theirs);
    setConflictHead(null);
    setTheirs(undefined);
  };
  const openPublish = async () => {
    await autosave.flush();
    if (autosave.snapshot.state === 'saved' || autosave.snapshot.state === 'idle') setPublishing(true);
    else setNotice(t.publishUnsaved);
  };
  const published = (result: Publication) => setPublication({ head: result.publicationDecision, state: 'public' });

  const stats = textStats(value, language);
  const conflict = snapshot.state === 'conflict';
  const state = snapshot.denied ? 'error' : snapshot.state;
  const canPublish = Boolean(text.current && snapshot.head && !conflict && !snapshot.denied && value.trim());
  return <div className="min-h-dvh bg-background [text-autospace:normal]">
    <div className="sticky top-0 z-10 border-border/60 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-2 sm:px-6">
        <Link href={studioHref(agent, `/works/${idOf(work.id)}`)}
          className="inline-flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/60"
          aria-label={t.backToWork}>
          <ArrowLeftIcon aria-hidden="true" className="size-4 shrink-0" />
          <span lang={work.title.language} className="truncate">{work.title.value}</span>
        </Link>
        <AutosaveStatus className="ms-auto" state={state} savedAt={snapshot.savedAt} locale={locale}
          onRetry={() => void autosave.flush()} labels={{ idle: t.autosaveIdle, unsaved: t.autosaveUnsaved,
            saving: t.autosaveSaving, saved: t.autosaveSaved, offline: t.autosaveOffline, conflict: t.autosaveConflict,
            error: snapshot.denied ? t.autosaveDenied : t.autosaveError, retry: t.retry }} />
        <Button type="button" size="sm" disabled={!canPublish} onClick={() => void openPublish()}>
          <SendIcon aria-hidden="true" />{t.publish}</Button>
      </div>
    </div>
    <div className="mx-auto grid w-full max-w-[44rem] gap-5 px-4 pt-8 pb-24 sm:px-6 sm:pt-12">
      <header className="grid gap-2">
        <p className="text-muted-foreground text-sm">{[languageName(language, locale),
          `${t.writingAs} ${studioAgentName(agent, t)}`].join(' · ')}</p>
        <h1 lang={work.title.language} className="text-balance break-words font-semibold font-work-title text-3xl/tight
          sm:text-4xl/tight">{work.title.value}</h1>
      </header>
      {notice ? <Alert variant="info"><InfoIcon aria-hidden="true" />
        <AlertDescription role="status" className="text-foreground">{notice}</AlertDescription></Alert> : null}
      {conflict ? <ConflictView mine={value} theirs={theirs} lang={language} dir={dir}
        onKeepMine={resolveMine} onTakeTheirs={resolveTheirs} labels={t} /> : null}
      <Editor aria-label={t.textLabel} lang={language} dir={dir} value={value} placeholder={t.placeholder}
        readOnly={conflict || snapshot.denied} onChange={event => change(event.target.value)} onKeyDown={keyDown}
        onBlur={() => void autosave.flush()} autoFocus={!initial.body} />
    </div>
    <div className="sticky bottom-0 border-border/60 border-t bg-background/90 backdrop-blur">
      <EditorFooter className="mx-auto w-full max-w-[44rem] px-4 py-2 sm:px-6">
        <span>{t.wordCount(stats.words)}</span><span>{t.characterCount(stats.characters)}</span>
      </EditorFooter>
    </div>
    {text.current && snapshot.head ? <PublishDialog open={publishing} onOpenChange={setPublishing} realms={realms}
      onPublished={published} locale={locale} messages={messages} main={main}
      target={{ agent, work: work.id, title: work.title, mainVersion: work.mainVersion, language, text: text.current,
        head: snapshot.head, body: value, publicationHead: publication.head }} /> : null}
  </div>;
}
