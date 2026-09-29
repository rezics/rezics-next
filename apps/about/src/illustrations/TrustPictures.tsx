import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Check, Clock, Flag, Link2, Lock, ShieldCheck, UserRound } from 'lucide-react';
import type { CSSProperties } from 'react';
import { row, type Picture, type Words } from './parts.tsx';
import { Plate } from './Plate.tsx';
import { AiDeclaration } from './SerialPictures.tsx';
import { readingVignettes } from './ReadingPictures.tsx';
import { lantern, shelf } from './sample.ts';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

/** A switch as the product draws it: on is the ink-blue track with the knob at the end. */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors',
        on ? 'bg-primary' : 'bg-secondary',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-4 rounded-full bg-background shadow-(--aura-shadow-card)',
          on ? 'end-0.5' : 'start-0.5',
        )}
      />
    </span>
  );
}

/* ---------- Hero ---------- */

/** Suitability as separate choices, and an unrated work that is never mistaken for a general one. */
export function SuitabilityChoices({ words }: Words) {
  const t = words.trust;
  const choices = [
    { name: t.teen, on: true },
    { name: t.sexual, on: false },
    { name: t.grotesque, on: false },
  ];
  return (
    <Plate className="flex flex-col gap-4">
      <p className="font-semibold">{t.suitability}</p>
      <ul className="flex flex-col gap-2.5">
        {choices.map((choice, index) => (
          <li key={choice.name} data-arrive style={at(index * 6)} className={row}>
            <span className="flex items-center gap-3">
              <Switch on={choice.on} />
              <span className="font-semibold">{choice.name}</span>
            </span>
            <span className={choice.on ? 'text-primary' : 'text-muted-foreground'}>
              {choice.on ? t.shown : t.hidden}
            </span>
          </li>
        ))}
      </ul>
      <div
        data-arrive
        style={at(20)}
        className="flex items-center gap-3 rounded-2xl border border-dashed border-border p-3"
      >
        <WorkCover
          kind="book"
          id={shelf[3].id}
          title={shelf[3].title}
          lang="zh-Hant"
          className="w-10 shrink-0 rounded-[3px] opacity-70"
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" size="md">
              {t.unrated}
            </Badge>
            <span className="text-sm text-muted-foreground">{t.hidden}</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{t.neverGeneral}</p>
        </div>
      </div>
    </Plate>
  );
}

/* ---------- A report, one step at a time ---------- */

const caseId = 'C-4F2A';

function CaseHeader({ words, badge }: Words & { badge?: string }) {
  return (
    <p className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 font-semibold">
        <Flag aria-hidden className="size-4 text-primary" />
        {words.community.case}{' '}
        <span lang="en" translate="no">
          {caseId}
        </span>
      </span>
      {badge ? (
        <Badge variant="info" size="md">
          {badge}
        </Badge>
      ) : null}
    </p>
  );
}

function Report({ words }: Words) {
  const t = words.trust;
  return (
    <>
      <p className="flex items-center justify-between gap-2">
        <span className="font-semibold">{t.report}</span>
        <Badge variant="outline" size="md">
          <UserRound aria-hidden />
          {t.anyone}
        </Badge>
      </p>
      <div
        lang="en"
        className="rounded-xl border border-border bg-background px-3.5 py-3 font-work-title"
      >
        All nine volumes free,{' '}
        <mark className="rounded bg-warning/25 px-0.5 text-foreground">DM me</mark>
      </div>
      <p
        data-arrive
        style={at(6)}
        className="flex items-center gap-2.5 rounded-xl border border-primary bg-accent px-3.5 py-3 text-sm"
      >
        <Link2 aria-hidden className="size-4 shrink-0 text-primary" />
        <span>
          <span lang="en" translate="no" className="block font-mono text-xs">
            rezics.com/cases/4f2a…
          </span>
          <span className="block text-muted-foreground">{t.privateLink}</span>
        </span>
      </p>
    </>
  );
}

function Review({ words }: Words) {
  const t = words.trust;
  return (
    <>
      <CaseHeader words={words} />
      <p className="text-sm font-semibold text-muted-foreground">{t.passage}</p>
      <div
        lang="en"
        className="rounded-xl border border-border bg-background px-3.5 py-3 font-work-title"
      >
        All nine volumes free,{' '}
        <mark className="rounded bg-warning/25 px-0.5 text-foreground">DM me</mark>
      </div>
      <ul className="flex flex-col gap-2">
        <li className={row}>
          <span>{t.flagged}</span>
          <Badge variant="outline" size="sm">
            {words.agent.automated}
          </Badge>
        </li>
        <li data-arrive style={at(8)} className={cn(row, 'border-primary bg-accent')}>
          <span className="font-semibold">{t.person}</span>
          <Check aria-hidden className="size-4 text-success-foreground" />
        </li>
      </ul>
    </>
  );
}

function Decide({ words }: Words) {
  const t = words.trust;
  return (
    <>
      <CaseHeader words={words} badge={words.community.decision} />
      <dl className="grid gap-2 text-sm">
        <div data-arrive className={row}>
          <dt className="text-muted-foreground">{t.rule}</dt>
          <dd className="font-semibold">{words.agent.unsolicitedAd}</dd>
        </div>
        <div data-arrive style={at(8)} className={row}>
          <dt className="text-muted-foreground">{t.whatChanged}</dt>
          <dd className="font-semibold">{words.community.removed}</dd>
        </div>
      </dl>
    </>
  );
}

function Appeal({ words }: Words) {
  const t = words.trust;
  const steps = [
    { name: words.community.decision, note: words.community.removed, done: true },
    { name: words.community.appeal, note: t.reviewedAgain, done: true },
    { name: t.outcome, note: `${t.upheld} · ${t.recorded}`, done: true, last: true },
  ] as const;
  return (
    <>
      <CaseHeader words={words} />
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={step.name}
            data-arrive
            style={at(index * 7)}
            className={cn(row, 'last' in step && 'relative border-primary bg-accent')}
          >
            <span>
              <span className="block font-semibold">{step.name}</span>
              <span className="block text-muted-foreground">{step.note}</span>
            </span>
            <Check aria-hidden className="size-4 text-success-foreground" />
            {'last' in step ? (
              <span className="ribbon absolute -top-1 end-8 h-6 w-2.5" aria-hidden="true" />
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}

export type CaseStage = 'report' | 'review' | 'decide' | 'appeal';

/** A report from the moment it is filed to its decision and appeal, a stage at a time. */
export function CaseFlow({ words, stage }: Words & { stage: CaseStage }) {
  return (
    <Plate className="flex flex-col gap-4">
      {stage === 'report' ? <Report words={words} /> : null}
      {stage === 'review' ? <Review words={words} /> : null}
      {stage === 'decide' ? <Decide words={words} /> : null}
      {stage === 'appeal' ? <Appeal words={words} /> : null}
    </Plate>
  );
}

/* ---------- Showcase vignettes ---------- */

function Suitability({ words }: Words) {
  const t = words.trust;
  return (
    <div className="flex w-full max-w-xs items-center gap-4">
      <WorkCover
        kind="book"
        id={lantern.id}
        title={lantern.editions[2].title}
        lang="en"
        authors={[lantern.author.en]}
        className="w-20 shrink-0 rounded-[4px]"
      />
      <ul className="flex flex-col gap-1.5">
        <li>
          <Badge variant="soft" size="md">
            {t.teen}
          </Badge>
        </li>
        <li>
          <Badge variant="outline" size="md">
            {t.unrated}
          </Badge>
        </li>
      </ul>
    </div>
  );
}

function Ai({ words }: Words) {
  return (
    <div className="flex w-full max-w-xs flex-col gap-3">
      <AiDeclaration words={words} />
      <Badge variant="success" size="md" className="self-start">
        <Check aria-hidden />
        {words.trust.reviewedByPerson}
      </Badge>
    </div>
  );
}

function Training({ words }: Words) {
  const t = words.trust;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      <li className={row}>
        <span className="flex items-center gap-2">
          <Lock aria-hidden className="size-4 text-primary" />
          {t.privateDraft}
        </span>
      </li>
      <li className={row}>
        <span>{t.training}</span>
        <span className="flex items-center gap-2 text-muted-foreground">
          {t.optIn}
          <Switch on={false} />
        </span>
      </li>
    </ul>
  );
}

function Trackers({ words }: Words) {
  const t = words.trust;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {[t.advertisingTrackers, t.analytics].map((name) => (
        <li key={name} className={row}>
          <span>{name}</span>
          <Badge variant="success" size="sm">
            {t.none}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function Safety({ words }: Words) {
  const t = words.trust;
  return (
    <ul className="flex w-full max-w-md flex-col gap-2">
      <li className={cn(row, 'flex-wrap')}>
        <span className="flex items-center gap-2">
          <ShieldCheck aria-hidden className="size-4 text-primary" />
          {t.abuseImagery}
        </span>
        <Badge variant="success" size="sm">
          {t.blockedAtUpload}
        </Badge>
      </li>
      <li className={cn(row, 'flex-wrap')}>
        <span className="flex items-center gap-2">
          <Clock aria-hidden className="size-4 text-primary" />
          {t.intimateImages}
        </span>
        <Badge variant="warning" size="sm">
          {t.within48}
        </Badge>
      </li>
    </ul>
  );
}

export const trustVignettes: Record<string, Picture> = {
  suitability: Suitability,
  ai: Ai,
  training: Training,
  trackers: Trackers,
  export: readingVignettes.export!,
  safety: Safety,
};
