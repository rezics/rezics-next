import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import {
  ArrowRight,
  BookOpen,
  Check,
  Eye,
  Flag,
  Link2,
  Lock,
  MessageSquare,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import { row, type Picture, type Words } from './parts.tsx';
import { Plate } from './Plate.tsx';
import { lanternThread, world } from './sample.ts';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

const [earlier, middle, confirmed] = [
  lanternThread.posts[2],
  lanternThread.posts[1],
  lanternThread.posts[3],
] as const;
const [role, home, faction] = lanternThread.facts;

/** A post in the conversation, in the language its author wrote it in. */
function Post({
  post,
  words,
  marked = false,
  arrive,
}: {
  post: { by: string; lang: string; chapter: number; text: string };
  words: Words['words'];
  marked?: boolean;
  arrive?: number;
}) {
  return (
    <li
      data-arrive={arrive === undefined ? undefined : ''}
      style={arrive === undefined ? undefined : at(arrive)}
      className={cn(
        'rounded-xl border bg-background px-3 py-2.5',
        marked ? 'border-primary ring-2 ring-primary/25' : 'border-border',
      )}
    >
      <p className="flex items-center justify-between gap-2 text-sm">
        <span lang={post.lang} className="flex items-center gap-1.5 font-semibold">
          <UserRound aria-hidden className="size-3.5 text-muted-foreground" />
          {post.by}
        </span>
        <span className="text-muted-foreground">
          {fill(words.shelf.chapter, { n: post.chapter })}
        </span>
      </p>
      <p lang={post.lang} className="type-body mt-1">
        {post.text}
      </p>
    </li>
  );
}

/** One of Ren's wiki facts, the chapter that states it and, for the kept one, the thread it came from. */
function Fact({
  fact,
  words,
  marked = false,
}: {
  fact: { text: string; chapter: number };
  words: Words['words'];
  marked?: boolean;
}) {
  return (
    <li
      className={cn(
        'rounded-xl border bg-background px-3 py-2.5',
        marked ? 'border-primary ring-2 ring-primary/25' : 'border-border',
      )}
    >
      <p lang="en" className="font-work-title font-semibold">
        {fact.text}
        <sup className="ms-0.5 font-sans text-xs font-semibold text-primary">
          {fill(words.shelf.chapter, { n: fact.chapter })}
        </sup>
      </p>
      {marked ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-primary">
          <Link2 aria-hidden className="size-3.5" />
          {words.community.startedIn}
        </p>
      ) : null}
    </li>
  );
}

/* ---------- Hero: the conversation beside what it kept ---------- */

/**
 * A Realm's conversation beside the knowledge it maintains: posts in three languages on
 * one side, the wiki page they feed on the other, the fact confirmed in one post carrying
 * a link back to it. The conversation scrolls away; the wiki stays.
 */
export function RealmScene({ words }: Words) {
  const c = words.community;
  return (
    <Plate className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <UsersRound aria-hidden className="size-5" />
        </span>
        <p lang="en" className="font-work-title text-xl font-semibold">
          {words.realm.name}
        </p>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div>
          <p className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <MessageSquare aria-hidden className="size-4" />
            {c.conversation}
          </p>
          <ul className="flex flex-col gap-2.5">
            <Post post={earlier} words={words} arrive={0} />
            <Post post={middle} words={words} arrive={6} />
            <Post post={confirmed} words={words} arrive={12} marked />
          </ul>
        </div>
        <ArrowRight aria-hidden className="mt-24 hidden size-5 text-primary sm:block" />
        <div data-arrive style={at(20)}>
          <p className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <BookOpen aria-hidden className="size-4" />
            {c.knowledge}
          </p>
          <p lang="en" className="mb-2 font-work-title font-semibold">
            {words.thread.wikiName}
          </p>
          <ul className="flex flex-col gap-2.5">
            <Fact fact={role} words={words} />
            <Fact fact={home} words={words} />
            <Fact fact={faction} words={words} marked />
          </ul>
        </div>
      </div>
    </Plate>
  );
}

/* ---------- A Realm's growth, one step at a time ---------- */

/** Rules stated once in each language the Realm speaks. */
function Rules({ words }: Words) {
  const rules = [
    { lang: 'en', text: 'Mark spoilers until a volume is a month old.' },
    { lang: 'zh-Hant', text: '新書出版一個月內，請標註劇透。' },
    { lang: 'ja', text: '刊行から一か月はネタバレを明記してください。' },
  ];
  return (
    <>
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span lang="en" className="font-work-title text-lg font-semibold">
          {words.realm.name}
        </span>
        <Badge variant="soft" size="md">
          {words.community.sameForEveryone}
        </Badge>
      </p>
      <p className="text-sm font-semibold text-muted-foreground">{words.community.rules}</p>
      <ul className="flex flex-col gap-2.5">
        {rules.map((rule, index) => (
          <li
            key={rule.lang}
            data-arrive
            style={at(index * 7)}
            className="rounded-xl border border-border bg-background px-3.5 py-3"
          >
            <p className="text-xs text-muted-foreground">
              {localeNames[rule.lang as keyof typeof localeNames]}
            </p>
            <p lang={rule.lang} className="type-body mt-0.5">
              {rule.text}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Follow to read along, join to take part: which is which, at a glance. */
function Gather({ words }: Words) {
  const c = words.community;
  const columns = [
    {
      name: c.follow,
      blurb: c.followBlurb,
      can: [c.readAlong],
      cannot: [c.post, c.reply, c.review],
      strong: false,
    },
    {
      name: c.join,
      blurb: c.joinBlurb,
      can: [c.readAlong, c.post, c.reply, c.review],
      cannot: [],
      strong: true,
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {columns.map((column, index) => (
        <div
          key={column.name}
          data-arrive
          style={at(index * 8)}
          className={cn(
            'rounded-2xl border bg-background p-4',
            column.strong ? 'border-primary' : 'border-border',
          )}
        >
          <p className="font-semibold">{column.name}</p>
          <p className="text-sm text-muted-foreground">{column.blurb}</p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {column.can.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <Check aria-hidden className="size-4 text-success-foreground" />
                {item}
              </li>
            ))}
            {column.cannot.map((item) => (
              <li key={item} className="flex items-center gap-2 text-muted-foreground">
                <X aria-hidden className="size-4" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** A reader's theory, and the fact the wiki keeps once chapter 30 confirms it. */
const theory = {
  by: 'mira.reads',
  lang: 'en',
  chapter: 19,
  text: 'Theory: Ren has known about the flood ledger since the very first night.',
};
const kept = { text: 'Ren has known about the flood ledger since chapter 1.', chapter: 30 };

/** A theory confirmed in chapter 30 becomes a sourced fact on the wiki, linked to the thread. */
function Keep({ words }: Words) {
  const c = words.community;
  return (
    <>
      <ul className="flex flex-col gap-2.5">
        <Post post={theory} words={words} marked />
      </ul>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="success" size="md">
          <Check aria-hidden />
          {fill(c.confirmedIn, { n: 30 })}
        </Badge>
        <span className="rounded-full bg-primary px-3 py-1.5 font-semibold text-primary-foreground">
          {c.keepInWiki}
        </span>
      </p>
      <div data-arrive style={at(10)} className="flex flex-col gap-2.5">
        <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <BookOpen aria-hidden className="size-4" />
          <span lang="en">{world.ren}</span>
        </p>
        <ul className="flex flex-col gap-2.5">
          <Fact fact={kept} words={words} marked />
        </ul>
      </div>
    </>
  );
}

/** Newcomers' gentle limits lifting as they take part, and a report that becomes a case. */
function Protect({ words }: Words) {
  const c = words.community;
  return (
    <>
      <div className="rounded-2xl border border-border bg-background p-4">
        <p className="flex items-center justify-between gap-2">
          <span className="font-semibold">{c.newcomer}</span>
          <span className="text-sm text-muted-foreground">{fill(c.postsPerDay, { n: 5 })}</span>
        </p>
        <div className="mt-3 h-2 rounded-full bg-secondary">
          <div data-arrive className="h-full w-1/3 rounded-full bg-primary" />
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{c.limitsLift}</p>
      </div>
      <div data-arrive style={at(8)} className="rounded-2xl border border-border bg-background p-4">
        <p className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-semibold">
            <Flag aria-hidden className="size-4 text-primary" />
            {c.case}
          </span>
          <Badge variant="warning" size="sm">
            {c.appealOpen}
          </Badge>
        </p>
        <dl className="mt-2 grid gap-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{c.reason}</dt>
            <dd>{words.agent.unsolicitedAd}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{c.decision}</dt>
            <dd>{c.removed}</dd>
          </div>
        </dl>
      </div>
    </>
  );
}

export type RealmStage = 'found' | 'gather' | 'keep' | 'protect';

/** A Realm from its first post to its hundredth page, a stage at a time. */
export function RealmFlow({ words, stage }: Words & { stage: RealmStage }) {
  return (
    <Plate className="flex flex-col gap-4">
      {stage === 'found' ? <Rules words={words} /> : null}
      {stage === 'gather' ? <Gather words={words} /> : null}
      {stage === 'keep' ? <Keep words={words} /> : null}
      {stage === 'protect' ? <Protect words={words} /> : null}
    </Plate>
  );
}

/* ---------- Showcase vignettes ---------- */

function Languages({ words }: Words) {
  const c = words.community;
  return (
    <div className="flex w-full max-w-xs flex-col gap-2 text-sm">
      <div className="rounded-xl border border-border bg-background px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {fill(c.translatedFrom, { language: localeNames.ja })}
        </p>
        <p lang="ja" className="mt-0.5">
          {middle.text}
        </p>
      </div>
      <p className="flex items-center gap-1.5 self-end text-primary">
        <Eye aria-hidden className="size-4" />
        {fill(c.readIn, { language: localeNames.en })}
      </p>
      <p lang="en" className="rounded-xl bg-accent px-3 py-2">
        The flood ledger in chapter 8 stopped me cold.
      </p>
    </div>
  );
}

function WikiOwnership({ words }: Words) {
  const c = words.community;
  return (
    <div className="flex w-full max-w-xs flex-col gap-2">
      <p className={row}>
        <span className="flex items-center gap-2">
          <BookOpen aria-hidden className="size-4 text-primary" />
          <span lang="en">{words.realm.name}</span>
        </span>
        <Badge variant="soft" size="sm">
          {c.knowledge}
        </Badge>
      </p>
      <p className={row}>
        <span>{c.agentsMayHelp}</span>
        <Badge variant="outline" size="sm">
          <Lock aria-hidden />
          {c.off}
        </Badge>
      </p>
      <p className="text-sm text-muted-foreground">{c.setByRealm}</p>
    </div>
  );
}

function Recognition({ words }: Words) {
  const c = words.community;
  return (
    <div className="w-full max-w-xs rounded-xl border border-border bg-background p-3 text-sm">
      <p className="flex items-center justify-between gap-2">
        <span className="font-semibold">{fill(c.level, { n: 3 })}</span>
        <span className="text-muted-foreground">{fill(c.accepted, { n: 42 })}</span>
      </p>
      <div className="mt-2 h-1.5 rounded-full bg-secondary">
        <div className="h-full w-2/3 rounded-full bg-primary" />
      </div>
      <p className="mt-2 text-muted-foreground">{c.perContribution}</p>
    </div>
  );
}

function Cases({ words }: Words) {
  const c = words.community;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {[
        { reason: words.agent.unsolicitedAd, decision: c.removed, badge: c.appealOpen },
        { reason: words.agent.ownWork, decision: words.agent.keep, badge: null },
      ].map((item) => (
        <li
          key={item.reason}
          className="rounded-xl border border-border bg-background px-3 py-2 text-sm"
        >
          <p className="flex items-center justify-between gap-2">
            <span className="font-semibold">{item.reason}</span>
            {item.badge ? (
              <Badge variant="warning" size="sm">
                {item.badge}
              </Badge>
            ) : null}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {c.decision}: {item.decision}
          </p>
        </li>
      ))}
    </ul>
  );
}

export const communityVignettes: Record<string, Picture> = {
  languages: Languages,
  wiki: WikiOwnership,
  recognition: Recognition,
  cases: Cases,
};
