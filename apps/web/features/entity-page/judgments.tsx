import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { signInPath } from '../auth/paths.ts';
import type { FrameCandidate } from '../scoped-rating/frames.ts';
import type { QuestionScope } from '../scoped-rating/api.ts';
import { SubjectJudgments, type PlacePlan } from '../scoped-rating/subject-judgments.tsx';
import { namesOf } from '../work-levels/read.ts';
import { reader, settle } from '../work-page/read.ts';
import { Region } from '../work-page/region.tsx';
import { RATINGS_REGION } from '../work-page/ratings.tsx';
import { iriOf, idOf } from '../work-page/route.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { readFrameTargets } from './frame-targets.ts';
import type { IdentityRatingScope } from './identity-read.ts';
import { readIdentityRelations } from './identity-read.ts';
import type { EntityCursors } from './route.ts';
import type { EntityProjection } from './types.ts';

// The judgments a subject page offers: its own question, the places it can be rated in and the places it has been. Shown
// when anything can be rated here (a question accepts the subject in this scope) or has been (a place of it exists), so a
// page about something nobody rates says nothing about ratings.

/** How many Works a subject's places are offered in, and how many of them list their releases. */
const MAX_WORKS = 3;
const MAX_RELEASE_WORKS = 2;

const questionScope = (scope: IdentityRatingScope): QuestionScope =>
  scope.scope === 'realm' ? { kind: 'realm', realm: scope.realm } : { kind: 'global' };

/** Whether a question accepts the subject in the scope, and whether anyone has rated it in a place, once per request. */
export const judgmentSignals = cache(async (resource: string, realm: string | null) => {
  const { main, actingSubject } = await reader();
  const id = idOf(resource);
  if (!id) return { questions: false, places: false, frames: false };
  const target = main.v1.resources({ resource: id });
  const [questions, places, frames] = await Promise.all([
    settle(() =>
      target['rating-contexts'].get({
        query: {
          actingSubject,
          ...(realm ? { scope: 'realm' as const, realm } : { scope: 'global' as const }),
        },
      }),
    ),
    settle(() =>
      main.v1.projections.get({
        query: { subject: resource, limit: 1, ...(actingSubject ? { actingSubject } : {}) },
      }),
    ),
    settle(() => target['rating-contexts'].get({ query: { actingSubject, forProjection: 'true',
      ...(realm ? { scope: 'realm' as const, realm } : { scope: 'global' as const }) } })),
  ]);
  return {
    questions: questions.ok && questions.data.items.length > 0,
    places: places.ok && places.data.items.length > 0,
    frames: frames.ok && frames.data.items.length > 0,
  };
});

const candidate = (
  iri: string,
  name: { value: string; language: string; direction: 'ltr' | 'rtl' },
  dimension: FrameCandidate['dimension'],
): FrameCandidate => ({ iri, dimension, name });

/** The Works a subject belongs to: the one it is written for, then those its relations name. */
async function worksOf(page: EntityProjection, cursors: EntityCursors, position?: string) {
  if (page.summary.status !== 'available') return [];
  const found = new Set<string>(page.summary.work ? [page.summary.work] : []);
  const relations = await readIdentityRelations(
    page.summary.reference,
    cursors.relations,
    position,
  );
  if (relations.ok)
    for (const entry of relations.data.items)
      for (const counterpart of entry.counterparts)
        if (counterpart.status === 'available' && counterpart.base === 'work')
          found.add(counterpart.reference);
  const works = [...found].slice(0, MAX_WORKS);
  const names = await namesOf(works, position);
  return works.flatMap((iri) => {
    const summary = names.get(iri);
    return summary?.status === 'available' ? [{ iri, name: summary.name }] : [];
  });
}

export async function placePlans(
  page: EntityProjection,
  cursors: EntityCursors,
  position?: string,
): Promise<PlacePlan[]> {
  if (page.summary.status !== 'available') return [];
  const [works, targets] = await Promise.all([
    worksOf(page, cursors, position),
    readFrameTargets(idOf(page.summary.reference) ?? '', position),
  ]);
  const plans: PlacePlan[] = works.map((work) => ({
    kind: 'position',
    work: work.iri,
    name: work.name.value,
  }));
  works
    .slice(0, MAX_RELEASE_WORKS)
    .forEach((work) => plans.push({ kind: 'release', work: work.iri, name: work.name.value }));
  const workCandidates = [
    ...works.map((work) => candidate(work.iri, work.name, 'work')),
    ...targets.continuities
      .filter((option) => option.kind === 'work')
      .map((option) =>
        candidate(
          iriOf(option.id),
          { value: option.label.value, language: option.label.lang, direction: option.label.dir },
          'work',
        ),
      ),
  ];
  const uniqueWorks = workCandidates.filter(
    (item, index) => workCandidates.findIndex((other) => other.iri === item.iri) === index,
  );
  if (uniqueWorks.length)
    plans.push({ kind: 'static', dimension: 'work', candidates: uniqueWorks });
  const continuities = targets.continuities
    .filter((option) => option.kind === 'narrative')
    .map((option) =>
      candidate(
        iriOf(option.id),
        { value: option.label.value, language: option.label.lang, direction: option.label.dir },
        'continuity',
      ),
    );
  if (continuities.length)
    plans.push({ kind: 'static', dimension: 'continuity', candidates: continuities });
  if (targets.events) plans.push({ kind: 'events' });
  return plans;
}

/** The ratings region of a subject page, or nothing when nothing here can be or has been rated. */
export async function SubjectJudgmentsSection({
  page,
  cursors,
  ratingScope,
  position,
  here,
  locale,
  messages,
  actingSubject,
}: {
  page: EntityProjection;
  cursors: EntityCursors;
  ratingScope: IdentityRatingScope;
  position?: string;
  /** This page's address, where a signed-out reader returns to after signing in. */
  here: string;
  locale: UiLocale;
  messages: WorkPageMessages;
  actingSubject: string | null;
}) {
  if (page.summary.status !== 'available') return null;
  const { reference, name } = page.summary;
  const signals = await judgmentSignals(
    reference,
    ratingScope.scope === 'realm' ? ratingScope.realm : null,
  );
  if (!signals.questions && !signals.places && !signals.frames) return null;
  const [plans, scoped] = await Promise.all([
    placePlans(page, cursors, position),
    getMessages('scopedRating', locale),
  ]);
  return (
    <Region id={RATINGS_REGION} title={messages.ratings}>
      <SubjectJudgments
        subject={{
          iri: reference,
          name: { value: name.value, language: name.language, direction: name.direction },
        }}
        scope={questionScope(ratingScope)}
        actingSubject={actingSubject}
        signInHref={signInPath(localizedPath(here, locale))}
        plans={plans}
        position={
          position === undefined ? undefined : position === 'all' ? 'all' : position.slice(-36)
        }
        locale={locale}
        messages={scoped}
      />
    </Region>
  );
}
