import type { ZonePackage } from '@rezics/zone-sdk';
import { cache } from 'react';
import { zoneText } from '../realm/adapt.ts';
import { readNames } from '../work-levels/read.ts';
import type { AvailableSummary } from '../work-levels/types.ts';
import { reader, settle } from '../work-page/read.ts';
import { idOf } from '../work-page/route.ts';
import type { ContinuityOption } from './continuity-switch.tsx';
import { type ContinuityChoice, offContinuity, parseContinuity } from './continuity.ts';
import type { PositionState } from './state.ts';

type Search = Record<string, string | string[] | undefined>;

/** A Work's continuities are read this many pages deep (20 each); a franchise with more shows the first ones. */
const MAX_PAGES = 5;

/** One entry of Main's `work-continuities-v1`: the continuity's resource IRI is its key, and `label` is its name for this reader. */
export interface WorkContinuity {
  key: string;
  label: AvailableSummary['name'];
}

/**
 * The choices a continuity list offers. The kind (a narrative continuity or a Work's own timeline) comes from the
 * resource's summary, and only groups the switch; a continuity that cannot be named has no id the address could carry.
 */
export function continuityOptions(
  items: readonly WorkContinuity[],
  bases: ReadonlyMap<string, string | undefined>,
): ContinuityOption[] {
  const seen = new Set<string>();
  return items.flatMap((item): ContinuityOption[] => {
    const id = idOf(item.key);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: zoneText(item.label), kind: bases.get(item.key) === 'work' ? 'work' : 'narrative' }];
  });
}

/**
 * The continuity a Zone's setting names, if the Work is part of it. The setting is the continuity's key (its UUID or IRI),
 * which stays the same in every language; a display name never selects one.
 */
export function defaultContinuity(
  options: readonly ContinuityOption[],
  setting: string | undefined,
): ContinuityChoice {
  const wanted = setting ? (idOf(setting) ?? setting.toLowerCase()) : null;
  const found = wanted ? options.find((option) => option.id === wanted) : undefined;
  return found ? { kind: 'at', continuity: found.id } : offContinuity;
}

/** The continuities a Work is part of, as Main lists them for this reader and position: the choices a reader of its franchise has. */
export const readWorkContinuities = cache(
  async (work: string, position?: string): Promise<ContinuityOption[]> => {
    const id = idOf(work);
    if (!id) return [];
    const { main, actingSubject } = await reader();
    const items: WorkContinuity[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const read = await settle(
        () =>
          main.v1
            .resources({ resource: id })
            .continuities.get({ query: { actingSubject, position, cursor } }),
        cursor,
      );
      if (!read.ok) break;
      items.push(...read.data.items.map((item) => ({ key: item.key, label: item.label })));
      cursor = read.data.nextCursor ?? undefined;
      if (!cursor) break;
    }
    if (!items.length) return [];
    const names = await readNames(items.map((item) => item.key).join(' '), position);
    const bases = new Map<string, string | undefined>();
    for (const item of items) {
      const named = names.get(item.key);
      bases.set(item.key, named?.status === 'available' ? named.base ?? undefined : undefined);
    }
    return continuityOptions(items, bases);
  },
);

/** What a Zone that offers a continuity switch shows: the choices, the continuity its setting starts readers in, and the reader's own. */
export interface ZoneContinuity {
  options: readonly ContinuityOption[];
  fallback: ContinuityChoice;
  choice: ContinuityChoice;
}

/**
 * The continuity this reader reads the Zone in. Off unless the address carries one or the Zone's setting names, by key, one
 * the franchise's Work is part of; no choice is ever made from anything else, and a Zone whose package does not offer the
 * switch has none.
 */
export async function zoneContinuity(
  pkg: Pick<ZonePackage, 'continuity'> | null,
  state: PositionState | null,
  search: Search,
): Promise<ZoneContinuity | null> {
  if (!pkg?.continuity || !state) return null;
  const options = await readWorkContinuities(state.work, state.main);
  const fallback = defaultContinuity(options, pkg.continuity.default);
  return { options, fallback, choice: parseContinuity(search, fallback) };
}
