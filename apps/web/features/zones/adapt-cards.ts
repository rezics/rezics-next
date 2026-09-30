import type { ZoneHubItem, ZoneWork } from '@rezics/zone-sdk';
import { zoneContentText } from '../language/untagged.ts';
import type { ZoneWorkPage } from '../realm/types.ts';

// Main's public Hub card (`hub-work-card-v1`) as the Zone SDK's. Only the
// new-adoptions and recently-completed reads carry it; other modules take it
// from the Realm's card for the same Work.

type MainCards = Partial<Pick<ZoneWorkPage['items'][number], 'hub'>>;

/**
 * A moment as an ISO string. Eden revives Main's ISO times as `Date`s, which
 * would render as `Date#toString` on the server and not hydrate; the SDK
 * carries ISO strings, as its `updatedAt` fields promise.
 */
export function isoMoment(value: unknown): string | null {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function zoneHub(card: MainCards['hub']): ZoneHubItem | null {
  // Main keys copyable text to one Content language it does not name; the page's language stands.
  return card ? { kind: card.kind === 'skill-package' ? 'skill' : 'prompt',
    preview: zoneContentText(card.preview), copyText: card.copyText,
    testedModels: card.testedModels } : null;
}

/** A Zone Work's Hub card from a Main module read, or none. */
export function zoneWorkCards(card: MainCards): Pick<ZoneWork, 'hub'> {
  return { hub: zoneHub(card.hub) };
}
