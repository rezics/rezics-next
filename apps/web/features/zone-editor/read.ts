import { cache } from 'react';
import { addressKey, spaceHref } from '../address/path.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { settle } from '../manage/read.ts';
import type { MainClient, ReadFailure } from '../manage/types.ts';
import { resolveSite } from '../realm/read.ts';
import type { ReadFailure as SiteReadFailure } from '../realm/types.ts';
import { authoringModel, type ZoneAuthoringModel } from './model.ts';
import { zoneEditorPath, zonePreviewPath } from './routes.ts';

export type ZoneAuthoringLoad =
  | { kind: 'missing' }
  | { kind: 'failure'; failure: ReadFailure }
  | { kind: 'ready'; model: ZoneAuthoringModel; editorPath: string; previewPath: string; sitePath: string };

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
    kind: 'ready', model,
    editorPath: zoneEditorPath(space),
    previewPath: zonePreviewPath(space),
    sitePath: spaceHref(site.address.canonical, 'site'),
  };
});

/** Address resolution uses the public reader's failures. A closed or offline lookup is the same unreachable page here. */
function authoringReadFailure(failure: SiteReadFailure | undefined): ReadFailure {
  if (failure === 'missing' || failure === 'moved' || failure === 'invalid' || failure === 'budget') return failure;
  return 'unavailable';
}
