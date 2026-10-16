import type { MainClient } from '../manage/types.ts';
import { readZoneManagementFrame, type ZoneManagementFrame } from './authoring-reads.ts';
import { loadCompleteZoneNavigation } from './api.ts';
import { loadSavedPreviewFrame } from './saved-preview-frame.ts';
import { realmFrameReads } from '../realm/zone-presentation-read.ts';
import { installedDigest, loadPackage } from '../../zones/official/index.ts';
import { declaredData } from '../../zones/official/declared.ts';
import { independentZoneHomeBoundary, readIndependentZoneHome } from '../zones/independent-zone-recorded-page.ts';

/** Layout and page share the management address, actor and admitted saved cut. */
export function readRevokedEditor(main: MainClient, space: string, actingSubject: string) {
  return readZoneManagementFrame(main, space, 'en', actingSubject);
}

export function readRevokedPreview(main: MainClient, frame: ZoneManagementFrame, actingSubject: string) {
  const reads = realmFrameReads({ main, personal: main, actingSubject });
  return loadSavedPreviewFrame({ authoring: async () => frame.authoring,
    navigation: saved => loadCompleteZoneNavigation(main, saved.model.zoneId, actingSubject, saved.model.state),
    presentation: reads.readPresentation, realmHeader: reads.readRealmHeader, installedDigest,
    packages: { load: loadPackage, declarations: declaredData },
  }, { locale: 'en', homeName: 'Home', lookEnabled: false });
}

/** Anonymous resolution is shared; the home and edit link use the session's client. */
export async function readRevokedPublic(main: MainClient, personal: MainClient, space: string, actingSubject?: string) {
  const anonymous = realmFrameReads({ main, keepProblem: false });
  let presentation: ReturnType<typeof anonymous.readCompletePresentation> | undefined;
  const publicReads = realmFrameReads({ main, keepProblem: false, resolution: {
    readCompletePresentation: zone => presentation ??= anonymous.readCompletePresentation(zone),
  } });
  const resolved = await publicReads.resolveSite(space, 'en');
  const reads = realmFrameReads({ main, personal, actingSubject, keepProblem: false });
  if (resolved.kind === 'site') await reads.readZoneRoute(resolved.zone, '/');
  return readIndependentZoneHome(independentZoneHomeBoundary({ actingSubject, editorClient: actingSubject ? personal : null,
    production: { resolveSite: async () => resolved, readCompletePresentation: zone => actingSubject
      ? reads.readCompletePresentation(zone) : presentation! },
  }), { space, locale: 'en', actingSubject });
}
