'use client';

import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ArrowRightIcon,
  ClockIcon,
  FlameIcon,
  MessageCircleIcon,
  TrophyIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { browserMainApi } from '../api/browser.ts';
import { CatalogueCover, CatalogueCoverCredit } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import { ShareButton, VoteControl } from '../feed/actions.tsx';
import { ReplyAuthorActions } from '../feed/author-actions.tsx';
import { LinkMenu } from '../feed/controls.tsx';
import { resourceHref } from '../address/path.ts';
import { markedSpoiler, threadPath } from '../feed/discussion.ts';
import { useFeed } from '../feed/feed-context.tsx';
import { SubjectHeader } from '../entity-page/header.tsx';
import { copyOf as detailCopy } from '../entity-page/messages.ts';
import { SubjectSources } from '../entity-page/sources.tsx';
import { ReportMenu } from '../safety/report-action.tsx';
import { ReplyComposer, type ReplyMode, type ReplyTarget } from '../feed/reply-composer.tsx';
import { ReplyBody, ReplyByline, ReplyList, type ThreadContext } from '../feed/reply-tree.tsx';
import { mainThreadApi, type ThreadApi } from '../feed/thread-api.ts';
import { replyTree, THREAD_DEPTH, type ThreadRead, type ThreadReply, type ThreadSort } from '../feed/thread.ts';
import { assertThreadPage, mergeThreadPage, threadContinuationHref } from './thread-pages.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import LocalizedLink from '../shell/localized-link.tsx';

const sortIcons: Record<ThreadSort, typeof FlameIcon> = {
  best: FlameIcon,
  top: TrophyIcon,
  new: ClockIcon,
};

export interface ThreadViewProps {
  read: ThreadRead;
  /** The Realm the thread lives in; `path` is its unlocalized `/r/{ref}`. */
  realm: { id: string; name: string; path: string };
  sort: ThreadSort;
  /** Each sort's address, which keeps the reader on this thread. */
  sortHrefs: Record<ThreadSort, string>;
  replyMode: ReplyMode;
  /** Stories: an in-memory Main. */
  threadApi?: ThreadApi;
  /** Stories can supply the same bounded continuation read from memory. */
  readPage?: (reply: string, cursor: string) => Promise<ThreadRead>;
}

type Continuation = NonNullable<ThreadRead['continuations']>[number];
const continuationKey = (value: Continuation) => `${value.kind}:${value.reply}`;

function MoreReplies({ continuation, load, href }: {
  continuation: Continuation & { kind: 'siblings' };
  load: (continuation: Continuation & { kind: 'siblings' }) => Promise<void>;
  href: string;
}) {
  const { t } = useFeed();
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  return <div className="grid justify-items-start gap-2 py-1">
    <button type="button" disabled={state === 'loading'} aria-busy={state === 'loading'}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 font-medium text-primary text-sm
        outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      onClick={() => {
        setState('loading');
        void load(continuation).then(() => setState('idle'), () => setState('failed'));
      }}>
      {state === 'loading' ? t.loadingReplies : state === 'failed' ? t.retry : t.moreReplies}
    </button>
    {state === 'loading' ? <span role="status" className="sr-only">{t.loadingReplies}</span> : null}
    {state === 'failed' ? <div className="grid gap-1 text-sm">
      <p role="alert" className="text-destructive-foreground">{t.moreRepliesFailed}</p>
      <LocalizedLink href={href} documentNavigation
        className="w-fit font-medium text-primary underline underline-offset-4">
        {t.continueThread}
      </LocalizedLink>
    </div> : null}
  </div>;
}

/** Opens the composer when the page is reached through a card's Reply (`#reply`). */
function useReplyAnchor() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || location.hash !== '#reply') return;
    done.current = true;
    document.querySelector<HTMLTextAreaElement>('#reply textarea')?.focus();
  }, []);
}

/** The Work a thread discusses, with its cover, as a link post names its source. */
function AboutWork({ work }: { work: ThreadRead['work'] }) {
  const { t, avatarQuery } = useFeed();
  return (
    <div className="grid max-w-md gap-1">
    <LocalizedLink
      href={resourceHref('/w/', work.id)}
      className="group/work flex max-w-md items-center gap-3
    rounded-xl border border-border/70 bg-background/60 p-2 pe-3 outline-none transition-colors hover:bg-accent/40
    focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CatalogueCover
        work={{
          id: work.id,
          title: work.title,
          cover: work.cover,
          kind: coverKindOf([]),
          authors: [],
        }}
        avatarQuery={avatarQuery}
        size="xs"
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-muted-foreground text-xs">{t.discussedWork}</span>
        <span
          lang={work.title.language}
          className="truncate font-medium text-sm group-hover/work:underline"
        >
          {work.title.value}
        </span>
      </span>
      <ArrowUpRightIcon
        aria-hidden="true"
        className="ms-auto size-4 shrink-0 text-muted-foreground"
      />
    </LocalizedLink>
    </div>
  );
}

/** The opening post owns its identity, reactions and exact-object menu. */
function OpeningPost({
  post,
  read,
  realm,
  count,
}: {
  post: ThreadReply;
  read: ThreadRead;
  realm: ThreadViewProps['realm'];
  count: number;
}) {
  const { t, locale } = useFeed();
  const title = post.blocked ? t.blockedUser : (post.title ?? ''),
    body = post.body;
  const href = threadPath(realm.path, post.reply);
  const detail = detailCopy(locale);
  const words = body ? (
    <ReplyBody
      reply={{ ...post, body }}
      ratingTarget={read.work.id}
      className="text-base/relaxed"
    />
  ) : null;
  return (
    <article aria-labelledby="thread-title" className="grid gap-3">
      <SubjectHeader locale={locale} resource={post.reply} contentModel="member-reply-v1" identity={<div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <CommunityIcon
          icon={null}
          name={post.author?.name ?? '·'}
          person
          className="size-8 text-xs"
        />
        <ReplyByline reply={post} opener={null} />
      </div>
      <h1
        id="thread-title"
        lang={post.language ?? undefined}
        className="text-pretty font-semibold text-xl/snug
      [overflow-wrap:anywhere] sm:text-2xl/snug"
      >
        {title || t.untitled}
      </h1>
      </div>} actions={<>
        {!post.blocked && post.author ? <ReplyAuthorActions target={{ reply: post.reply,
          realm: read.realm, author: post.author.id, revisionId: post.revisionId, placement: post.placement }} /> : null}
        {post.blocked ? null : <div role="group" aria-label={detail.reactions} className="flex items-center gap-1.5">
          <VoteControl target={{ id: post.placement, vote: post.vote.value,
            score: post.vote.score, revision: post.vote.revision, open: post.vote.open }} /></div>}
        <ReportMenu targets={[{ target: post.reply, kind: 'post', realm: read.realm,
          ...(post.revisionId ? { selection: { component: 'body' as const, revision: `urn:rezics:content:revision:${post.revisionId}`, locator: null } } : {}) }]}
          name={title || t.untitled} locale={locale} moreAccessibleLabel={detail.moreActions({ name: title || t.untitled })} />
      </>} primary={<a href="#comments"
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 font-medium text-muted-foreground text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <MessageCircleIcon aria-hidden="true" className="size-4" />{t.comments(count)}{read.complete ? '' : '+'}
      </a>} />
      <div data-primary-content className="grid min-w-0 gap-3">
      {post.blocked ? null : markedSpoiler(post.spoiler) ? (
        <>
          <span
            className="w-fit rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-[11px] text-warning-foreground
        uppercase tracking-wide"
          >
            {t.spoilerTag}
          </span>
          {words}
        </>
      ) : (
        words
      )}
      <AboutWork work={read.work} />
      </div>
      <fieldset className="-ms-1 flex flex-wrap items-center gap-1.5">
        <legend className="sr-only">{t.actions}</legend>
        <ShareButton href={href} title={title} />
      </fieldset>
    </article>
  );
}

/** A reply's own page: the discussion it belongs to and the reply it answers, then the reply and its branch. */
function ReplyContext({ read, realm }: { read: ThreadRead; realm: ThreadViewProps['realm'] }) {
  const { t } = useFeed();
  const opening = read.ancestors[0];
  const parent = read.ancestors.at(-1);
  return (
    <div className="grid gap-3">
      {opening && !opening.parent ? (
        <p className="grid gap-1">
          <span className="text-muted-foreground text-xs">{t.openingPost}</span>
          <LocalizedLink
            href={threadPath(realm.path, opening.reply)}
            lang={opening.language ?? undefined}
            className="text-pretty font-semibold text-lg/snug underline-offset-2 hover:underline"
          >
            {opening.title || t.untitled}
          </LocalizedLink>
        </p>
      ) : null}
      <p
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-info/10 px-3 py-2 text-info-foreground
      text-sm"
      >
        <span>{t.singleReply}</span>
        <LocalizedLink
          href={threadPath(realm.path, read.thread)}
          className="font-medium underline
        underline-offset-4"
        >
          {t.wholeDiscussion}
        </LocalizedLink>
      </p>
      {parent && parent.reply !== opening?.reply ? (
        <figure className="grid gap-1 border-border border-s-2 ps-3">
          <figcaption className="text-muted-foreground text-xs">{t.inReplyTo}</figcaption>
          <ReplyByline reply={parent} opener={opening?.author?.id ?? null} />
          <ReplyBody
            reply={parent}
            ratingTarget={read.work.id}
            className={
              markedSpoiler(parent.spoiler)
                ? 'text-sm'
                : 'line-clamp-4 text-muted-foreground text-sm'
            }
          />
        </figure>
      ) : null}
    </div>
  );
}

/**
 * A Reddit-quality thread: the opening post, then its comments nested with
 * fold lines, sorted by Best, Top or New, each with votes and an inline
 * reply. A reply's own page shows its place in the discussion first.
 */
export function ThreadView({
  read: initialRead,
  realm,
  sort,
  sortHrefs,
  replyMode,
  threadApi,
  readPage,
}: ThreadViewProps) {
  const { t, actingSubject, avatarQuery, locale } = useFeed();
  const [loaded, setLoaded] = useState({ source: initialRead, read: initialRead });
  if (loaded.source !== initialRead) setLoaded({ source: initialRead, read: initialRead });
  const read = loaded.source === initialRead ? loaded.read : initialRead;
  useReplyAnchor();
  const tree = useMemo(() => replyTree(read.items), [read.items]);
  const api = useRef<ThreadApi | null>(threadApi ?? null);
  const controls = useMemo(() => {
    const byReply = new Map<string, Continuation[]>();
    for (const value of read.continuations ?? []) {
      const values = byReply.get(value.reply) ?? [];
      values.push(value);
      byReply.set(value.reply, values);
    }
    return byReply;
  }, [read.continuations]);
  const query = sortHrefs[sort].split('?')[1]?.split('#')[0] ?? '';
  const replyHref = (reply: string, cursor?: string) => threadContinuationHref(threadPath(realm.path, reply), query, cursor);
  const load = async (continuation: Continuation & { kind: 'siblings' }) => {
    let page: ThreadRead;
    if (readPage) page = await readPage(continuation.reply, continuation.cursor);
    else {
      const language = new URLSearchParams(query).get('language');
      const { data } = await browserMainApi(undefined, { anonymous: !actingSubject }).v1
        .realms({ realm: read.realm.slice(-36) }).threads({ reply: continuation.reply.slice(-36) })
        .get({ query: { sort, cursor: continuation.cursor,
          ...(language ? { language } : {}), ...(actingSubject ? { actingSubject } : {}) },
          ...(!actingSubject && read.displayLanguages ? {
            headers: { 'x-rezics-display-languages': read.displayLanguages.join(',') },
          } : {}) });
      if (!data) throw new Error('Thread continuation unavailable');
      page = data;
    }
    // Reject into MoreReplies' retry state before a React updater can throw during render.
    assertThreadPage(read, page, continuation);
    setLoaded(current => current.source === initialRead
      ? { ...current, read: mergeThreadPage(current.read, page, continuation) } : current);
  };
  const continuation = (reply: string, depth = 0) => controls.get(reply)?.filter(value => value.kind !== 'ancestors')
    .map(value => value.kind === 'siblings' && depth < THREAD_DEPTH
      ? <MoreReplies key={`${continuationKey(value)}:${value.cursor}`} continuation={value} load={load}
          href={replyHref(value.reply)} />
      : <LocalizedLink key={continuationKey(value)} href={replyHref(value.reply, value.kind === 'siblings' ? value.cursor : undefined)}
          className="inline-flex min-h-9 w-fit items-center gap-1.5 py-1 font-medium text-primary text-sm
            underline-offset-4 hover:underline">
          {t.continueThread}<ArrowRightIcon aria-hidden="true" className="size-4" />
        </LocalizedLink>);
  if (!tree) return null;
  const focus = tree.reply;
  const opening = read.focus === read.thread;
  const opener = opening ? (focus.author?.id ?? null) : (read.ancestors[0]?.author?.id ?? null);
  const target: ReplyTarget = {
    mode: replyMode,
    realm: read.realm,
    work: read.work.id,
    rootRevision: read.rootRevision,
    api: () => (api.current ??= mainThreadApi()),
  };
  const context: ThreadContext = {
    target,
    opener,
    replyHref,
    continuation,
  };
  const replies = opening ? tree.children : [tree];
  const SortIcon = sortIcons[sort];
  const count = tree.descendants;
  return (
    <div className="grid min-w-0 gap-6">
      <LocalizedLink
        href={`${realm.path}/discussions`}
        className="inline-flex w-fit items-center gap-1.5
      text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        {t.backTo({ realm: realm.name })}
      </LocalizedLink>
      {opening ? (
        <OpeningPost post={focus} read={read} realm={realm} count={count} />
      ) : (
        <div className="grid gap-3">
          {(read.continuations ?? []).filter(value => value.kind === 'ancestors').map(value =>
            <LocalizedLink key={continuationKey(value)} href={replyHref(value.reply)}
              className="inline-flex min-h-9 w-fit items-center gap-1.5 font-medium text-primary text-sm
                underline-offset-4 hover:underline">
              <ArrowLeftIcon aria-hidden="true" className="size-4" />{t.continueThread}
            </LocalizedLink>)}
          <ReplyContext read={read} realm={realm} />
        </div>
      )}
      <section
        id="comments"
        aria-labelledby="comments-heading"
        className="grid scroll-mt-24 gap-4 border-border/60
      border-t pt-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="comments-heading" className="font-semibold text-lg">
            {opening ? t.commentsHeading : t.replyIn}
          </h2>
          {replies.length || (read.continuations ?? []).some(value => value.kind !== 'ancestors') ? <LinkMenu
            label={t.sortComments}
            value={sort}
            icon={<SortIcon aria-hidden="true" className="size-4" />}
            options={(['best', 'top', 'new'] as const).map((option) => ({
              value: option,
              label: t[option],
              help: option === 'best' ? t.bestHelp : option === 'top' ? t.topHelp : t.newHelp,
              href: `${sortHrefs[option]}#comments`,
            }))}
          /> : null}
        </div>
        {opening ? (
          <ReplyComposer
            id="reply"
            target={target}
            parent={{ reply: focus.reply, revisionId: focus.revisionId }}
          />
        ) : null}
        {replies.length ? (
          <ReplyList nodes={replies} context={context} />
        ) : (
          <h3 className="font-normal text-muted-foreground text-sm">{t.noComments}</h3>
        )}
        {opening ? continuation(focus.reply) : null}
      </section>
      {read.work.cover?.kind === 'image' ? <CatalogueCoverCredit
        work={{ id: read.work.id, title: read.work.title, cover: read.work.cover,
          kind: coverKindOf([]), authors: [] }} avatarQuery={avatarQuery} locale={locale}>
        {credit => <SubjectSources locale={locale}>
          <p className="font-medium" lang={read.work.title.language}>{read.work.title.value}</p>
          {credit}
        </SubjectSources>}
      </CatalogueCoverCredit> : null}
    </div>
  );
}
