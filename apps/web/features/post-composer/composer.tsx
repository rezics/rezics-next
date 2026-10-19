'use client';

import { type AddressTarget } from '../address/path.ts';
import { communityHref, threadPath } from '../feed/discussion.ts';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Input } from '@rezics/ui/input';
import { CircleAlertIcon, SearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { readPublicRealmChoices } from '../discover/browser.ts';
import { readBrowserTypeahead } from '../search/browser.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import { BodyEditor } from '../document-editor/body-editor.tsx';
import { bodyText, restoreCachedBody } from '../document-editor/body.ts';
import { parseStoredDocument } from '@rezics/document';
import type { RealmHeader } from '../realm/types.ts';
import Link from '../shell/localized-link.tsx';
import { useOperationGate } from '../shell/shell-provider.tsx';
import { newPostProgress, postWriteState, submitPost, type PostIntent, type PostProgress } from './api.ts';
import { preparePostImageDraft, sameImageDraftContext, type PostImageDraft } from './image-draft.ts';
import type { ImageUseTarget, ReplyImageDraft } from '../document-editor/image-target.ts';
import type { DocumentSaveState } from '../document-editor/publication.ts';
import { postText as words } from './messages.ts';
import { persistDraftBody } from './draft-body.ts';

export interface CommunityChoice {
  id: string;
  address?: AddressTarget;
  name: string;
}
/** What a post is about: a Work found by search (with its Main Version), or a target a page named (with its revision). */
export interface WorkChoice {
  id: string;
  mainVersion: string | null;
  revision?: string;
  title: string;
}
interface Draft {
  community: CommunityChoice | null;
  work: WorkChoice | null;
  title: string;
  body: string;
  recoveryBody?: string;
  bodyFormat?: 'document';
  spoiler: boolean;
  progress: PostProgress | null;
  imageDraft?: PostImageDraft;
  /** The language the writer chose for the post; null until they do, then the first reading language. */
  language: string | null;
}
const blank = (community: CommunityChoice | null, work: WorkChoice | null = null): Draft => ({
  community,
  work,
  title: '',
  body: '',
  spoiler: false,
  progress: null,
  language: null,
});
const draftKey = (actor: string) => `rezics:post-draft:${actor}`;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const storedDraft = (draft: Draft) => JSON.stringify({
  ...draft, bodyFormat: parseStoredDocument(draft.body) ? 'document' : undefined,
});

/** The post draft survives navigation and reload; a started publication retains its operation keys. */
export function PostComposer({
  locale,
  actingSubject,
  initial = null,
  target = null,
}: {
  locale: UiLocale;
  actingSubject: string;
  initial?: CommunityChoice | null;
  /** The resource a page asked to discuss; it replaces any stored choice and cannot be searched away. */
  target?: WorkChoice | null;
}) {
  const operationOpen = useOperationGate();
  const operationGate = useRef(operationOpen);
  operationGate.current = operationOpen;
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => blank(initial, target));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const titleInput = useRef<HTMLInputElement>(null);
  const [hydrated, setHydrated] = useState(false);
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [bodyState, setBodyState] = useState<DocumentSaveState>('ready');
  const bodySaveState = useRef<DocumentSaveState>('ready');
  const [communityQuery, setCommunityQuery] = useState('');
  const [communities, setCommunities] = useState<CommunityChoice[]>([]);
  const [communityState, setCommunityState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [workQuery, setWorkQuery] = useState('');
  const [works, setWorks] = useState<WorkChoice[]>([]);
  const [workState, setWorkState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [header, setHeader] = useState<RealmHeader | null>(null);
  const [headerState, setHeaderState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'failed' | 'refused' | 'banned' | null>(null);
  const [postedHref, setPostedHref] = useState<string | null>(null);
  const [checkingProjection, setCheckingProjection] = useState(false);
  const writeState = postWriteState(draft.progress);
  const locked = busy || checkingProjection || writeState !== 'none';
  const reading = useReadingLanguages(actingSubject);
  const language = writingLanguage({ chosen: draft.language, reading });
  const currentLanguage = useRef(language);
  currentLanguage.current = language;
  const imageIntent = useRef(currentIntent);
  imageIntent.current = currentIntent;
  const written = textAttributes(language, bodyText(draft.body));
  const preparingImage = useRef<Promise<ReplyImageDraft> | null>(null);
  const prepareImage = useRef<() => Promise<ReplyImageDraft>>(async () => { throw new Error('image-draft-unavailable'); });
  prepareImage.current = async () => {
    if (preparingImage.current) return preparingImage.current;
    const intent = currentIntent();
    if (!operationGate.current('postV1Member-reply-drafts')) throw new Error('image-draft-unavailable');
    const pending = preparePostImageDraft(intent, draftRef.current.imageDraft ?? null, (imageDraft) => {
      if (!sameImageDraftContext(imageIntent.current(), imageDraft)) throw new Error('image-draft-context-changed');
      const next = { ...draftRef.current, imageDraft, language: imageDraft.intent.language };
      try { persist(next); } catch (cause) { setStorageError(true); throw cause; }
      draftRef.current = next; setDraft(next);
    });
    preparingImage.current = pending;
    try { return await pending; } finally { preparingImage.current = null; }
  };
  const mediaTarget = useMemo<ImageUseTarget | undefined>(() => {
    if (!hydrated || !draftRef.current.community || !draftRef.current.work) return undefined;
    const intent = imageIntent.current();
    const record = draftRef.current.imageDraft;
    return {
      retained: sameImageDraftContext(intent, record) && postWriteState(record?.progress ?? null) === 'acknowledged',
      prepare: async () => {
        if (!sameImageDraftContext(imageIntent.current(), { intent })) throw new Error('image-draft-context-changed');
        const basis = await prepareImage.current();
        if (!sameImageDraftContext(imageIntent.current(), { intent })) throw new Error('image-draft-context-changed');
        return basis;
      },
    };
    // Receipt and text edits keep the reconciler and its immutable occurrence receipts alive.
  }, [hydrated, actingSubject, draft.community?.id, draft.work?.id, draft.work?.mainVersion, draft.work?.revision, language]);

  function currentIntent(): PostIntent {
    const current = draftRef.current;
    if (!current.community || !current.work) throw new Error('image-draft-unavailable');
    return { realm: current.community.id, work: current.work.id, mainVersion: current.work.mainVersion,
      revision: current.work.revision, title: current.title, body: current.body, spoiler: current.spoiler,
      language: currentLanguage.current, actingSubject };
  }

  useEffect(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(draftKey(actingSubject)) ?? 'null',
      ) as Draft | null;
      if (
        stored &&
        typeof stored.title === 'string' &&
        typeof stored.body === 'string' &&
        (!stored.community || native.test(stored.community.id)) &&
        (!stored.work || native.test(stored.work.id))
      ) {
        const editable = postWriteState(stored.progress ?? null) === 'none';
        const asked = target && editable ? target : null;
        if (typeof stored.recoveryBody === 'string') {
          bodySaveState.current = 'pending'; setBodyState('pending');
        }
        setDraft({
          ...stored,
          body: restoreCachedBody(stored.body, stored.bodyFormat, true),
          language: typeof stored.language === 'string' ? stored.language : null,
          work: asked ?? stored.work,
          community: editable ? (initial ?? stored.community) : stored.community,
        });
      }
    } catch {
      /* An invalid local draft is ignored. */
    }
    setHydrated(true);
  }, [actingSubject, initial, target]);
  function persist(next: Draft) {
    const value = storedDraft(next);
    localStorage.setItem(draftKey(actingSubject), value);
    setSavedValue(value);
    setStorageError(false);
  }
  useEffect(() => {
    if (!hydrated) return;
    try {
      persist(draft);
    } catch {
      setStorageError(true);
    }
  }, [draft, actingSubject, hydrated]);

  useEffect(() => {
    if (draft.community || !hydrated) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        setCommunityState('loading');
        try {
          const { data } = await readPublicRealmChoices(communityQuery.trim());
          if (!current) return;
          if (!data) {
            setCommunityState('failed');
            return;
          }
          setCommunities(
            data.items.map((item) => ({
              id: item.id,
              name: item.name.value,
              address: 'address' in item ? (item.address as AddressTarget) : undefined,
            })),
          );
          setCommunityState('idle');
        } catch {
          if (current) setCommunityState('failed');
        }
      })();
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [communityQuery, draft.community, hydrated, locale]);

  useEffect(() => {
    if (draft.work || !workQuery.trim() || !draft.community) {
      setWorks([]);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        setWorkState('loading');
        try {
          // The server personalises this read from the credential.
          const { data } = await readBrowserTypeahead(workQuery.trim());
          if (!current) return;
          if (!data) {
            setWorkState('failed');
            return;
          }
          setWorks(
            data.items.map((item) => ({
              id: item.work,
              mainVersion: item.mainVersion,
              title: item.title.value,
            })),
          );
          setWorkState('idle');
        } catch {
          if (current) setWorkState('failed');
        }
      })();
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [workQuery, draft.work, draft.community, locale]);

  useEffect(() => {
    if (!draft.community) {
      setHeader(null);
      return;
    }
    let current = true;
    setHeaderState('loading');
    setHeader(null);
    const id = draft.community.id.slice(-36);
    void (async () => {
      try {
        const main = browserMainApi();
        const { data } = await main.v1.realms({ realm: id }).get({ query: { actingSubject } });
        if (!current) return;
        if (!data) {
          setHeaderState('failed');
          return;
        }
        setHeader(data);
        if (data.reviewMode === 'trusted-members') {
          const member = await main.v1
            .realms({ realm: id })
            .joining.get({ query: { actingSubject } });
          if (!current) return;
          setJoined(member.data?.state === 'joined');
        } else setJoined(false);
        setHeaderState('idle');
      } catch {
        if (current) setHeaderState('failed');
      }
    })();
    return () => {
      current = false;
    };
  }, [draft.community, actingSubject, locale]);

  function change(patch: Partial<Draft>) {
    if (locked) return;
    setPostedHref(null);
    const before = draftRef.current;
    const next = {
      ...before,
      ...patch,
      // Editing an unwritten attempt discards its cached root and operation keys together.
      progress: postWriteState(before.progress) === 'none' ? null : before.progress,
    };
    draftRef.current = next;
    setDraft(next);
  }
  function saveBody(body: string) {
    if (locked) throw new Error('draft-not-editable');
    // Clearing raw recovery acknowledges a complete device write, just as publication progress does.
    let next: Draft;
    try { next = persistDraftBody(draftRef.current, body, persist); } catch (cause) { setStorageError(true); throw cause; }
    draftRef.current = next;
    setDraft(next);
  }
  function saveProgress(progress: PostProgress) {
    const before = draftRef.current;
    const next = { ...before, progress, language: before.progress ? before.language : language };
    // React may defer state updaters. The operation record must be durable before dispatch.
    try { persist(next); } catch (cause) { setStorageError(true); throw cause; }
    draftRef.current = next;
    setDraft(next);
  }
  async function post(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy ||
      !hydrated ||
      bodySaveState.current !== 'ready' ||
      draft.recoveryBody ||
      !draft.community ||
      !draft.work ||
      !header ||
      !draft.title.trim() ||
      header.reviewMode === 'mandatory' ||
      (header.reviewMode === 'trusted-members' && !joined)
    )
      return;
    const community = draft.community;
    const discussionHref = (reply: string) =>
      localizedPath(
        threadPath(communityHref(community.address ?? community.id), reply),
        locale,
      );
    setBusy(true);
    setError(null);
    let projectionVisible = false;
    try {
      const intent = currentIntent();
      const image = sameImageDraftContext(intent, draft.imageDraft) ? await prepareImage.current() : null;
      const progress = draft.progress ?? { ...newPostProgress(), ...(image ? {
        reply: image.reply, variantId: image.variantId, rootRevision: image.rootRevision,
      } : {}) };
      saveProgress(progress);
      const result = await submitPost(
        intent,
        progress,
        saveProgress,
        undefined,
        (reply) => {
          try {
            localStorage.removeItem(draftKey(actingSubject));
          } catch {
            /* optional */
          }
          setDraft(blank(community, draft.work));
          setPostedHref(discussionHref(reply));
          setCheckingProjection(true);
          setBusy(false);
        },
        (visible) => {
          projectionVisible = visible;
          setCheckingProjection(false);
        },
        operation => operationGate.current(operation),
        image?.revisionId,
      );
      if (result.kind === 'posted') {
        if (projectionVisible) router.push(discussionHref(result.reply));
      } else if (result.kind === 'refused') {
        setDraft((before) => ({ ...before, progress: null }));
        setError('refused');
      } else {
        saveProgress(result.progress);
        setError(result.kind);
      }
    } catch {
      setError('failed');
    } finally {
      setBusy(false);
    }
  }

  const notice =
    headerState === 'failed'
      ? words.unavailable[locale]
      : header?.reviewMode === 'mandatory'
        ? words.reviewRequired[locale]
        : header?.reviewMode === 'trusted-members' && !joined
          ? words.joinRequired[locale]
          : null;
  const canPost = Boolean(hydrated && bodyState === 'ready' && !draft.recoveryBody && header && draft.community && draft.work && draft.title.trim() && !notice);
  return (
    <form onSubmit={(event) => void post(event)} className="grid max-w-3xl gap-7">
      <section className="grid gap-2" aria-label={words.community[locale]}>
        <h2 className="font-semibold text-sm">{words.community[locale]}</h2>
        {draft.community ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
            <span className="font-semibold">{draft.community.name}</span>
            {!locked ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => change({ community: null, work: target })}
              >
                {words.communityChange[locale]}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="relative">
              <SearchIcon
                aria-hidden="true"
                className="absolute start-3 top-3 size-4
          text-muted-foreground"
              />
              <Input
                type="search"
                value={communityQuery}
                onChange={(event) => setCommunityQuery(event.currentTarget.value)}
                aria-label={words.communitySearch[locale]}
                placeholder={words.communitySearch[locale]}
                className="ps-9"
                maxLength={80}
              />
            </div>
            {communityState === 'failed' ? (
              <p role="status" className="text-destructive-foreground text-sm">
                {words.unavailable[locale]}
              </p>
            ) : null}
            {communities.length ? (
              <ul
                className="grid max-h-64 gap-1 overflow-auto rounded-xl border border-border
          bg-card p-1"
              >
                {communities.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-start outline-none hover:bg-accent
            focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => change({ community: item })}
                    >
                      {item.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : communityQuery && communityState === 'idle' ? (
              <p className="text-muted-foreground text-sm">{words.noCommunity[locale]}</p>
            ) : null}
          </>
        )}
      </section>
      {draft.community ? (
        <>
          {header?.rules?.length ? (
            <section
              aria-label={words.rules[locale]}
              className="grid gap-2 rounded-xl border border-border bg-card p-4"
            >
              <h2 className="font-semibold text-sm">{words.rules[locale]}</h2>
              <ol className="list-inside list-decimal space-y-2 text-sm">
                {header.rules.map((rule) => (
                  <li key={rule.id}>
                    <span className="font-medium">{rule.title.value}</span>
                    <span className="ms-2 text-muted-foreground">{rule.body.value}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : header ? (
            <p className="text-muted-foreground text-sm">{words.noRules[locale]}</p>
          ) : null}
          {notice ? (
            <Alert role="status">
              <CircleAlertIcon aria-hidden="true" />
              <AlertDescription>
                {notice}{' '}
                <Link
                  href={communityHref(draft.community.address ?? draft.community.id)}
                  className="font-medium underline"
                >
                  {words.viewCommunity[locale]}
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
          <section className="grid gap-2" aria-label={words.work[locale]}>
            <h2 className="font-semibold text-sm">{words.work[locale]}</h2>
            {draft.work ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
                <span className="font-medium">{draft.work.title}</span>
                {!locked && !target ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => change({ work: null })}
                  >
                    {words.workChange[locale]}
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                <Input
                  type="search"
                  value={workQuery}
                  onChange={(event) => setWorkQuery(event.currentTarget.value)}
                  aria-label={words.workSearch[locale]}
                  placeholder={words.workSearch[locale]}
                  maxLength={80}
                />
                {workState === 'failed' ? (
                  <p role="status" className="text-destructive-foreground text-sm">
                    {words.unavailable[locale]}
                  </p>
                ) : null}
                {works.length ? (
                  <ul
                    className="grid max-h-64 gap-1 overflow-auto rounded-xl border border-border
            bg-card p-1"
                  >
                    {works.map((work) => (
                      <li key={work.id}>
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-start outline-none hover:bg-accent
              focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => change({ work })}
                        >
                          {work.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : workQuery && workState === 'idle' ? (
                  <p className="text-muted-foreground text-sm">{words.noWork[locale]}</p>
                ) : null}
              </>
            )}
          </section>
          <div className="grid gap-1.5 text-sm font-semibold">
            <label htmlFor="post-title">{words.titleLabel[locale]}</label>
            <Input
              id="post-title"
              ref={titleInput}
              required
              maxLength={280}
              value={draft.title}
              readOnly={locked}
              onChange={(event) => change({ title: event.currentTarget.value })}
            />
          </div>
          <section className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{words.body[locale]}</h2>
              <LanguageSelect
                value={language}
                onChange={(chosen) => change({ language: chosen })}
                locale={locale}
                reading={reading}
                disabled={locked}
                label={words.postLanguage[locale]}
              />
            </div>
            <BodyEditor
              actingSubject={actingSubject}
              mediaTarget={mediaTarget}
              compact
              className="min-h-40"
              label={words.body[locale]}
              maxLength={7800}
              value={draft.body}
              locale={locale}
              readOnly={locked}
              disabled={busy}
              recoveryValue={draft.recoveryBody}
              onRecoveryChange={(recoveryBody) => change({ recoveryBody })}
              onChange={saveBody}
              onSaveStateChange={(state) => {
                bodySaveState.current = state;
                setBodyState(state);
              }}
              legacyMarkdown
              lang={written.lang}
              dir={written.dir}
            />
            <span className="text-muted-foreground text-xs">{words.bodyHelp[locale]}</span>
          </section>
          <div className="flex items-start gap-3 text-sm">
            <Checkbox
              id="post-spoiler"
              checked={draft.spoiler}
              disabled={locked}
              onCheckedChange={(details) => change({ spoiler: details.checked === true })}
              aria-label={words.spoiler[locale]}
            />
            <label htmlFor="post-spoiler" className="grid gap-0.5">
              <span className="font-medium">{words.spoiler[locale]}</span>
              <span className="text-muted-foreground">{words.spoilerHelp[locale]}</span>
            </label>
          </div>
          {error ? (
            <Alert variant="destructive" role="alert">
              <CircleAlertIcon aria-hidden="true" />
              <AlertDescription>{words[error][locale]}</AlertDescription>
            </Alert>
          ) : null}
          {!busy && draft.progress ? (
            <div className="grid gap-2 text-sm">
              <p role="status">{words[writeState === 'none' ? 'unwritten' : writeState === 'unknown' ? 'writeUnknown' : 'writeAcknowledged'][locale]}</p>
              {writeState === 'none' ? (
                <Button type="button" variant="outline" className="justify-self-start" onClick={() => {
                  titleInput.current?.focus();
                  change({ progress: null }); setError(null);
                }}>{words.cancelAttempt[locale]}</Button>
              ) : null}
            </div>
          ) : null}
          {postedHref ? (
            <Alert role="status">
              <AlertDescription>
                {words.postedAppearing[locale]}{' '}
                <Link href={postedHref} className="font-medium underline">
                  {words.openDiscussion[locale]}
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canPost || busy || checkingProjection} isLoading={busy}>
              {busy ? words.posting[locale] : draft.progress ? words.retryPost[locale] : words.post[locale]}
            </Button>
            {bodyState === 'ready' ? <Button type="button" variant="ghost" onClick={() => {
              const url = URL.createObjectURL(new Blob([storedDraft(draft)], { type: 'application/json' }));
              const link = document.createElement('a'); link.href = url; link.download = 'post-draft.json';
              link.click(); URL.revokeObjectURL(url);
            }}>{words.exportDraft[locale]}</Button> : null}
            {storageError ? <Button type="button" variant="outline" onClick={() => {
              try { persist(draft); titleInput.current?.focus(); } catch { setStorageError(true); }
            }}>{words.retrySave[locale]}</Button> : null}
            {hydrated && !postedHref ? (
              <span role="status" className="text-muted-foreground text-xs">
                {bodyState !== 'ready' || draft.recoveryBody ? words.draftIncomplete[locale]
                  : storageError ? words.draftSaveFailed[locale]
                    : savedValue === storedDraft(draft) ? words.draftSaved[locale] : words.draftSaving[locale]}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </form>
  );
}
