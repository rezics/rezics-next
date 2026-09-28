import type { ZoneHubItem, ZoneModRelease, ZoneWork } from '@rezics/zone-sdk';
import type { ZoneWorkPage } from '../realm/types.ts';

// Main's public mod and Hub cards (`mod-work-card-v2`, `hub-work-card-v1`) as
// the Zone SDK's. Only the new-adoptions and recently-completed reads carry
// them; other modules take them from the Realm's card for the same Work.

type MainCards = Partial<Pick<ZoneWorkPage['items'][number], 'mod' | 'hub'>>;

/**
 * A moment as an ISO string. Eden revives Main's ISO times as `Date`s, which
 * would render as `Date#toString` on the server and not hydrate; the SDK
 * carries ISO strings, as its `updatedAt` fields promise.
 */
export function isoMoment(value: unknown): string | null {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function zoneMod(card: MainCards['mod']): ZoneModRelease | null {
  return card ? { game: card.game, gameVersions: card.gameVersions, loaders: card.loaders,
    environment: card.environment, version: card.latestRelease, updatedAt: isoMoment(card.updatedAt),
    ...card.selected ? { selected: { ...card.selected, publishedAt: isoMoment(card.selected.publishedAt) ??
      card.selected.publishedAt } } : {} } : null;
}

function zoneHub(card: MainCards['hub']): ZoneHubItem | null {
  // Main keys copyable text to one Content language it does not name; the page's language stands.
  return card ? { kind: card.kind === 'skill-package' ? 'skill' : 'prompt',
    preview: { value: card.preview, lang: '', dir: 'ltr' }, copyText: card.copyText,
    testedModels: card.testedModels } : null;
}

/** A Zone Work's mod and Hub cards from a Main module read, or none. */
export function zoneWorkCards(card: MainCards): Pick<ZoneWork, 'mod' | 'hub'> {
  return { mod: zoneMod(card.mod), hub: zoneHub(card.hub) };
}
