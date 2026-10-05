'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { ArrowUpRightIcon, BanIcon, BookOpenTextIcon, EyeIcon, EyeOffIcon, ScaleIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useId, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { agentLabel, dateTime, isoTime, relativeTime, shownHandle } from './format.ts';
import { completionText, recordFacts, workTypeText } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import { AgentMark, WorkThumb } from './parts.tsx';
import type { ShownName, Subject } from './queue-subject.ts';
import type { AgentSummary, PersonRecord, PublishedRule, WorkFacts } from './types.ts';

type T = ReturnType<typeof materializeData<ManageMessages>>;

/** A name in its own language and direction. */
export function Shown({ name, className }: { name: ShownName; className?: string }) {
  return <span lang={name.language} dir={name.direction} className={className}>{name.value}</span>;
}

/** A subject's name on one line: a chapter's label, then its Book's title, quieter. */
export function SubjectName({ subject, fallback, className }: { subject: Subject; fallback: string; className?: string }) {
  return <span className={className}>
    {subject.title ? <Shown name={subject.title} /> : subject.isChapter ? subject.text : fallback}
    {subject.title && subject.book ? <span className="font-normal text-muted-foreground"> · <Shown name={subject.book} /></span> : null}
  </span>;
}

/**
 * What an item is about, as its reviewer judges it: the cover, the name, what
 * kind of Work it is and who wrote it, its hook, and where to read it.
 */
export function SubjectHeader({ subject, facts, headingId, fallback, locale, t }: { subject: Subject;
  facts: WorkFacts | undefined; headingId: string; fallback: string; locale: UiLocale; t: T }) {
  const work = subject.work;
  // A chapter is told by its Book: the Book's hook, status and authors.
  const told = subject.cover.work ?? work;
  const kind = subject.isChapter ? t.typeChapter : workTypeText(work, locale);
  const authors = facts?.authors.map(author => author.name) ?? [];
  const status = [kind, completionText(told?.completionStatus, t),
    told?.chapterCount ? t.chapterCount(told.chapterCount) : null].filter(Boolean).join(' · ');
  return <div className="flex gap-4">
    <WorkThumb iri={subject.cover.iri} work={subject.cover.work} label={subject.book?.value ?? subject.text}
      className="w-16 sm:w-20" />
    <div className="grid min-w-0 content-start gap-1.5">
      <h3 id={headingId} className="text-pretty font-work-title text-xl leading-snug">
        <SubjectName subject={subject} fallback={fallback} /></h3>
      {status || authors.length ? <p className="text-muted-foreground text-sm">
        {[status, authors.length ? t.byAuthors({ authors: authors.join(', ') }) : null].filter(Boolean).join(' · ')}</p>
        : null}
      {work?.originalTitle && work.originalTitle !== work.title.value && !subject.book
        ? <p className="text-muted-foreground text-sm" dir="auto">{work.originalTitle}</p> : null}
      {told?.tagline ? <p className="text-pretty text-sm">
        <span className="sr-only">{t.hookLabel}: </span>
        <Shown name={told.tagline} className="italic" /></p> : null}
      {work || subject.book ? <LocalizedLink href={subject.href} className="inline-flex items-center gap-1 justify-self-start rounded-md
        font-medium text-primary text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        {subject.book ? t.readChapter : t.openWork}<ArrowUpRightIcon aria-hidden="true" className="size-3.5" /></LocalizedLink>
        : <p className="text-muted-foreground text-xs">{t.workUnavailable}</p>}
    </div>
  </div>;
}

/**
 * A text to judge: a submitted draft or a chapter's opening. Words that
 * belong to a Book are veiled until asked for, flagged as spoiling it; a
 * moderator should not learn the ending from the queue by accident.
 */
export function SpoilerText({ heading, spoils, text, language, direction, note, unavailable, loading = false, t }: {
  heading: string; spoils: string | null; text: string | null; language?: string; direction?: 'ltr' | 'rtl';
  note?: string | null; unavailable: string; loading?: boolean; t: T;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  const veiled = spoils !== null && !shown;
  return <section aria-labelledby={`${id}-title`} className="grid gap-2">
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
      <h4 id={`${id}-title`} className="font-medium text-muted-foreground text-xs">{heading}</h4>
      {spoils !== null && text ? <Button size="xs" variant="ghost" aria-expanded={shown} aria-controls={`${id}-text`}
        onClick={() => setShown(value => !value)}>
        {shown ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}{shown ? t.hideText : t.showText}
      </Button> : null}
    </div>
    {loading ? <div className="grid gap-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-2/3" /></div>
      : !text ? <p className="text-muted-foreground text-sm">{unavailable}</p>
        : <div id={`${id}-text`} className="grid gap-2">
          {veiled ? <p className="flex items-center gap-2 rounded-xl border border-border/60 border-dashed px-4 py-3 text-sm">
            <BookOpenTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {t.spoilerWarning({ book: spoils })}</p>
            : <blockquote lang={language} dir={direction ?? 'auto'} className="max-h-72 overflow-y-auto whitespace-pre-line
              rounded-xl border-primary/40 border-s-2 bg-muted/40 px-4 py-3 font-work-title leading-relaxed">{text}</blockquote>}
          {note && !veiled ? <p className="text-muted-foreground text-xs">{note}</p> : null}
        </div>}
  </section>;
}

/** A mod's game, versions and loaders, as its author recorded them from the mod's own files. */
export function ModFacts({ facts, t }: { facts: WorkFacts | undefined; t: T }) {
  const mod = facts?.mod;
  if (!mod) return <p className="text-muted-foreground text-sm">{t.modMissing}</p>;
  const rows: Array<[string, string]> = [[t.modGame, mod.game], [t.modVersions, mod.gameVersions.join(', ')],
    [t.modLoaders, mod.loaders.join(', ')], ...mod.latestRelease ? [[t.modRelease, mod.latestRelease] as [string, string]] : []];
  return <section aria-label={t.modCompatibility} className="grid gap-2">
    <h4 className="font-medium text-muted-foreground text-xs">{t.modCompatibility}</h4>
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      {rows.filter(([, value]) => value).map(([label, value]) => <div key={label}
        className="rounded-xl bg-muted/40 px-3 py-2"><dt className="text-muted-foreground text-xs">{label}</dt>
        <dd className="font-medium">{value}</dd></div>)}
    </dl>
  </section>;
}

/** A prompt's text, or a skill's summary and instructions, as readers would copy them. */
export function HubText({ facts, prompt, t }: { facts: WorkFacts | undefined; prompt: boolean; t: T }) {
  const hub = facts?.hub;
  const heading = prompt ? t.promptText : t.skillInstructions;
  if (!hub) return <section aria-label={heading} className="grid gap-2">
    <h4 className="font-medium text-muted-foreground text-xs">{heading}</h4>
    <p className="text-muted-foreground text-sm">{t.hubUnavailable}</p></section>;
  return <section aria-label={heading} className="grid gap-2">
    {hub.kind === 'skill-package' && hub.summary ? <>
      <h4 className="font-medium text-muted-foreground text-xs">{t.skillSummary}</h4>
      <p dir="auto" className="text-sm">{hub.summary}</p></> : null}
    <h4 className="font-medium text-muted-foreground text-xs">{heading}</h4>
    <pre dir="auto" className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/40 px-4 py-3 font-mono
      text-xs leading-relaxed">{hub.text}</pre>
    {hub.declaredModels.length ? <p className="text-muted-foreground text-xs">
      {t.writtenFor({ models: hub.declaredModels.join(', ') })}</p> : null}
    {hub.truncated ? <p className="text-muted-foreground text-xs">{t.hubShortened}</p> : null}
  </section>;
}

/** The published rule a report names, as readers of the Realm see it. */
export function RuleNote({ rule, number, t }: { rule: PublishedRule; number: number; t: T }) {
  return <section aria-label={t.ruleItMayBreak} className="grid gap-1 rounded-xl border border-border/60 px-3 py-2.5 text-sm">
    <p className="flex items-center gap-1.5 text-muted-foreground text-xs"><ScaleIcon aria-hidden="true" className="size-3.5" />
      {t.ruleItMayBreak}</p>
    <p className="font-medium"><span className="text-muted-foreground">{number}. </span>
      <Shown name={rule.title} /></p>
    <p className="text-muted-foreground"><Shown name={rule.body} /></p>
  </section>;
}

/** The Realm's rules, numbered as moderators cite them; the one a report names is marked. */
export function RealmRules({ rules, marked, t }: { rules: readonly PublishedRule[]; marked: string | null; t: T }) {
  if (!rules.length) return null;
  return <details className="group rounded-xl border border-border/60 px-3 py-2 text-sm">
    <summary className="cursor-pointer rounded-md font-medium text-muted-foreground text-xs outline-none
      focus-visible:ring-2 focus-visible:ring-ring">{t.realmRules}</summary>
    <ol className="mt-2 grid gap-2">
      {rules.map((rule, index) => <li key={rule.id} className={cn('grid gap-0.5', rule.id === marked && 'font-medium')}>
        <span><span className="text-muted-foreground">{index + 1}. </span><Shown name={rule.title} /></span>
        <Shown name={rule.body} className="text-muted-foreground text-xs" />
      </li>)}
    </ol>
  </details>;
}

/**
 * Who raised the item and their record here: whether they belong to the
 * Realm or are banned, and how their earlier submissions or reports went.
 */
export function PersonCard({ iri, agents, record, label, time, now, locale, messages }: {
  iri: string | null; agents: Record<string, AgentSummary>; record: PersonRecord | undefined;
  label: (agent: string) => string; time: string; now: number; locale: UiLocale; messages: ManageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = iri ? agentLabel(agents[iri], iri, id => t.agentFallback({ id })) : t.unknownAuthor;
  const handle = iri ? shownHandle(agents[iri]?.handle ?? null) : null;
  const facts = record ? recordFacts(record, t, locale) : null;
  return <div className="grid gap-2">
    <div className="flex items-center gap-2.5 text-sm">
      <AgentMark name={name} iri={iri ?? 'unknown'} />
      <p className="min-w-0">
        <span>{label(name)}</span>
        {handle ? <span className="ms-1.5 text-muted-foreground">{handle}</span> : null}
        <span className="block text-muted-foreground text-xs"><time dateTime={isoTime(time)} title={dateTime(time, locale)}
          suppressHydrationWarning>{relativeTime(time, now, locale)}</time>
          {facts && !facts.banned ? <> · {facts.standing}</> : null}</span>
      </p>
    </div>
    {facts ? <dl className="grid gap-1.5 ps-10.5 text-sm">
      {facts.banned ? <div><dt className="sr-only">{t.memberJoined}</dt><dd>
        <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive-foreground">
          <BanIcon aria-hidden="true" />{facts.standing}</Badge></dd></div> : null}
      {facts.submissions ? <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{t.submissionsHere}</dt>
        <dd>{facts.submissions.join(' · ')}</dd></div> : null}
      {facts.reports ? <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{t.reportsHere}</dt>
        <dd>{facts.reports.join(' · ')}</dd></div> : null}
    </dl> : null}
  </div>;
}
