import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import {
  CalendarClock,
  Check,
  Clock,
  FileText,
  Laptop,
  MessageSquare,
  Smartphone,
  UserRound,
  WifiOff,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import { row, type Picture, type Words } from './parts.tsx';
import { Plate } from './Plate.tsx';
import { serial } from './sample.ts';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

const paragraphs = [
  'The tide map had been wrong for eleven years, and Wren was the only one who knew why.',
  'She folded it along her mother’s old creases and slid it back into the drawer, as if nothing had changed.',
  'Downstairs, the ferry bell rang twice. Someone had come looking for the cartographer.',
];

/** Where each reader is when the author's Friday 20:00 arrives: the same instant, three clocks. */
const readers = [
  { city: 'Tokyo', day: 'friday', time: '20:00', own: true },
  { city: 'Lisbon', day: 'friday', time: '12:00', own: false },
  { city: 'Vancouver', day: 'friday', time: '04:00', own: false },
] as const;

/* ---------- Hero ---------- */

/**
 * A chapter's whole journey in one picture: the author's desk (a revision, saved on the
 * device with no signal) beside the phone it will land on, joined by the schedule.
 */
export function ChapterDesk({ words }: Words) {
  const d = words.desk;
  return (
    <div aria-hidden="true" data-illustration className="grid w-full grid-cols-12 items-start">
      <div className="col-start-1 col-end-10 row-start-1 rounded-[1.75rem] border border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float)">
        <p className="flex items-center justify-between gap-3">
          <span lang="en" className="font-work-title text-lg font-semibold">
            {serial.title}
          </span>
          <Laptop aria-hidden className="size-4 text-muted-foreground" />
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {fill(d.chapter, { n: serial.chapter + 1 })}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {[100, 92, 96, 58].map((width, index) => (
            <span
              key={index}
              className="h-2 rounded-full bg-muted"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Badge variant="outline" size="md">
            <WifiOff aria-hidden />
            {d.noSignal}
          </Badge>
          <Badge variant="success" size="md">
            <Check aria-hidden />
            {words.serial.saved}
          </Badge>
        </div>
      </div>
      <div
        data-arrive
        className="col-start-6 col-end-13 row-start-1 mt-24 rounded-[2rem] border-2 border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float)"
      >
        <p className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{fill(d.chapter, { n: serial.chapter + 1 })}</span>
          <Smartphone aria-hidden className="size-4" />
        </p>
        <div lang="en" className="mt-3 flex flex-col gap-2.5 font-work-title leading-relaxed">
          {paragraphs.slice(0, 2).map((text, index) => (
            <p
              key={index}
              className={cn('relative', index === 1 && '-mx-2 rounded-lg bg-accent/70 px-2 py-1')}
            >
              {text}
              {index === 1 ? <span className="ribbon absolute -end-3 -top-1 h-10 w-2.5" /> : null}
            </p>
          ))}
        </div>
        <Badge variant="soft" size="md" className="mt-3">
          <CalendarClock aria-hidden />
          {words.serial.when}
        </Badge>
      </div>
    </div>
  );
}

/* ---------- The chapter's journey, one step at a time ---------- */

function Revisions({ words }: Words) {
  const d = words.desk;
  const list = [
    { n: 7, note: words.serial.saved, live: true },
    { n: 6, note: d.restore, live: false },
    { n: 5, note: d.restore, live: false },
    { n: 4, note: d.restore, live: false },
  ] as const;
  return (
    <>
      <p className="flex flex-wrap items-center justify-between gap-3">
        <span lang="en" className="font-work-title text-lg font-semibold">
          {serial.title}
        </span>
        <Badge variant="outline" size="md">
          <WifiOff aria-hidden />
          {d.noSignal}
        </Badge>
      </p>
      <ul className="flex flex-col gap-2">
        {list.map((revision, index) => (
          <li
            key={revision.n}
            data-arrive
            style={at(index * 6)}
            className={cn(row, revision.live && 'border-primary bg-accent')}
          >
            <span className="flex items-center gap-2 font-semibold">
              <FileText aria-hidden className="size-4 text-primary" />
              {fill(words.serial.revision, { n: revision.n })}
            </span>
            {revision.live ? (
              <span className="flex items-center gap-1.5 text-success-foreground">
                <Check aria-hidden className="size-4" />
                {revision.note}
              </span>
            ) : (
              <span className="text-primary">{revision.note}</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function Schedule({ words }: Words) {
  const d = words.desk;
  return (
    <>
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {fill(d.chapter, { n: serial.chapter + 1 })} · {d.goesOutAs}{' '}
          {fill(words.serial.revision, { n: 7 })}
        </span>
        <Badge variant="info" size="md">
          <CalendarClock aria-hidden />
          {words.serial.scheduled}
        </Badge>
      </p>
      <ul className="flex flex-col gap-2">
        {readers.map((reader, index) => (
          <li
            key={reader.city}
            data-arrive
            style={at(index * 7)}
            className={cn(row, reader.own && 'border-primary bg-accent')}
          >
            <span className="flex items-center gap-2">
              <Clock aria-hidden className="size-4 text-primary" />
              {reader.own ? (
                <span className="font-semibold">{d.yourTime}</span>
              ) : (
                <span>{fill(d.readerTime, { city: reader.city })}</span>
              )}
            </span>
            <span className="font-semibold tabular-nums">
              {fill(d.atTime, { day: words.release.friday, time: reader.time })}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Resume({ words }: Words) {
  return (
    <div className="grid grid-cols-12">
      <div className="col-start-1 col-end-11 row-start-1 self-start rounded-[1.75rem] border border-border bg-background p-5">
        <p className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{fill(words.desk.chapter, { n: serial.chapter })}</span>
          <Laptop aria-hidden className="size-4" />
        </p>
        <div className="mt-4 flex flex-col gap-2.5">
          {[92, 100, 64, 0, 100, 96, 88, 0, 100, 72].map((width, index) =>
            width === 0 ? (
              <span key={index} className="h-2" />
            ) : (
              <span
                key={index}
                className={cn(
                  'h-2 rounded-full',
                  index >= 4 && index <= 6 ? 'bg-primary/35' : 'bg-muted',
                )}
                style={{ width: `${width}%` }}
              />
            ),
          )}
        </div>
      </div>
      <div data-arrive className="col-start-3 col-end-13 row-start-1 mt-14 sm:col-start-5">
        <div className="rounded-[2rem] border-2 border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float)">
          <p className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{fill(words.desk.chapter, { n: serial.chapter })}</span>
            <Smartphone aria-hidden className="size-4" />
          </p>
          <div lang="en" className="mt-3 flex flex-col gap-3 font-work-title leading-relaxed">
            {paragraphs.map((text, index) => (
              <p
                key={index}
                className={cn('relative', index === 1 && '-mx-2 rounded-lg bg-accent/70 px-2 py-1')}
              >
                {text}
                {index === 1 ? <span className="ribbon absolute -end-3 -top-1 h-10 w-2.5" /> : null}
              </p>
            ))}
          </div>
        </div>
        <p className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground">
            {words.serial.stoppedHere}
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm">
            <MessageSquare aria-hidden className="size-4" />
            {words.serial.comments}
          </span>
        </p>
      </div>
    </div>
  );
}

function Discuss({ words }: Words) {
  const comments = [
    { by: 'mira.reads', text: 'The ferry bell is doing a lot of work in this paragraph.', at: 2 },
    { by: 'harbourlight', text: 'She is lying about the drawer. Check the map’s edge.', at: 2 },
  ] as const;
  return (
    <>
      <p lang="en" className="font-work-title leading-relaxed">
        {paragraphs[1]}
        <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 align-middle font-sans text-xs font-semibold text-primary-foreground">
          <MessageSquare aria-hidden className="size-3" />2
        </span>
      </p>
      <ul className="flex flex-col gap-2">
        {comments.map((comment, index) => (
          <li
            key={comment.by}
            data-arrive
            style={at(index * 8)}
            className="rounded-xl border border-border bg-background px-3.5 py-2.5"
          >
            <p className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-1.5 font-semibold">
                <UserRound aria-hidden className="size-3.5 text-muted-foreground" />
                {comment.by}
              </span>
              <span className="text-muted-foreground">
                {fill(words.desk.onParagraph, { n: comment.at })}
              </span>
            </p>
            <p lang="en" className="type-body mt-1">
              {comment.text}
            </p>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
        <MessageSquare aria-hidden className="mt-0.5 size-4 shrink-0" />
        {fill(words.desk.laterHidden, { n: serial.chapter + 1 })}
      </p>
    </>
  );
}

export type SerialStage = 'draft' | 'schedule' | 'resume' | 'discuss';

/** One chapter from the author's desk to a reader's phone, a stage at a time. */
export function SerialFlow({ words, stage }: Words & { stage: SerialStage }) {
  return (
    <Plate className="flex flex-col gap-4">
      {stage === 'draft' ? <Revisions words={words} /> : null}
      {stage === 'schedule' ? <Schedule words={words} /> : null}
      {stage === 'resume' ? <Resume words={words} /> : null}
      {stage === 'discuss' ? <Discuss words={words} /> : null}
    </Plate>
  );
}

/* ---------- Showcase vignettes ---------- */

function Collaborators({ words }: Words) {
  const d = words.desk;
  const people = [
    { who: d.betaReader, does: d.reads },
    { who: d.editor, does: d.suggests },
    { who: d.coAuthor, does: d.edits },
    { who: d.author, does: d.publishes, you: true },
  ];
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {people.map((person) => (
        <li key={person.who} className={cn(row, person.you && 'border-primary bg-accent')}>
          <span className="flex items-center gap-2">
            <UserRound aria-hidden className="size-4 text-primary" />
            {person.who}
          </span>
          <span className="font-semibold">{person.does}</span>
        </li>
      ))}
    </ul>
  );
}

function Backup({ words }: Words) {
  const d = words.desk;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {[d.revisions, d.notes, d.world].map((name) => (
        <li key={name} className={row}>
          <span className="flex items-center gap-2">
            <FileText aria-hidden className="size-4 text-primary" />
            {name}
          </span>
          <Badge variant="outline" size="sm">
            {d.openFormat}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** How much AI helped, as a few honest levels with the author's own words beneath. */
export function AiDeclaration({ words }: Words) {
  const d = words.desk;
  const levels = [d.aiNone, d.aiAssisted, d.aiDrafted];
  return (
    <div className="flex w-full max-w-xs flex-col gap-2.5">
      <ul className="grid grid-cols-3 gap-1.5 text-center text-xs font-semibold">
        {levels.map((level, index) => (
          <li
            key={level}
            className={cn(
              'rounded-lg border px-1 py-2',
              index === 1
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background',
            )}
          >
            {level}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{d.aiDetail}</p>
    </div>
  );
}

function WorldBeside() {
  return (
    <div lang="en" className="relative w-full max-w-xs text-sm">
      <p className="font-work-title leading-relaxed">
        <span className="rounded bg-accent px-1 font-semibold text-primary underline decoration-primary/60 underline-offset-2">
          Wren
        </span>{' '}
        folded the map along her mother’s old creases.
      </p>
      <div className="mt-2 ms-6 rounded-xl border border-border bg-background p-3 shadow-(--aura-shadow-card)">
        <p className="font-semibold">Wren Halloway</p>
        <p className="mt-0.5 text-muted-foreground">
          Cartographer of the tide maps. Knows why they are wrong.
        </p>
      </div>
    </div>
  );
}

function Languages({ words }: Words) {
  const d = words.desk;
  const versions = [
    { lang: 'en', name: localeNames.en, tag: d.original },
    { lang: 'zh-Hant', name: localeNames['zh-Hant'], tag: d.translation },
    { lang: 'es', name: localeNames.es, tag: d.translation },
  ] as const;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {versions.map((version, index) => (
        <li key={version.lang} className={cn(row, index > 0 && 'ms-5')}>
          <span lang={version.lang} className="font-semibold">
            {version.name}
          </span>
          <Badge variant={index === 0 ? 'soft' : 'outline'} size="sm">
            {version.tag}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export const serialVignettes: Record<string, Picture> = {
  collaborators: Collaborators,
  backup: Backup,
  ai: AiDeclaration,
  world: WorldBeside,
  languages: Languages,
};
