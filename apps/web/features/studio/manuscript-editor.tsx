'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { AutosaveStatus } from '@rezics/ui/autosave-status';
import { EditorFooter } from '@rezics/ui/editor';
import { ArrowLeftIcon, InfoIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import Link from '../shell/localized-link.tsx';
import { DraftAutosave, type SaveOutcome } from './autosave.ts';
import { ConflictView } from './conflict-view.tsx';
import { manuscriptLength } from './counts.ts';
import {
  browserStorage,
  clearLocalDraft,
  readLocalDraft,
  restoreDecision,
  writeLocalDraft,
} from './local-draft.ts';
import type { StudioMessages } from './messages.ts';
import { lengthLabel } from './parts.tsx';
import { BodyEditor } from '../document-editor/body-editor.tsx';
import { bodyText, hasBodyContent } from '../document-editor/body.ts';
import { chapterDraft, chapterDraftValue, restoreChapterDraft } from './chapter-draft.ts';

/** Same-device announcement of a saved draft; the channel is same-origin, and drafts are the writer's own. */
interface TabSave {
  channel: string;
  head: string;
  body: string;
}
const TAB_CHANNEL = 'rezics:studio:saves';

/**
 * Where a manuscript lives in Main: a Work's text (a text contribution) or a
 * chapter (a Content variant). The editor, its autosave and its conflict
 * handling are the same for both; only these calls differ.
 */
export interface ManuscriptStore {
  /** The device copy's key; a new text moves to its own key after its first save. */
  deviceKey(): string;
  save(body: string, expectedHead: string | null, idempotencyKey: string): Promise<SaveOutcome>;
  /** The version that won a conflict: the one at `head` when Main named it, else the latest Main can give. */
  theirs(head: string | null): Promise<{ head: string; body: string } | null>;
  /** The address that reopens this exact saved head, or null while there is nothing saved. */
  href(head: string): string | null;
  /** What other tabs announce this manuscript's saves under, or null before its first save. */
  channel(): string | null;
}

export interface PublishSlot {
  /** Saves what is typed and returns the exact saved snapshot, including a head created by that save. */
  prepare: () => Promise<{ head: string; body: string } | null>;
  head: string | null;
  body: string;
  /** Nothing stands in the way: saved at least once, no conflict, not refused, not empty. */
  ready: boolean;
  /** Tells the writer why publishing cannot go ahead. */
  say: (message: string) => void;
}

export interface ManuscriptEditorProps {
  actingSubject?: string;
  mediaTarget?: string;
  store: ManuscriptStore;
  language: string;
  direction: 'ltr' | 'rtl';
  /** Direction of the placeholder, which is interface copy. Defaults to the manuscript's direction. */
  placeholderDirection?: 'ltr' | 'rtl';
  back: { href: string; label: string; title: { value: string; language: string } };
  /** The line above the title: where this text belongs and who writes it. */
  context: string;
  title: { value: string; language: string };
  initial: { head: string | null; body: string };
  /** Said once on opening, such as that this device has not written this chapter before. */
  notice?: string | null;
  /** The publish control for this kind of manuscript. */
  publish: (slot: PublishSlot) => ReactNode;
  label: string;
  locale: UiLocale;
  messages: StudioMessages;
  /** Autosave pause in milliseconds; stories shorten it. */
  delay?: number;
  /** Post-only augmentations share this draft's saves and conflict resolution. */
  authorNotes?: boolean;
}

/**
 * The writing page: the text in its own language and direction on a plain
 * ground, saved as a draft a moment after typing pauses, kept on this device
 * until Main has it, and stopped at a conflict until the writer chooses.
 * Autosave never publishes; the publish control does, as the Studio Agent.
 */
export function ManuscriptEditor({
  actingSubject,
  mediaTarget,
  store,
  language,
  direction,
  placeholderDirection,
  back,
  context,
  title,
  initial,
  notice: opening = null,
  publish,
  label,
  locale,
  messages,
  delay = 2_500,
  authorNotes = false,
}: ManuscriptEditorProps) {
  const t = materializeData(messages, { locale });
  const storage = useMemo(browserStorage, []);
  const [notice, setNotice] = useState<string | null>(opening);
  const [value, setValue] = useState(initial.body);
  const [theirs, setTheirs] = useState<string | null | undefined>(undefined);
  const [conflictHead, setConflictHead] = useState<string | null>(null);
  const [autosave] = useState(
    () =>
      new DraftAutosave({
        head: initial.head,
        body: initial.body,
        delay,
        save: (body, head, key): Promise<SaveOutcome> => store.save(body, head, key),
        keep: (body, base) => {
          writeLocalDraft(storage, store.deviceKey(), {
            body,
            base,
            changedAt: new Date().toISOString(),
            ...(authorNotes ? { format: 'post' as const } : {}),
          });
        },
        release: () => clearLocalDraft(storage, store.deviceKey()),
      }),
  );
  const snapshot = useSyncExternalStore(
    autosave.subscribe,
    () => autosave.snapshot,
    () => autosave.snapshot,
  );

  // Open with what this device kept: unsaved typing on the same head is restored; typing on an older head is a conflict.
  useEffect(() => {
    const local = readLocalDraft(storage, store.deviceKey());
    const decision = restoreDecision(
      { head: initial.head, body: initial.body },
      authorNotes && local ? { ...local, body: restoreChapterDraft(local.body, chapterDraft(initial.body).notes,
        local.format === 'post' ? 'post' : undefined, chapterDraft(initial.body).embeds) } : local,
    );
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

  // Other tabs on this device announce their saves, so a conflict between two tabs can be compared at once.
  const elsewhere = useRef<{ head: string; body: string } | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const tabs = new BroadcastChannel(TAB_CHANNEL);
    channel.current = tabs;
    tabs.onmessage = (event: MessageEvent<TabSave>) => {
      const save = event.data;
      if (
        save?.channel &&
        save.channel === store.channel() &&
        save.head !== autosave.snapshot.head
      ) {
        elsewhere.current = { head: save.head, body: save.body };
      }
    };
    return () => {
      tabs.close();
      channel.current = null;
    };
  }, [store, autosave]);
  useEffect(() => {
    const id = store.channel();
    if (!id || !snapshot.head || snapshot.state !== 'saved') return;
    channel.current?.postMessage({
      channel: id,
      head: snapshot.head,
      body: snapshot.saved,
    } satisfies TabSave);
  }, [store, snapshot.head, snapshot.saved, snapshot.state]);

  // A conflict found while saving: the version that won, as Main named it, from another tab, or Main's latest.
  useEffect(() => {
    if (snapshot.state !== 'conflict' || conflictHead !== null) return;
    const announced = elsewhere.current;
    if (announced && (!snapshot.theirs || announced.head === snapshot.theirs)) {
      setTheirs(announced.body);
      setConflictHead(announced.head);
      return;
    }
    let active = true;
    setTheirs(undefined);
    void store
      .theirs(snapshot.theirs)
      .catch(() => null)
      .then((latest) => {
        if (!active) return;
        setTheirs(latest?.body ?? null);
        setConflictHead(latest?.head ?? null);
      });
    return () => {
      active = false;
    };
  }, [snapshot.state, snapshot.theirs, conflictHead, store]);

  // Keep the address on the exact revision Studio last saved, so a reload or a shared link opens it.
  useEffect(() => {
    const target = snapshot.head ? store.href(snapshot.head) : null;
    if (!target) return;
    const href = localizedPath(target, locale);
    if (`${location.pathname}${location.search}` !== href)
      history.replaceState(history.state, '', href);
  }, [snapshot.head, store, locale]);

  // Save when the network returns, when the tab hides and before it closes.
  useEffect(() => {
    const flush = () => {
      void autosave.flush();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
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
    setNotice(null);
    autosave.edit(next);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void autosave.flush();
    }
  };
  const resolveMine = () => {
    elsewhere.current = null;
    autosave.keepMine(conflictHead);
    setConflictHead(null);
    setTheirs(undefined);
  };
  const resolveTheirs = () => {
    if (typeof theirs !== 'string') return;
    elsewhere.current = null;
    autosave.takeTheirs(conflictHead, theirs);
    setValue(theirs);
    setConflictHead(null);
    setTheirs(undefined);
  };
  const prepare = async () => {
    await autosave.flush();
    const saved = (autosave.snapshot.state === 'saved' || autosave.snapshot.state === 'idle')
      && autosave.snapshot.saved === autosave.text && autosave.snapshot.head;
    if (!saved) setNotice(t.publishUnsaved);
    return saved ? { head: saved, body: autosave.snapshot.saved } : null;
  };

  const conflict = snapshot.state === 'conflict';
  const state = snapshot.denied ? 'error' : snapshot.state;
  const draft = authorNotes ? chapterDraft(value) : { body: value, notes: {} };
  const ready = Boolean(snapshot.head && !conflict && !snapshot.denied && hasBodyContent(draft.body));
  const noteEditor = (side: 'before' | 'after') => authorNotes ? (
    <section className="grid gap-3 rounded-xl border border-border/60 bg-muted/30 p-4" data-author-note-editor={side}>
      <h2 className="font-medium text-sm">{side === 'before' ? t.authorNoteBefore : t.authorNoteAfter}</h2>
      {side === 'before' ? <p className="text-muted-foreground text-sm">{t.authorNotesHelp}</p> : null}
      <BodyEditor
        actingSubject={actingSubject}
        mediaTarget={mediaTarget}
        label={side === 'before' ? t.authorNoteBefore : t.authorNoteAfter}
        locale={locale}
        lang={language}
        dir={direction}
        value={draft.notes[side] ?? ''}
        placeholder={t.authorNotePlaceholder}
        placeholderDirection={placeholderDirection}
        maxLength={8192}
        compact
        readOnly={conflict || snapshot.denied}
        onChange={next => {
          const current = chapterDraft(autosave.text);
          change(chapterDraftValue(current.body, { ...current.notes, [side]: next }, current.embeds));
        }}
        onKeyDown={keyDown}
        onBlur={() => void autosave.flush()}
      />
    </section>
  ) : null;
  return (
    <div className="min-h-dvh bg-background [text-autospace:normal]">
      <div className="sticky top-0 z-10 border-border/60 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-2 sm:px-6">
          <Link
            href={back.href}
            className="inline-flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-accent/60"
            aria-label={back.label}
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4 shrink-0" />
            <span lang={back.title.language} className="min-w-0 truncate">
              {back.title.value}
            </span>
          </Link>
          <AutosaveStatus
            className="ms-auto"
            state={state}
            savedAt={snapshot.savedAt}
            locale={locale}
            onRetry={() => void autosave.flush()}
            labels={{
              idle: t.autosaveIdle,
              unsaved: t.autosaveUnsaved,
              saving: t.autosaveSaving,
              saved: t.autosaveSaved,
              offline: t.autosaveOffline,
              conflict: t.autosaveConflict,
              error: snapshot.denied ? t.autosaveDenied : t.autosaveError,
              retry: t.retry,
            }}
          />
          {publish({ prepare, head: snapshot.head, body: value, ready, say: setNotice })}
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-[44rem] gap-5 px-4 pt-8 pb-24 sm:px-6 sm:pt-12">
        <header className="grid gap-2">
          <p className="text-muted-foreground text-sm">{context}</p>
          <h1
            lang={title.language}
            className="text-balance break-words font-semibold font-work-title text-3xl/tight
          sm:text-4xl/tight"
          >
            {title.value}
          </h1>
        </header>
        {notice ? (
          <Alert variant="info">
            <InfoIcon aria-hidden="true" />
            <AlertDescription role="status" className="text-foreground">
              {notice}
            </AlertDescription>
          </Alert>
        ) : null}
        {conflict ? (
          <ConflictView
            mine={value}
            theirs={theirs}
            lang={language}
            dir={direction}
            onKeepMine={resolveMine}
            onTakeTheirs={resolveTheirs}
            labels={t}
            locale={locale}
            authorNotes={authorNotes}
          />
        ) : null}
        {noteEditor('before')}
        <BodyEditor
          actingSubject={actingSubject}
          mediaTarget={mediaTarget}
          label={label}
          locale={locale}
          lang={language}
          dir={direction}
          allowAdvanced
          value={draft.body}
          placeholder={t.placeholder}
          placeholderDirection={placeholderDirection}
          maxLength={65536}
          readOnly={conflict || snapshot.denied}
          onChange={next => {
            const current = chapterDraft(autosave.text);
            change(authorNotes ? chapterDraftValue(next, current.notes, current.embeds) : next);
          }}
          onKeyDown={keyDown}
          onBlur={() => void autosave.flush()}
          autoFocus={!hasBodyContent(authorNotes ? chapterDraft(initial.body).body : initial.body)}
        />
        {noteEditor('after')}
      </div>
      {/* On phones the shell's bottom navigation covers the last 4rem; the counts sit above it. */}
      <div
        className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] border-border/60 border-t bg-background/90
      backdrop-blur md:bottom-0"
      >
        <EditorFooter className="mx-auto w-full max-w-[44rem] px-4 py-2 sm:px-6">
          <span>{lengthLabel(manuscriptLength(bodyText(draft.body), language), t)}</span>
        </EditorFooter>
      </div>
    </div>
  );
}
