import type { ZonePackage } from '@rezics/zone-sdk';
import { cache } from 'react';
import { readIdentityRelations } from '../entity-page/identity-read.ts';
import { resourceBinding } from '../entity-page/identity-relations.ts';
import { zoneText } from '../realm/adapt.ts';
import { reader, settle } from '../work-page/read.ts';
import { idOf } from '../work-page/route.ts';
import type { ContinuityOption } from './continuity-switch.tsx';
import { type ContinuityChoice, offContinuity, parseContinuity } from './continuity.ts';
import type { PositionState } from './state.ts';

type Search = Record<string, string | string[] | undefined>;

/** The meaning every in-continuity statement of a Work is recorded under, by its key; null where the lexicon lacks it. */
const readMembershipDefinition = cache(async (): Promise<string | null> => {
  const { main, actingSubject } = await reader();
  const read = await settle(() =>
    main.v1.lexicon.definitions({ key: 'in-continuity' }).get({ query: { actingSubject } }),
  );
  return read.ok ? read.data.definition : null;
});

/** The continuities a Work is part of, as its own relations name them: the choices a reader of its franchise has. */
export const readWorkContinuities = cache(
  async (work: string, position?: string): Promise<ContinuityOption[]> => {
    const [definition, relations] = await Promise.all([
      readMembershipDefinition(),
      readIdentityRelations(work, undefined, position),
    ]);
    if (!definition || !relations.ok) return [];
    const options = new Map<string, ContinuityOption>();
    for (const entry of relations.data.items) {
      if (entry.rendering?.meaning.definition !== definition) continue;
      const ref = resourceBinding(entry, 'continuity');
      const summary = entry.counterparts.find((item) => item.reference === ref);
      const id = ref ? idOf(ref) : null;
      if (id && summary?.status === 'available' && !options.has(id))
        options.set(id, {
          id,
          label: zoneText(summary.name),
          kind: summary.base === 'work' ? 'work' : 'narrative',
        });
    }
    return [...options.values()];
  },
);

/** What a Zone that offers a continuity switch shows: the choices, the continuity its package starts readers in, and the reader's own. */
export interface ZoneContinuity {
  options: readonly ContinuityOption[];
  fallback: ContinuityChoice;
  choice: ContinuityChoice;
}

const normalised = (text: string) => text.trim().toLocaleLowerCase();

/**
 * The continuity this reader reads the Zone in. Off unless the address carries one or the package names a default that the
 * franchise's Work has (by name, ignoring case); no choice is ever made from anything else, and a Zone whose package does
 * not offer the switch has none.
 */
export async function zoneContinuity(
  pkg: ZonePackage | null,
  state: PositionState | null,
  search: Search,
): Promise<ZoneContinuity | null> {
  if (!pkg?.continuity || !state) return null;
  const options = await readWorkContinuities(state.work, state.main);
  const wanted = pkg.continuity.default ? normalised(pkg.continuity.default) : null;
  const named = wanted
    ? options.find((option) => normalised(option.label.value) === wanted)
    : undefined;
  const fallback: ContinuityChoice = named ? { kind: 'at', continuity: named.id } : offContinuity;
  return { options, fallback, choice: parseContinuity(search, fallback) };
}
