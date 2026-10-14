import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneMember } from '@rezics/zone-sdk';
import { siteMemberTarget, zoneMemberHref } from '../address/path.ts';
import { browserMainApi } from '../api/browser.ts';
import { zoneText } from '../realm/adapt.ts';
import type { PublishedFrameModel } from '../realm/zone-presentation-read.ts';
export type RecordedPublishedFrame = PublishedFrameModel;
import type { ZoneRouteRead } from '../realm/types.ts';
import {
  browserZoneAuthoring,
  browserZoneNavigation,
  browserZoneTheme,
  loadZoneNavigation,
  type NavigationSnapshot,
  type ZoneNavigationClient,
  type ZoneThemeWrite,
} from './api.ts';
import type { EditorState, LoadedDraft } from './model.ts';
import type { NavigationState } from './navigation.ts';
import {
  initialThemeState,
  reduceThemeEditor,
  type ThemeEditorStart,
  type ThemeEditorState,
  type ZonePresentationBaseline,
} from './theme.ts';

type WebClient = ReturnType<typeof browserMainApi>;

/** The recorded configuration write matches its body. One key is reused for that write. */
export const recordedThemeSaveKey = '7f3c1a2e-6b04-4d5a-9c18-2e6b0a4d5c71';

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

/** The authorized home draft, before the navigation read replaces its two heads. */
function homeFromAuthorizedDraft(draft: LoadedDraft): EditorState {
  return {
    homeDocument: draft.homeDocument,
    value: draft.value,
    savedValue: draft.basis ? draft.value : null,
    expectedHead: draft.expectedHead,
    basis: draft.basis,
    zoneHead: draft.zoneHead,
    navigationRevision: draft.navigationRevision,
    publishedRevisionId: draft.publishedRevisionId,
    variantId: draft.variantId,
    language: draft.language,
    direction: draft.direction,
    ...(draft.embeds ? { embeds: draft.embeds } : {}),
    notice: { kind: 'idle' },
  };
}

/**
 * Navigation editor for one Zone. The browser authoring adapter reads the home
 * draft; `loadZoneNavigation` reads the paged mounts and their page names. Both
 * use the caller’s client, and the manage route’s mapping folds the snapshot.
 */
export async function loadNavigationEditor(main: WebClient, zoneId: string, actingSubject: string): Promise<
  | { kind: 'editor'; navigation: NavigationState; home: EditorState; client: ZoneNavigationClient }
  | { kind: 'failure'; failure: string }
> {
  const [draft, navigation] = await Promise.all([
    browserZoneAuthoring(main).readDraft(zoneId, actingSubject),
    loadZoneNavigation(main, zoneId, actingSubject),
  ]);
  if (!navigation.ok) return { kind: 'failure', failure: navigation.failure };
  if (!draft.ok) return { kind: 'failure', failure: draft.failure };
  return {
    kind: 'editor',
    ...navigationEditorState(navigation.data, homeFromAuthorizedDraft(draft.data)),
    client: browserZoneNavigation(main),
  };
}

export function recordedIndexMembers(route: Extract<ZoneRouteRead, { kind: 'index' }>, ref: string): ZoneMember[] {
  return route.items.map(item => ({
    id: item.id,
    kind: null,
    name: zoneText('title' in item ? item.title : item.name),
    href: zoneMemberHref(ref, route.mount.segment, siteMemberTarget(item.id,
      'address' in item ? item.address as CanonicalAddress : undefined)),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
