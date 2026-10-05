import type { ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { readWorkShowcase } from '../api/showcase.ts';
import { mainApiWithToken } from '../api/main.ts';
import { workShowcaseArt, zoneWork } from '../realm/adapt.ts';
import type { MainClient } from '../manage/types.ts';
import { registryOf } from './art.ts';
import { MAX_SLIDES, readStoredPresentation, type StoredPresentation } from './slides.ts';

// The reads behind the showcase editor, for the page and for the actions that refresh it. Each
// answers with data instead of throwing, so a Work or the Zone being unavailable shows in words.

const iri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/**
 * The Works the slides name, as the stage draws them: the card with the Work's own showcase art,
 * read as a reader of the Zone's Realm would. A Work Main cannot show readers is null, and the
 * stage drops its slide, as the Zone's home does.
 */
export async function loadSlideWorks(input: { realm: string; locale: UiLocale; works: readonly string[]; avatarQuery?: string }):
  Promise<Record<string, ZoneWork | null>> {
  const targets = [...new Set(input.works)].filter(work => iri.test(work)).slice(0, MAX_SLIDES);
  if (!targets.length) return {};
  const realm = input.realm.slice(-36);
  const main = mainApiWithToken(undefined);
  const [headers, art] = await Promise.all([
    Promise.all(targets.map(async target => {
      try {
        const { data, error } = await main.v1.works({ id: target.slice(-36) }).get({ query: {} });
        return data && !error ? data : null;
      } catch { return null; }
    })),
    readWorkShowcase(targets, `https://rezics.com/id/${realm}`),
  ]);
  const context = { locale: input.locale, ref: realm, realm, unrouted: true, avatarQuery: input.avatarQuery ?? '' };
  return Object.fromEntries(targets.map((target, index) => {
    const header = headers[index];
    if (!header) return [target, null];
    const own = art.get(target);
    return [target, { ...zoneWork(header, context, null), ...own ? { showcaseArt: workShowcaseArt(own) } : {} }];
  }));
}

/** What the editor needs of a Zone's current configuration. */
export interface ZoneShowcaseState {
  zone: string;
  /** The Zone revision a save must name: Main refuses the save if the Zone has moved since. */
  revision: string;
  /** The Realm campaign art belongs to; null for a Zone with no default Realm. */
  realm: string | null;
  presentation: StoredPresentation;
}

export type ZoneShowcaseRead =
  | { ok: true; state: ZoneShowcaseState }
  | { ok: false; failure: 'sign-in' | 'denied' | 'missing' | 'unavailable' };

/** The Zone's configuration as the acting Agent reads it (`GET /v1/zones/{id}/configuration`). */
export async function readZoneShowcase(main: MainClient, zone: string, actingSubject: string): Promise<ZoneShowcaseRead> {
  try {
    const { data, error } = await main.v1.zones({ id: zone.slice(-36) }).configuration.get({ query: { actingSubject } });
    if (error || !data) {
      const status = error?.status;
      return { ok: false, failure: status === 401 ? 'sign-in' : status === 403 ? 'denied' : status === 404 ? 'missing' : 'unavailable' };
    }
    const configuration = data.configuration as { defaultRealm?: unknown } | null;
    const realm = typeof configuration?.defaultRealm === 'string' && iri.test(configuration.defaultRealm) ? configuration.defaultRealm : null;
    return { ok: true, state: { zone: data.zone, revision: data.revision, realm, presentation: readStoredPresentation(data.configuration) } };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/** The campaign images Main delivers for a Zone's slides, by Use (`GET /v1/zones/{id}/presentation`, a public read). */
export async function readCampaignRegistry(zone: string) {
  try {
    const { data, error } = await mainApiWithToken(undefined).v1.zones({ id: zone.slice(-36) }).presentation.get({ query: {} });
    return data && !error ? registryOf(data.slideMedia) : {};
  } catch {
    return {};
  }
}
