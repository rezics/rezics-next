import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import type { ProjectionRead, QuestionScope } from '../scoped-rating/api.ts';
import { EventRanking } from '../scoped-rating/event-ranking.tsx';
import { reader, settle } from '../work-page/read.ts';
import { idOf } from '../work-page/route.ts';
import { readEntityProjection, readStatements, sectionOf } from './read.ts';
import type { IdentityRatingScope } from './identity-read.ts';
import type { EntityProjection } from './types.ts';

// The participants of an event, found as the data says: who the event's statements point at, and who points at it or at the
// events it is part of (a map belongs to a match, and a player takes part in the match). Each is then looked up, never
// created, as a place within this event, so only people who have a place here can be ranked.

/** At most this many events are followed up from this one, and this many people looked up. */
const MAX_CONTAINERS = 6;
const MAX_PEOPLE = 20;

/** The registry's frame dimension of a resource, or null when it is not readable or not a frame. */
async function dimensionOf(iri: string, position?: string): Promise<string | null> {
  const id = idOf(iri);
  const page = id ? await readEntityProjection(id, position) : null;
  return page?.ok ? (page.data.registry.frameDimension ?? null) : null;
}

export const readEventParticipants = cache(
  async (event: string, position?: string): Promise<ProjectionRead[]> => {
    const { main, actingSubject } = await reader();
    const id = idOf(event);
    // Reading who points at an event needs the person's own authority, so a reader who is not signed in sees no participants.
    if (!id || !actingSubject) return [];
    const own = await readEntityProjection(id, position);
    const section = own.ok ? sectionOf(own.data, 'statements') : undefined;
    const statements = section ? await readStatements(section, undefined, position) : null;
    const values = statements?.ok
      ? [
          ...new Set(
            statements.data.groups.flatMap((group) =>
              group.items.flatMap((item) =>
                item.kind === 'statement' && item.value.kind === 'resource' ? [item.value.iri] : [],
              ),
            ),
          ),
        ].slice(0, MAX_CONTAINERS)
      : [];
    const containers = (
      await Promise.all(
        values.map(async (iri) => ((await dimensionOf(iri, position)) === 'event' ? iri : null)),
      )
    ).flatMap((iri) => (iri ? [iri] : []));
    const pointing = await Promise.all(
      [event, ...containers].map(async (anchor) => {
        const answer = await settle(() =>
          main.v1.graph.queries.post({
            profile: 'statement-graph-v1',
            actingSubject,
            anchor,
            direction: 'incoming',
          }),
        );
        return answer.ok && 'claims' in answer.data
          ? answer.data.claims.map((claim) => claim.subject)
          : [];
      }),
    );
    const candidates = [...new Set(pointing.flat())]
      .filter((iri) => iri !== event && !containers.includes(iri))
      .slice(0, MAX_PEOPLE);
    const people = (
      await Promise.all(
        candidates.map(async (iri) => ((await dimensionOf(iri, position)) === null ? iri : null)),
      )
    ).flatMap((iri) => (iri ? [iri] : []));
    const found = await Promise.all(
      people.map(async (subject) => {
        const looked = await settle(() =>
          main.v1.projections.get({ query: { subject, frame: event, actingSubject } }),
        );
        return looked.ok ? looked.data.items : [];
      }),
    );
    const views = found.flat();
    if (!views.length) return [];
    const batch = await settle(() =>
      main.v1.resources.summaries.post({
        profile: 'resource-summary-batch-v1',
        resources: views.map((view) => view.id),
        actingSubject,
      }),
    );
    const summaries = new Map(
      batch.ok ? batch.data.summaries.map((summary) => [summary.reference, summary] as const) : [],
    );
    return views.map((projection) => ({
      projection,
      summary: summaries.get(projection.id) ?? null,
    }));
  },
);

/** The ranking of an event's participants by the published weighted rating, or nothing when nobody has a place in it. */
export async function EventRankingSection({
  page,
  ratingScope,
  position,
  locale,
  actingSubject,
}: {
  page: EntityProjection;
  ratingScope: IdentityRatingScope;
  position?: string;
  locale: UiLocale;
  actingSubject: string | null;
}) {
  if (page.summary.status !== 'available' || page.registry.frameDimension !== 'event') return null;
  const participants = await readEventParticipants(page.summary.reference, position);
  if (!participants.length) return null;
  const scope: QuestionScope =
    ratingScope.scope === 'realm'
      ? { kind: 'realm', realm: ratingScope.realm }
      : { kind: 'global' };
  return (
    <EventRanking
      participants={participants}
      scope={scope}
      actingSubject={actingSubject}
      locale={locale}
      messages={await getMessages('scopedRating', locale)}
    />
  );
}
