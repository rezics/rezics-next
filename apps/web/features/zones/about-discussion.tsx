'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { DocumentBody } from '@rezics/ui/document-body';
import { checkDocument, parseStoredDocument } from '@rezics/document';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { textAttributes } from '../content-language/writing-language.ts';
import { spaceHref, threadHref } from '../address/path.ts';
import { MarkdownBody } from '../post-composer/markdown.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { useOperationGate } from '../shell/shell-provider.tsx';
import { mainAboutDiscussionApi, type AboutDiscussionApi, type AboutDiscussionRead,
  type AboutPostIntent, type AboutPostOutcome } from './about-discussion-api.ts';
import { aboutDiscussionMessages } from './about-discussion-messages.ts';
import { retainedAboutPost } from './about-discussion-intent.ts';

export interface AboutDiscussionProps {
  read: AboutDiscussionRead;
  locale: UiLocale;
  href: string;
  api?: AboutDiscussionApi;
  /** Disable device retention for an embedded preview. Real pages retain unresolved intents. */
  retain?: boolean;
  /** Recovery survives attachment withdrawal while the posting grant is open. */
  recoveryScope?: { zone: string; path: string; actingSubject: string | null; signedIn: boolean; personal: boolean; postingOpen: boolean };
}

export function AboutDiscussion(props: AboutDiscussionProps) {
  // A changed identity or route gets a separate device draft and in-flight lock.
  const scope = props.recoveryScope;
  const identity = scope ? `${scope.actingSubject}:${scope.zone}:${scope.path}` : props.read.kind === 'ready'
    ? `${props.read.actingSubject}:${props.read.basis.zone}:${props.read.basis.path}` : props.read.kind;
  return <AboutDiscussionEntry key={identity} {...props} />;
}

function AboutDiscussionEntry({ read: initialRead, locale, href, api, retain = true, recoveryScope }: AboutDiscussionProps) {
  const operationOpen = useOperationGate();
  const operationGate = useRef(operationOpen);
  operationGate.current = operationOpen;
  const t = aboutDiscussionMessages[locale];
  const router = useRouter();
  const id = useId();
  const [body, setBody] = useState('');
  const [language, setLanguage] = useState('und');
  const [spoiler, setSpoiler] = useState(false);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState(initialRead);
  const [reading, setReading] = useState(false);
  useEffect(() => setRead(initialRead), [initialRead]);
  const [hydrated, setHydrated] = useState(!retain);
  const [outcome, setOutcome] = useState<AboutPostOutcome | null>(null);
  const intent = useRef<AboutPostIntent | null>(null);
  const dispatching = useRef(false);
  const actor = recoveryScope?.actingSubject ?? (read.kind === 'ready' ? read.actingSubject : null);
  const zone = recoveryScope?.zone ?? (read.kind === 'ready' ? read.basis.zone : null);
  const path = recoveryScope?.path ?? (read.kind === 'ready' ? read.basis.path : null);
  const storageKey = actor && zone && path && retain ? `rezics:about-post:${actor}:${zone}:${path}` : null;
  const retryRead = async () => {
    const readAgain = (api ?? mainAboutDiscussionApi()).read;
    if (!recoveryScope || !readAgain) { router.refresh(); return; }
    setReading(true);
    try {
      // Retry this region through its existing API reader. A full Work refresh
      // spends the same page deadline on unrelated regions before returning here.
      setRead(await readAgain({ zone: recoveryScope.zone, path: recoveryScope.path,
        signedIn: recoveryScope.signedIn, actingSubject: recoveryScope.actingSubject ?? undefined,
        personal: recoveryScope.personal, postingOpen: operationGate.current('postV1RealmsByRealmAbout-posts') }));
    } catch { setRead({ kind: 'unavailable' }); }
    finally { setReading(false); }
  };

  useEffect(() => {
    if (storageKey && actor && zone && path) {
      try {
        const raw = localStorage.getItem(storageKey);
        const saved = raw && retainedAboutPost(raw, actor, zone, path);
        if (saved) {
          intent.current = saved;
          setBody(saved.body); setLanguage(saved.language); setSpoiler(saved.spoiler);
          setOpened(true); setOutcome({ kind: 'recovery' });
        }
      } catch { /* Unavailable device storage does not prevent in-page recovery. */ }
    }
    setHydrated(true);
  }, [storageKey, actor, zone, path]);

  useEffect(() => {
    // A fresh server read can reopen access without remounting this route.
    // Keep the original intent and key when replacing its gate refusal.
    if (recoveryScope?.postingOpen !== false
      && (read.kind === 'ready' ? read.mode !== 'closed' : recoveryScope?.postingOpen === true)) {
      setOutcome(previous => previous?.kind === 'closed' ? { kind: 'recovery' } : previous);
    }
  }, [read, recoveryScope?.postingOpen]);

  if (read.kind === 'none' && !intent.current) return outcome?.kind === 'posted' ? <p role="status">{t.posted}</p> : null;
  if (read.kind === 'unavailable' && !intent.current) return <section aria-label={t.title} className="grid gap-3 border-t border-border py-6">
    <h2 className="font-semibold text-lg">{t.title}</h2><p role="status">{t.unavailable}</p>
    <Button variant="outline" disabled={reading} aria-busy={reading} onClick={() => void retryRead()}>{t.retry}</Button>
  </section>;
  const ready = read.kind === 'ready' ? read : {
    basis: intent.current!.basis, actingSubject: actor, thread: null,
    mode: !recoveryScope?.signedIn ? 'sign-in' as const
      : !recoveryScope.postingOpen ? 'closed' as const
      : !recoveryScope.personal ? 'identity' as const : 'unavailable' as const,
  };
  const { basis, actingSubject, mode, thread } = ready;
  const retained = intent.current !== null;
  const locked = busy || retained;
  const tooLong = new TextEncoder().encode(body).length > 8192;
  const postingOpen = operationOpen('postV1RealmsByRealmAbout-posts') && mode !== 'closed'
    && recoveryScope?.postingOpen !== false && outcome?.kind !== 'closed';
  const canRecover = postingOpen && retained && Boolean(actingSubject) && mode !== 'sign-in' && mode !== 'identity';
  const canWrite = postingOpen && read.kind === 'ready' && mode === 'open' && Boolean(actingSubject);
  const post = async () => {
    if (dispatching.current || !hydrated || (!canWrite && !canRecover) || !actingSubject) return;
    if (!intent.current) {
      if (!body.trim() || tooLong) return;
      intent.current = { key: crypto.randomUUID(), basis: { ...basis }, actingSubject, body, language, spoiler };
      // Persist before dispatch: a browser close can lose any response, including a receipt.
      try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(intent.current)); } catch { /* Keep the in-page intent. */ }
    }
    dispatching.current = true; setBusy(true);
    let result: AboutPostOutcome;
    try { result = await (api ?? mainAboutDiscussionApi(undefined,
      operation => operationGate.current(operation))).post(intent.current); }
    catch { result = { kind: 'recovery' }; }
    setOutcome(result); setBusy(false); dispatching.current = false;
    if (result.kind === 'posted') {
      intent.current = null;
      try { if (storageKey) localStorage.removeItem(storageKey); } catch { /* The receipt remains replayable. */ }
      setBody(''); setSpoiler(false); setOpened(false); router.refresh();
    } else if (result.kind === 'refused' || result.kind === 'stale') {
      // A confirmed refusal ends this attempt. Preserve the editable words;
      // the next Post takes the current read's basis and a fresh operation key.
      intent.current = null;
      try { if (storageKey) localStorage.removeItem(storageKey); } catch { /* Keep the editable words in this page. */ }
    }
    // Lost or pending responses retain their exact intent until a known outcome.
  };
  const realmPath = spaceHref(basis.realm.slice(-36), 'community');
  const threadPath = threadHref(realmPath, thread?.thread ?? '');
  const depths = new Map<string, number>();
  return <section aria-labelledby={`${id}-heading`} className="grid min-w-0 gap-4 border-t border-border py-6">
    <div className="grid gap-1">
      <h2 id={`${id}-heading`} className="font-semibold text-lg">{t.title}</h2>
      {read.kind === 'ready' && read.realmName ? <LocalizedLink href={realmPath} className="text-muted-foreground text-sm underline underline-offset-4">
        <span lang={read.realmName.language} dir={read.realmName.direction}>{read.realmName.value}</span>
      </LocalizedLink> : null}
    </div>
    {thread ? <>
      <div className="grid gap-4">
        {thread.items.map(item => {
          const depth = item.parent && depths.has(item.parent) ? depths.get(item.parent)! + 1 : 0;
          depths.set(item.reply, depth);
          const document = checkDocument(item.document) ? item.document : parseStoredDocument(item.body);
          const words = <div {...textAttributes(item.language ?? 'und', item.body)} className="min-w-0 [overflow-wrap:anywhere]">
            {item.title ? <h3 className="font-semibold">{item.title}</h3> : null}
            {document ? <DocumentBody document={document} spoilerLabel={t.spoiler} />
              : <MarkdownBody text={item.body} showSpoiler={t.spoiler} />}
          </div>;
          return <article key={item.reply} data-depth={depth} style={{ marginInlineStart: `${Math.min(depth, 3) * 0.75}rem` }}
            className="grid gap-2 border-l border-border pl-3">
            {item.author ? <p className="text-muted-foreground text-sm" dir="auto">{item.author.name}</p> : null}
            {item.spoiler ? <details><summary>{t.spoiler}</summary>{words}</details> : words}
          </article>;
        })}
      </div>
      <LocalizedLink href={threadPath} documentNavigation className="text-primary underline underline-offset-4">{t.continueThread}</LocalizedLink>
    </> : read.kind === 'ready' ? <p className="text-muted-foreground text-sm">{t.empty}</p> : null}
    {mode === 'sign-in' ? <LocalizedLink href={signInPath(localizedPath(href, locale))}>{t.signIn}</LocalizedLink>
      : mode === 'identity' ? <LocalizedLink href={`/identity?next=${encodeURIComponent(localizedPath(href, locale))}`}>{t.chooseIdentity}</LocalizedLink>
      : mode === 'join' && !retained ? <LocalizedLink href={realmPath}>{t.join}</LocalizedLink>
      : mode === 'reviewed' && !retained ? <p role="status">{t.reviewed}</p>
      : !postingOpen || (mode === 'unavailable' && !retained) ? <p role="status">{t.postingUnavailable}</p> : null}
    {postingOpen && outcome ? <p role={outcome.kind === 'refused' || outcome.kind === 'stale' ? 'alert' : 'status'}>
      {outcome.kind === 'stale' ? t.reload : t[outcome.kind]}</p> : null}
    {operationOpen('postV1RealmsByRealmAbout-posts') ? canWrite || canRecover ? opened ? <form onSubmit={event => { event.preventDefault(); void post(); }} className="grid gap-3">
      <label htmlFor={`${id}-body`} className="font-medium text-sm">{t.body}</label>
      <textarea id={`${id}-body`} value={body} onChange={event => setBody(event.target.value)} disabled={locked}
        {...textAttributes(language, body)} aria-describedby={tooLong ? `${id}-limit` : undefined}
        className="min-h-28 w-full rounded-xl border border-input bg-background px-3 py-2 disabled:opacity-70" />
      {tooLong ? <p id={`${id}-limit`} role="alert">{t.tooLong}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <LanguageSelect value={language} onChange={setLanguage} locale={locale} label={t.language} disabled={locked} />
        <Checkbox checked={spoiler} onCheckedChange={details => setSpoiler(details.checked === true)} disabled={locked}>{t.spoiler}</Checkbox>
      </div>
      <Button type="submit" disabled={busy || !hydrated || !body.trim() || tooLong}>{busy ? t.sending : retained ? t.retry : t.send}</Button>
      {outcome?.kind === 'stale' ? <Button type="button" variant="outline" onClick={() => router.refresh()}>{t.refresh}</Button> : null}
    </form> : <Button variant="outline" onClick={() => setOpened(true)}>{thread ? t.reply : t.start}</Button> : null : null}
  </section>;
}
