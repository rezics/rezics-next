import type { ZoneShowcaseArt, ZoneShowcaseImage, ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { readWorkShowcase } from '../api/showcase.ts';
import { mainApi, mainApiWithToken } from '../api/main.ts';
import { workShowcaseArt, zoneWork } from '../realm/adapt.ts';
import type { MainClient } from '../manage/types.ts';
import { registryOf } from './art.ts';
import { MAX_SLIDES, readStoredPresentation, type StoredPresentation } from './slides.ts';

// The reads behind the showcase editor, for the page and for the actions that refresh it. Each
// answers with data instead of throwing, so a Work or the Zone being unavailable shows in words.

const iri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Main's media path through the BFF, which sends the session's token; Main then needs the Agent the editor acts as. */
function asAgent(url: string, actingSubject: string) {
  const path = new URL(url, 'https://rezics.invalid');
  path.searchParams.set('actingSubject', actingSubject);
  return `${path.pathname}${path.search}`;
}

/** Art whose every image is fetched as the acting Agent, as the editor's own previews are. */
export function artAsAgent(art: ZoneShowcaseArt, actingSubject: string): ZoneShowcaseArt {
  const image = <Image extends ZoneShowcaseImage>(item: Image): Image => ({ ...item, url: asAgent(item.url, actingSubject),
    ...item.candidates ? { candidates: item.candidates.map(candidate => ({ ...candidate, url: asAgent(candidate.url, actingSubject) })) } : {} });
  return { ...art, landscape: art.landscape && image(art.landscape), portrait: art.portrait && image(art.portrait),
    cutout: art.cutout && image(art.cutout), logos: art.logos?.map(image) };
}

/**
 * The Works the slides name, as the stage draws them: the card with the Work's own showcase art,
 * read as a reader of the Zone's Realm would. A Work Main cannot show readers is null, and the
 * stage drops its slide, as the Zone's home does.
 */
export async function loadSlideWorks(input: { realm: string; locale: UiLocale; works: readonly string[]; actingSubject?: string }):
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
  const context = { locale: input.locale, ref: realm, realm, unrouted: true,
    avatarQuery: input.actingSubject ? `?actingSubject=${encodeURIComponent(input.actingSubject)}` : '' };
  return Object.fromEntries(targets.map((target, index) => {
    const header = headers[index];
    if (!header) return [target, null];
    const own = art.get(target);
    return [target, { ...zoneWork(header, context, null), ...own ? { showcaseArt: input.actingSubject ? artAsAgent(workShowcaseArt(own), input.actingSubject) : workShowcaseArt(own) } : {} }];
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

/** The complete saved slides, authorized by current Zone edit authority. */
export async function readZoneShowcase(main: MainClient, zone: string, actingSubject: string): Promise<ZoneShowcaseRead> {
  try {
    const { data, error } = await main.v1.zones({ id: zone.slice(-36) })['showcase-editor'].get({ query: { actingSubject } });
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

/** Campaign previews use the same editor-scoped read as the saved slides. */
export async function readCampaignRegistry(zone: string, actingSubject: string | null = null) {
  try {
    if (!actingSubject) return {};
    const { data, error } = await (await mainApi()).v1.zones({ id: zone.slice(-36) })['showcase-editor'].get({ query: { actingSubject } });
    return data && !error ? registryOf(data.slideMedia, actingSubject) : {};
  } catch {
    return {};
  }
}
