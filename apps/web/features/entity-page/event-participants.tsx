import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import type { ProjectionRead, QuestionScope } from '../scoped-rating/api.ts';
import { EventRanking } from '../scoped-rating/event-ranking.tsx';
import { FailureNote } from '../scoped-rating/failure.tsx';
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

/**
 * What a resource is to a ranking, read at the reading position: its frame dimension (null for a person), or `hidden` when
 * it cannot be read there. A resource that is withheld must not be taken for a person, or it would be ranked.
 */
async function dimensionOf(iri: string, position?: string): Promise<string | null | 'hidden'> {
  const id = idOf(iri);
  const page = id ? await readEntityProjection(id, position) : null;
  return page?.ok && page.data.summary.status === 'available' ? (page.data.registry.frameDimension ?? null) : 'hidden';
}

/** The participants a reader may see at the position, and whether some could not be told apart from withheld ones. */
export interface EventParticipants { participants: ProjectionRead[]; failed: boolean }
const noParticipants: EventParticipants = { participants: [], failed: false };

export const readEventParticipants = cache(
  async (event: string, position?: string): Promise<EventParticipants> => {
    const { main, actingSubject } = await reader();
    const id = idOf(event);
    // Reading who points at an event needs the person's own authority, so a reader who is not signed in sees no participants.
    if (!id || !actingSubject) return noParticipants;
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
    if (!views.length) return noParticipants;
    const batch = await settle(() =>
      main.v1.resources.summaries.post({
        profile: 'resource-summary-batch-v1',
        resources: views.map((view) => view.id),
        position,
        actingSubject,
      }),
    );
    // Only participants Main names at this position leave the server: a withheld one's subject is in its row, and a
    // failed lookup cannot say which rows those are, so none is sent.
    if (!batch.ok) return { participants: [], failed: true };
    const summaries = new Map(batch.data.summaries.map((summary) => [summary.reference, summary] as const));
    return {
      participants: views.flatMap((projection) => {
        const summary = summaries.get(projection.id);
        return summary?.status === 'available' ? [{ projection, summary }] : [];
      }),
      failed: false,
    };
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
  const { participants, failed } = await readEventParticipants(page.summary.reference, position);
  const messages = await getMessages('scopedRating', locale);
  if (failed) return <FailureNote failure="unavailable" locale={locale} messages={messages} />;
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
      messages={messages}
    />
  );
}
