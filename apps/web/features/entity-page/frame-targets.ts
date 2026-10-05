import { cache } from 'react';
import { zoneText } from '../realm/adapt.ts';
import type { ContinuityOption } from '../wiki/continuity-switch.tsx';
import { idOf } from '../work-page/route.ts';
import { readEntityProjection, readStatements, sectionOf } from './read.ts';

// What a resource's own facts say about the places it can be read or rated in: the continuities its statements hold in,
// and whether it is related to an event. Read once per request from the unframed statements, so choosing a continuity
// never shrinks the list of continuities offered, and each coordinate is classified by the type registry's frame dimension
// rather than by a guess from its name.

/** At most this many distinct coordinates are read for one page. */
const MAX_COORDINATES = 12;

export interface FrameTargets {
  /** The continuities and Works the page's statements hold in, in the order they first appear. */
  continuities: ContinuityOption[];
  /** The page's statements name an event, so a match or event is a place it can be rated in. */
  events: boolean;
}

const none: FrameTargets = { continuities: [], events: false };

export const readFrameTargets = cache(
  async (id: string, position?: string): Promise<FrameTargets> => {
    const page = await readEntityProjection(id, position);
    if (!page.ok) return none;
    const section = sectionOf(page.data, 'statements');
    if (!section) return none;
    const read = await readStatements(section, undefined, position);
    if (!read.ok) return none;
    const where = new Set<string>();
    const values = new Set<string>();
    for (const group of read.data.groups)
      for (const item of group.items) {
        for (const coordinate of item.qualifiers.applicability) where.add(coordinate);
        if (item.kind === 'statement' && item.value.kind === 'resource') values.add(item.value.iri);
      }
    const classify = async (iri: string) => {
      const target = idOf(iri);
      const answer = target ? await readEntityProjection(target, position) : null;
      return answer?.ok && answer.data.summary.status === 'available'
        ? {
            iri,
            id: target!,
            summary: answer.data.summary,
            base: answer.data.target.base,
            dimension: answer.data.registry.frameDimension ?? null,
          }
        : null;
    };
    const [coordinates, related] = await Promise.all([
      Promise.all([...where].slice(0, MAX_COORDINATES).map(classify)),
      Promise.all(
        [...values]
          .filter((iri) => !where.has(iri))
          .slice(0, MAX_COORDINATES)
          .map(classify),
      ),
    ]);
    const continuities = coordinates.flatMap((item): ContinuityOption[] => {
      if (!item) return [];
      if (item.base === 'work')
        return [{ id: item.id, label: zoneText(item.summary.name), kind: 'work' }];
      return item.dimension === 'continuity'
        ? [{ id: item.id, label: zoneText(item.summary.name), kind: 'narrative' }]
        : [];
    });
    return {
      continuities,
      events: [...coordinates, ...related].some((item) => item?.dimension === 'event'),
    };
  },
);
