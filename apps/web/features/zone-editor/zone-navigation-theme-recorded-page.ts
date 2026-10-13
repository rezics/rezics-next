import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext, ZoneMember, ZoneModule } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey, siteMemberTarget, zoneMemberHref } from '../address/path.ts';
import { browserMainApi } from '../api/browser.ts';
import { failedRead, isOfflineError } from '../feed/types.ts';
import { presentationSlide, liveSlides, zoneText } from '../realm/adapt.ts';
import { completePublicNavigation } from '../realm/public-navigation.ts';
import { idOf, siteHref } from '../realm/route.ts';
import { failureOf, type Loaded, type ZonePresentationRead, type ZoneRouteRead } from '../realm/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { savedSiteCuts } from '../zones/site-cuts.ts';
import { zoneTheme, type ZoneTheme } from '../zones/theme.ts';
import { placedModule } from '../zones/presentation.ts';
import type { PlacedModule } from '../zones/zone-home.tsx';
import {
  browserZoneNavigation,
  browserZoneTheme,
  type NavigationSnapshot,
  type ZoneThemeWrite,
} from './api.ts';
import type { EditorState } from './model.ts';
import type { NavigationState } from './navigation.ts';
import {
  initialThemeState,
  reduceThemeEditor,
  type ThemeEditorStart,
  type ThemeEditorState,
  type ZonePresentationBaseline,
} from './theme.ts';

type WebClient = ReturnType<typeof browserMainApi>;
type Answer<T> = {
  data: T | null;
  error: { status: number; value?: unknown } | null;
  headers?: unknown;
  response?: { headers?: unknown };
};

/** The recorded configuration write matches its body. One key is reused for that write. */
export const recordedThemeSaveKey = '7f3c1a2e-6b04-4d5a-9c18-2e6b0a4d5c71';

export interface RecordedPublishedFrame {
  zoneId: string;
  ref: string;
  zone: ZoneContext;
  cuts: ReturnType<typeof savedSiteCuts>;
  theme: ZoneTheme;
  home: ZonePresentationRead['home'];
  hero: PlacedModule | null;
  mounts: readonly ZoneMember[];
  navigationNext: ZonePresentationRead['navigationNext'];
  navigationComplete: ZonePresentationRead['navigationComplete'];
}

/**
 * The public presentation read lives on the request session. This is the same
 * query and the same complete-navigation fold, on a client the caller supplies.
 */
async function settleRealm<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let answer = await call();
    if (answer.error?.status === 409 && !cursor) answer = await call();
    const { data, error } = answer;
    if (error) return failedRead(failureOf(error.status, error.value), error.value,
      answer.headers ?? answer.response?.headers);
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch (error) {
    return { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' };
  }
}

export function zoneIdFromRecordedPath(path: string): string {
  const id = new URL(path, 'https://recorded.invalid').pathname.split('/')
    .find((part, index, parts) => parts[index - 1] === 'zones');
  if (!id) throw new Error(`Recorded path has no zone: ${path}`);
  return id;
}

export function recordedActingSubject(path: string): string {
  const acting = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!acting) throw new Error(`Recorded path has no acting subject: ${path}`);
  return acting;
}

export function recordedRoutePath(path: string): string {
  const route = new URL(path, 'https://recorded.invalid').searchParams.get('path');
  if (!route) throw new Error(`Recorded path has no route path: ${path}`);
  return route;
}

/** The theme page opens a configuration through this, including its shell only while presentation is absent. */
export function themeEditorStart(configuration: unknown, expectedHead: string,
  shell: ZonePresentationBaseline): ThemeEditorStart {
  return initialThemeState(configuration, expectedHead, { revision: expectedHead, presentation: shell });
}

export async function loadThemeEditor(main: WebClient, zoneId: string, actingSubject: string,
  shell: ZonePresentationBaseline) {
  const read = await browserZoneTheme(main, shell).readConfiguration(zoneId, actingSubject);
  if (!read.ok) return { kind: 'failure' as const, failure: read.failure };
  return {
    kind: 'editor' as const,
    revision: read.data.revision,
    configuration: read.data.configuration,
    start: themeEditorStart(read.data.configuration, read.data.revision, shell),
  };
}

export function saveRecordedTheme(main: WebClient, zoneId: string, body: ZoneThemeWrite, key: string) {
  return browserZoneTheme(main).saveConfiguration(zoneId, body, key);
}

/** The refused body stays the editor's baseline. The notice records the stale head. */
export function themeEditorAfterStaleSave(body: ZoneThemeWrite): ThemeEditorState | null {
  const start = initialThemeState({ presentation: body.presentation }, body.expectedHead);
  if (start.kind !== 'ready') return null;
  return reduceThemeEditor(start.state, { type: 'stale' });
}

export function recordedThemeWrite(body: unknown): ZoneThemeWrite {
  if (!isRecord(body) || typeof body.expectedHead !== 'string' || typeof body.actingSubject !== 'string'
    || !isRecord(body.presentation)) {
    throw new Error('Recorded theme save is missing expectedHead, actingSubject or presentation');
  }
  return {
    expectedHead: body.expectedHead,
    actingSubject: body.actingSubject,
    presentation: body.presentation as ZoneThemeWrite['presentation'],
  };
}

/** The navigation page turns one loaded snapshot into the editor's compare-and-set state. */
export function navigationEditorState(snapshot: NavigationSnapshot, home: EditorState): {
  navigation: NavigationState;
  home: EditorState;
} {
  const { links, head, navigation, complete, after, zoneHead } = snapshot;
  return {
    navigation: {
      links,
      saved: links.map(link => ({ ...link })),
      pending: [],
      head,
      navigation,
      complete,
      after,
      notice: { kind: 'idle' },
    },
    home: { ...home, navigationRevision: head, ...(zoneHead ? { zoneHead } : {}) },
  };
}

export function loadZoneNavigationRead(main: WebClient, zoneId: string, actingSubject: string) {
  return browserZoneNavigation(main).readNavigation(zoneId, actingSubject);
}

export function loadCompletePresentation(main: WebClient, zoneId: string, actingSubject?: string) {
  return completePublicNavigation(after => settleRealm(() => main.v1.zones({ id: zoneId }).presentation.get({
    query: { actingSubject, after },
  }), after));
}

export function loadRecordedRoute(main: WebClient, zoneId: string, path: string, actingSubject?: string,
  cursor?: string) {
  return settleRealm(() => main.v1.zones({ id: zoneId }).routes.get({
    query: { actingSubject, path, cursor },
  }), cursor);
}

/** The published frame: the same site cut the public site renders, plus the home document it was given. */
export function publishedFrameModel(answer: ZonePresentationRead, zoneId: string, locale: UiLocale,
  homeName: string, heroTitle: string): RecordedPublishedFrame {
  const address = siteAddress(answer.address);
  const ref = addressKey(address);
  const name = zoneContentText(answer.name ?? address.suffixSource, answer.language ?? '');
  const cuts = savedSiteCuts(
    { tokens: answer.presentation.tokens, navigation: answer.presentation.navigation },
    answer.navigation.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    ref, locale, homeName);
  const zone: ZoneContext = {
    slug: answer.official,
    realm: null,
    name,
    description: null,
    icon: null,
    hero: null,
    tokens: answer.presentation.tokens,
    locale,
    links: {
      home: siteHref(locale, ref, []),
      browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']),
      discussions: '',
      decisions: '',
      about: '',
    },
  };
  return {
    zoneId: idOf(answer.zone) ?? zoneId,
    ref,
    zone,
    cuts,
    theme: zoneTheme(cuts.tokens, { reader: 'light', enabled: true }),
    home: answer.home ?? null,
    hero: highlightHero(answer, { locale, ref, realm: answer.zone }, heroTitle),
    mounts: answer.navigation.map(mount => ({
      id: mount.target,
      href: siteHref(locale, ref, [mount.segment]),
      name: zoneText(mount.name),
      kind: null,
    })),
    navigationNext: answer.navigationNext,
    navigationComplete: answer.navigationComplete,
  };
}

export function recordedIndexMembers(route: Extract<ZoneRouteRead, { kind: 'index' }>, ref: string): ZoneMember[] {
  return route.items.map(item => ({
    id: item.id,
    kind: null,
    name: zoneText('title' in item ? item.title : item.name),
    href: zoneMemberHref(ref, route.mount.segment, siteMemberTarget(item.id,
      'address' in item && isCanonical(item.address) ? item.address : undefined)),
  }));
}

export async function loadPublishedFrame(main: WebClient, zoneId: string, locale: UiLocale, homeName: string,
  heroTitle: string): Promise<Loaded<RecordedPublishedFrame>> {
  const read = await loadCompletePresentation(main, zoneId);
  if (!read.ok) return read;
  return { ok: true, data: publishedFrameModel(read.data, zoneId, locale, homeName, heroTitle) };
}

function highlightHero(answer: ZonePresentationRead, context: { locale: UiLocale; ref: string; realm: string },
  heroTitle: string): PlacedModule | null {
  const slides = liveSlides(answer.presentation.slides, Date.now()).slice(0, 5).flatMap(slide => {
    const adapted = presentationSlide(slide, null, context, answer.slideMedia);
    return adapted ? [adapted] : [];
  });
  if (!slides.length) return null;
  // placedModule returns the wide module union; the literal type keeps the hero data paired with it.
  const module: ZoneModule<'hero-carousel'> = {
    ...placedModule({
      id: slides[0]!.id,
      type: 'hero-carousel',
      title: heroTitle,
      source: { kind: 'query-block', block: 'document-default' },
    }, null),
    type: 'hero-carousel',
  };
  return { module, state: { state: 'ready', data: { slides } } };
}

function siteAddress(address: ZonePresentationRead['address']): CanonicalAddress {
  if (!isCanonical(address)) throw new Error('Recorded presentation has no site address');
  return address;
}

function isCanonical(value: unknown): value is CanonicalAddress {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.suffixSource !== 'string'
    || typeof value.prefix !== 'string') return false;
  return value.prefix === '/z/' || value.prefix.startsWith('/z/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
