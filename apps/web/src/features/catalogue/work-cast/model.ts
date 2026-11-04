import type { Item, OverviewValue } from '../../pages/overview';

export const WORK_VOICE_PROPERTY = 'wdt:P725';
const CHARACTER_QUALIFIER = 'wdt:P453';

export type CastPerformance = {
  performer: Item;
  character: NonNullable<NonNullable<Item['qualified']>[number]['subject']>;
};

export type CastWindow = {
  groups: { character: CastPerformance['character']; performances: CastPerformance[] }[];
  unpaired: Item[];
};

/** The native release admission is for this exact forward property and current work Type. */
export function workCastAdmitted(value: OverviewValue): boolean {
  return (
    value.relationDirections?.some(
      (entry) => entry.property === WORK_VOICE_PROPERTY && entry.direction === 'forward' && entry.state === 'admitted',
    ) === true
  );
}

/** Group only the currently returned voice-credit rows and their disclosed P453 summaries. */
export function castWindow(items: readonly Item[]): CastWindow {
  const groups = new Map<string, { character: CastPerformance['character']; performances: CastPerformance[] }>();
  const unpaired: Item[] = [];

  for (const performer of items) {
    const characterNotes = (performer.qualified ?? []).filter((note) => note.property === CHARACTER_QUALIFIER);
    const disclosed = new Map<string, CastPerformance['character']>();
    for (const note of characterNotes) {
      const target = note.subject;
      if (target?.id && target.label.trim()) disclosed.set(target.id, target);
    }
    if (performer.gated || !performer.statement || disclosed.size === 0) {
      unpaired.push(performer);
      continue;
    }
    for (const target of disclosed.values()) {
      const group = groups.get(target.id) ?? { character: target, performances: [] };
      group.performances.push({ performer, character: target });
      groups.set(target.id, group);
    }
  }

  return { groups: [...groups.values()], unpaired };
}
