import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { zoneContentText } from '../language/untagged.ts';
import type { Loaded } from '../manage/types.ts';
import { mainExecution, zoneImage, zoneText, type AdaptContext } from '../realm/adapt.ts';
import { idOf, realmHref, siteHref } from '../realm/route.ts';
import type { RealmHeader, ZonePresentationRead } from '../realm/types.ts';
import { decideExecution, type Execution } from '../zones/execution.ts';
import { resolvePackage, type PackageSource } from '../zones/package-source.ts';
import { savedSiteCuts } from '../zones/site-cuts.ts';
import type { NavigationSnapshot } from './api.ts';
import type { ZoneAuthoringLoad } from './read.ts';

type SavedAuthoring = Extract<ZoneAuthoringLoad, { kind: 'ready' }>;
type OptionalRead<T> = Promise<{ ok: true; data: T } | { ok: false }>;

export interface SavedPreviewReaders {
  authoring(): Promise<ZoneAuthoringLoad>;
  navigation(saved: SavedAuthoring): Promise<Loaded<NavigationSnapshot>>;
  /** Public reads can enrich the frame, but cannot replace its saved selection or refuse it. */
  presentation(zone: string): OptionalRead<ZonePresentationRead>;
  realmHeader(realm: string): OptionalRead<RealmHeader>;
  installedDigest(slug: string): Promise<string | null>;
  packages: PackageSource;
}

export interface SavedPreviewFrame {
  saved: SavedAuthoring;
  /** The Realm header's bound Space; a Zone attachment alone cannot supply this route capability. */
  realmRef: string | null;
  zone: ZoneContext;
  context: AdaptContext;
  cuts: ReturnType<typeof savedSiteCuts>;
  execution: Execution;
  pkg: ZonePackage | null;
}

export type SavedPreviewFrameLoad =
  | Exclude<ZoneAuthoringLoad, { kind: 'ready' }>
  | { kind: 'ready'; frame: SavedPreviewFrame };

async function optional<T>(read: () => OptionalRead<T>): Promise<T | null> {
  try {
    const result = await read();
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

/** The saved authoring and navigation reads are the only required reads, in either Realm mode. */
export async function loadSavedPreviewFrame(read: SavedPreviewReaders, {
  locale, homeName, lookEnabled,
}: { locale: UiLocale; homeName: string; lookEnabled: boolean }): Promise<SavedPreviewFrameLoad> {
  const saved = await read.authoring();
  if (saved.kind !== 'ready') return saved;
  const navigation = await read.navigation(saved);
  if (!navigation.ok) return { kind: 'failure', failure: navigation.failure };

  const selectedTheme = saved.preview.presentation.official?.theme;
  const realm = saved.realm ? idOf(saved.realm) : null;
  const [publicPresentation, header] = await Promise.all([
    selectedTheme ? optional(() => read.presentation(saved.model.zoneId)) : null,
    realm ? optional(() => read.realmHeader(realm)) : null,
  ]);
  const boundHeader = header?.id === saved.realm ? header : null;
  const realmRef = boundHeader ? idOf(boundHeader.space) : null;
  // Approval for a previously published package cannot approve a different saved theme.
  const report = publicPresentation?.zone === saved.model.zoneIri
    && publicPresentation.presentation.official?.theme === selectedTheme ? publicPresentation : null;
  const main = report ? mainExecution(report) : null;
  const slug = report?.official ?? null;
  let installedDigest: string | null = null;
  if (main?.approved && slug) {
    try { installedDigest = await read.installedDigest(slug); } catch { /* The saved fallback remains available. */ }
  }
  const approval = { main, slug, installedDigest };
  const { execution, pkg } = await resolvePackage({
    decided: decideExecution({ ...approval, safeMode: false, lookEnabled }), approval,
    surface: 'site', source: read.packages,
  });
  const { ref, name } = saved.frameMetadata;
  const cuts = savedSiteCuts(saved.preview.presentation,
    navigation.data.links.filter(mount => mount.disclosure === 'public')
      .map(mount => ({ segment: mount.segment, name: zoneContentText(mount.name) })),
    ref, locale, homeName);
  const zone: ZoneContext = {
    slug, realm: saved.realm, name,
    description: boundHeader ? zoneText(boundHeader.description) : null,
    icon: boundHeader ? zoneImage(boundHeader.icon) : null,
    hero: boundHeader ? zoneImage(boundHeader.banner) : null,
    tokens: cuts.tokens, locale,
    links: { home: siteHref(locale, ref, []), browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']),
      discussions: realmRef ? realmHref(locale, realmRef, 'discussions') : '',
      decisions: realmRef ? realmHref(locale, realmRef, 'decisions') : '',
      about: realmRef ? realmHref(locale, realmRef, 'about') : '' },
  };
  return { kind: 'ready', frame: { saved, realmRef, zone, cuts, execution, pkg,
    context: { locale, ref, realm: realm ?? saved.model.zoneId, zone: saved.model.zoneId,
      mounts: new Map(navigation.data.links.map(mount => [mount.target, mount.segment])) } } };
}
