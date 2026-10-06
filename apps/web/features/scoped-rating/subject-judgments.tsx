'use client';

import { useMemo } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainScopedRatingApi, type ProjectionRead, type QuestionScope, type ScopedRatingApi } from './api.ts';
import { FailureNote } from './failure.tsx';
import { FrameRollup, readAllProjections } from './frame-rollup.tsx';
import { translate } from './format.ts';
import type { FrameCandidate, FrameDimension } from './frames.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { QuestionList, type EntryHref, type Viewer } from './question-rating.tsx';
import { RateInFrame } from './rate-in-frame.tsx';
import { readingPositionSource, relatedEventSource, releaseSource, staticFrameSource, type FrameSource } from './sources.ts';
import { SubjectProjections } from './subject-projections.tsx';
import type { Question, Subject } from './types.ts';
import { useLoad } from './use-load.ts';

/**
 * Where the host says a subject can be rated, as plain data a server page can hand to the browser: the sources of places the
 * picker offers are built here, where they can read from Main as the person.
 */
export type PlacePlan =
  | { kind: 'position'; work: string; name: string }
  | { kind: 'release'; work: string; name: string }
  | { kind: 'events' }
  | { kind: 'static'; dimension: FrameDimension; candidates: FrameCandidate[] };

function sourcesOf(plans: readonly PlacePlan[], subject: string, actingSubject: string | null, locale: UiLocale,
  messages: ScopedRatingMessages, position?: string): FrameSource[] {
  const t = translate(messages, locale);
  const several = (kind: 'position' | 'release') => plans.filter(plan => plan.kind === kind).length > 1;
  return plans.map(plan => {
    const reader = actingSubject ?? undefined;
    switch (plan.kind) {
      case 'position': return readingPositionSource({ work: plan.work, actingSubject: reader, position, locale,
        label: several('position') ? `${t.dimensionPosition} · ${plan.name}` : undefined });
      case 'release': return releaseSource({ work: plan.work, actingSubject: reader,
        label: several('release') ? `${t.dimensionRelease} · ${plan.name}` : undefined });
      case 'events': return relatedEventSource({ subject, actingSubject: reader });
      case 'static': return staticFrameSource(plan.dimension, plan.candidates);
    }
  });
}

/** A subject has a discussion of its own on its page but no reviews: reviews belong to the places it is rated in. */
const subjectEntry: EntryHref = entry => entry === 'discussion' ? '#discussion' : null;

/** The Work a place of a subject is in, when its frames name a position: the grouping the combined views follow. */
function workOf(read: ProjectionRead): string | null {
  if (read.summary?.status !== 'available' || !read.summary.parts) return null;
  const position = read.summary.parts.frames.find(frame => frame.type === 'occurrence');
  return position?.work ?? null;
}

/** One combined view per Work whose episodes or chapters the subject is rated in at least twice. */
function Rollups({ subject, plans, api, scope, locale, messages }: {
  subject: string; plans: readonly PlacePlan[]; api: ScopedRatingApi; scope: QuestionScope; locale: UiLocale;
  messages: ScopedRatingMessages;
}) {
  const [groups, reload] = useLoad<{ work: string; members: ProjectionRead[]; question: Question }[]>(async () => {
    const all = await readAllProjections(api, subject);
    if (!all.ok) return all;
    // A place whose summary could not be read has an unknown Work: leaving it out would drop it from a combined view unseen.
    if (all.data.some(read => read.summary === null)) return { ok: false, failure: 'unavailable' };
    const byWork = new Map<string, ProjectionRead[]>();
    for (const read of all.data) {
      const work = workOf(read);
      if (work) byWork.set(work, [...byWork.get(work) ?? [], read]);
    }
    const out: { work: string; members: ProjectionRead[]; question: Question }[] = [];
    for (const [work, members] of byWork) {
      if (members.length < 2) continue;
      const asked = await api.questions(members[0]!.projection.id, scope);
      if (!asked.ok) return asked;
      const question = asked.data[0];
      if (question) out.push({ work, members, question });
    }
    return { ok: true, data: out };
  }, `${subject}\n${scope.kind === 'realm' ? scope.realm : 'global'}`);
  if (groups.state === 'loading') return null;
  if (groups.state === 'failed') return <FailureNote failure={groups.failure} locale={locale} messages={messages} retry={reload} />;
  const names = new Map(plans.flatMap(plan => plan.kind === 'position' ? [[plan.work, plan.name] as const] : []));
  return <>{groups.data.map(({ work, members, question }) => <div key={work} data-subject-rollup={work} className="grid min-w-0 gap-3">
    {names.get(work) ? <p className="break-words font-medium text-muted-foreground text-sm">{names.get(work)}</p> : null}
    <FrameRollup subject={subject} question={question} unit="parts" api={api} members={members} locale={locale} messages={messages} />
  </div>)}</>;
}

/**
 * Everything a person can do with a subject's ratings, in one place: its own question, the choice of a specific place to
 * rate it in, the figures of every place it has been rated in, and the combined views over them. The subject's own figure
 * and the figure of any place stay separate, as the page says.
 */
export function SubjectJudgments({ subject, scope = { kind: 'global' }, actingSubject, signInHref, plans, position, api: provided,
  sources: given, locale, messages, className }: {
  subject: Subject; scope?: QuestionScope; actingSubject: string | null; signInHref: string; plans: readonly PlacePlan[];
  /** The reading position the page is read at (`all` or a chapter's id), kept on the way to each place's page. */
  position?: string;
  /** Main through the browser, unless a story or test supplies its own. */
  api?: ScopedRatingApi; sources?: readonly FrameSource[]; locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const api = useMemo(() => provided ?? mainScopedRatingApi({ actingSubject, position, locale }),
    [provided, actingSubject, position, locale]);
  const viewer: Viewer = actingSubject ? { kind: 'reader' } : { kind: 'signed-out', signInHref };
  const sources = useMemo(() => given ?? sourcesOf(plans, subject.iri, actingSubject, locale, messages, position),
    [given, plans, subject.iri, actingSubject, locale, messages, position]);
  return <div data-subject-judgments className={className ?? 'grid min-w-0 gap-8'}>
    <QuestionList api={api} target={subject.iri} scope={scope} viewer={viewer} entryHref={subjectEntry} heading={false} quiet
      locale={locale} messages={messages} />
    {sources.length ? <RateInFrame subject={subject} api={api} sources={sources} scope={scope} viewer={viewer}
      locale={locale} messages={messages} className="justify-self-start" /> : null}
    <SubjectProjections subject={subject.iri} api={api} scope={scope} position={position} level={3} locale={locale} messages={messages} />
    <Rollups subject={subject.iri} plans={plans} api={api} scope={scope} locale={locale} messages={messages} />
  </div>;
}
