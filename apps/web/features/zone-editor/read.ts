import { cache } from 'react';
import { addressKey, spaceHref } from '../address/path.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { settle } from '../manage/read.ts';
import { isUuid, type MainClient, type ReadFailure } from '../manage/types.ts';
import { resolveSite } from '../realm/read.ts';
import type { ReadFailure as SiteReadFailure } from '../realm/types.ts';
import { authoringModel, type ZoneAuthoringModel } from './model.ts';
import { readZoneLifecycleSnapshot } from './lifecycle.ts';
import { zoneEditorPath, zonePreviewPath } from './routes.ts';

type EditorRead = NonNullable<Awaited<ReturnType<ReturnType<MainClient['v1']['zones']>['showcase-editor']['get']>>['data']>;
export type ZoneAuthoringPreview = EditorRead['preview'];

export type ZoneAuthoringLoad =
  | { kind: 'missing' }
  | { kind: 'failure'; failure: ReadFailure }
  | { kind: 'ready'; model: ZoneAuthoringModel; preview: ZoneAuthoringPreview;
    editorPath: string; previewPath: string; sitePath: string };

export type ZoneLifecycleLoad =
  | { kind: 'missing' }
  | { kind: 'failure'; failure: ReadFailure }
  | { kind: 'ready'; zoneId: string; revision: string; status: 'active' | 'retired'; name: string };

/**
 * The home draft and the two heads a publish names. Shared by the editor and its preview
 * for one request. An editor who cannot read the draft is refused here, never shown the public page.
 */
export const loadZoneAuthoring = cache(async (
  main: MainClient, space: string, locale: UiLocale, actingSubject: string,
): Promise<ZoneAuthoringLoad> => {
  const site = await resolveSite(space, locale);
  if (site.kind === 'missing' || site.kind === 'join') return { kind: 'missing' };
  if (site.kind !== 'site') return { kind: 'failure', failure: authoringReadFailure(site.failure) };
  const [editor, zone] = await Promise.all([
    settle(() => main.v1.zones({ id: site.zone })['showcase-editor'].get({ query: { actingSubject } }), { management: true }),
    settle(() => main.v1.zones({ id: site.zone }).get({ query: { actingSubject } }), { management: true }),
  ]);
  if (!editor.ok) return { kind: 'failure', failure: editor.failure };
  if (!zone.ok) return { kind: 'failure', failure: zone.failure };
  const suffix = site.address.canonical.suffixSource?.trim();
  const model = authoringModel(editor.data, zone.data, site.zone, suffix || addressKey(site.address.canonical) || space);
  if (!model) return { kind: 'failure', failure: 'unavailable' };
  return {
    kind: 'ready', model, preview: editor.data.preview,
    editorPath: zoneEditorPath(space),
    previewPath: zonePreviewPath(space),
    sitePath: spaceHref(site.address.canonical, 'site'),
  };
});

/**
 * Authorized lifecycle entry. A retired site's public Space resolver no longer
 * yields its Zone capability, so the stable Zone UUID is also a management key.
 */
export const loadZoneLifecycle = cache(async (
  main: MainClient, space: string, locale: UiLocale, actingSubject: string,
): Promise<ZoneLifecycleLoad> => {
  let zoneId: string;
  if (isUuid(space)) zoneId = space;
  else {
    const site = await resolveSite(space, locale);
    if (site.kind === 'missing' || site.kind === 'join') return { kind: 'missing' };
    if (site.kind !== 'site') return { kind: 'failure', failure: authoringReadFailure(site.failure) };
    zoneId = site.zone;
  }

  const loaded = await settle(() => main.v1.zones({ id: zoneId }).configuration.get({ query: { actingSubject } }),
    { management: true });
  if (!loaded.ok) return { kind: 'failure', failure: loaded.failure };
  const row = loaded.data as { revision?: unknown; configuration?: unknown; name?: unknown };
  const snapshot = readZoneLifecycleSnapshot(row.revision, row.configuration);
  if (!snapshot) return { kind: 'failure', failure: 'unavailable' };
  return { kind: 'ready', zoneId, revision: snapshot.revision, status: snapshot.status,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : space };
});

/** Address resolution uses the public reader's failures. A closed or offline lookup is the same unreachable page here. */
function authoringReadFailure(failure: SiteReadFailure | undefined): ReadFailure {
  if (failure === 'missing' || failure === 'moved' || failure === 'invalid' || failure === 'budget') return failure;
  return 'unavailable';
}
