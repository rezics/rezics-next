'use client';

import { type AddressTarget } from '../address/path.ts';
import { communityHref, threadPath } from '../feed/discussion.ts';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Input } from '@rezics/ui/input';
import { CircleAlertIcon, SearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import { BodyEditor } from '../document-editor/body-editor.tsx';
import { bodyText, restoreCachedBody } from '../document-editor/body.ts';
import { parseStoredDocument } from '@rezics/document';
import type { RealmHeader } from '../realm/types.ts';
import Link from '../shell/localized-link.tsx';
import { newPostProgress, submitPost, type PostProgress } from './api.ts';
import { postText as words } from './messages.ts';

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
  bodyFormat?: 'document';
  spoiler: boolean;
  progress: PostProgress | null;
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
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => blank(initial, target));
  const [hydrated, setHydrated] = useState(false);
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
  const [error, setError] = useState<'failed' | 'refused' | null>(null);
  const locked = Boolean(draft.progress);
  const reading = useReadingLanguages(actingSubject);
  const language = writingLanguage({ chosen: draft.language, reading });
  const written = textAttributes(language, bodyText(draft.body));

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
        const asked = target && !stored.progress ? target : null;
        setDraft({
          ...stored,
          body: restoreCachedBody(stored.body, stored.bodyFormat, true),
          language: typeof stored.language === 'string' ? stored.language : null,
          work: asked ?? stored.work,
          community: stored.progress ? stored.community : (initial ?? stored.community),
        });
      }
    } catch {
      /* An invalid local draft is ignored. */
    }
    setHydrated(true);
  }, [actingSubject, initial, target]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        draftKey(actingSubject),
        JSON.stringify({
          ...draft,
          bodyFormat: parseStoredDocument(draft.body) ? 'document' : undefined,
        }),
      );
    } catch {
      /* Private browsing may decline local storage. */
    }
  }, [draft, actingSubject, hydrated]);

  useEffect(() => {
    if (draft.community || !hydrated) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        setCommunityState('loading');
        try {
          const { data } = await browserMainApi().v1.realms.get({
            query: {
              limit: 20,
              sort: 'activity',
              ...(communityQuery.trim() ? { q: communityQuery.trim() } : {}),
            },
          });
          if (!current) return;
          if (!data) {
            setCommunityState('failed');
            return;
          }
          setCommunities(data.items.map((item) => ({ id: item.id, name: item.name.value,
            address: 'address' in item ? item.address as AddressTarget : undefined })));
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
          const { data } = await browserMainApi().v1.search.typeahead.get({
            query: { prefix: workQuery.trim() },
          });
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
    setDraft((before) => ({ ...before, ...patch }));
  }
  function saveProgress(progress: PostProgress) {
    setDraft((before) => {
      const next = { ...before, progress, language: before.progress ? before.language : language };
      try {
        localStorage.setItem(
          draftKey(actingSubject),
          JSON.stringify({
            ...next,
            bodyFormat: parseStoredDocument(next.body) ? 'document' : undefined,
          }),
        );
      } catch {
        /* optional */
      }
      return next;
    });
  }
  async function post(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy ||
      !draft.community ||
      !draft.work ||
      !header ||
      !draft.title.trim() ||
      header.reviewMode === 'mandatory' ||
      (header.reviewMode === 'trusted-members' && !joined)
    )
      return;
    setBusy(true);
    setError(null);
    const progress = draft.progress ?? newPostProgress();
    saveProgress(progress);
    const result = await submitPost(
      {
        realm: draft.community.id,
        work: draft.work.id,
        mainVersion: draft.work.mainVersion,
        revision: draft.work.revision,
        title: draft.title,
        body: draft.body,
        spoiler: draft.spoiler,
        language,
        actingSubject,
      },
      progress,
      saveProgress,
    );
    setBusy(false);
    if (result.kind === 'posted') {
      try {
        localStorage.removeItem(draftKey(actingSubject));
      } catch {
        /* optional */
      }
      router.push(
        localizedPath(
          threadPath(communityHref(draft.community.address ?? draft.community.id), result.reply),
          locale,
        ),
      );
    } else if (result.kind === 'refused') {
      setDraft((before) => ({ ...before, progress: null }));
      setError('refused');
    } else {
      saveProgress(result.progress);
      setError('failed');
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
  const canPost = Boolean(header && draft.community && draft.work && draft.title.trim() && !notice);
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
              compact
              className="min-h-40"
              label={words.body[locale]}
              maxLength={7800}
              value={draft.body}
              locale={locale}
              readOnly={locked}
              disabled={busy}
              onChange={(body) => change({ body })}
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
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!canPost} isLoading={busy}>
              {busy ? words.posting[locale] : words.post[locale]}
            </Button>
            {hydrated ? (
              <span role="status" className="text-muted-foreground text-xs">
                {words.draftSaved[locale]}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </form>
  );
}
