import { createElement } from 'react';
import { BFF_PREFIX } from '../api/browser.ts';
import { readSpacePage } from '../address/space-read.ts';
import { realmFrameReads } from '../realm/zone-presentation-read.ts';
import { independentZoneHomeBoundary, readIndependentZoneHome } from '../zones/independent-zone-recorded-page.ts';
import { notFound } from 'next/navigation';
import { ZoneLifecycleEditor } from './lifecycle-editor.tsx';
import { ZoneAuthoringFailure } from './states.tsx';
import { messages } from './messages.ts';
import type { ZoneLifecycleClient } from './api.ts';
import type { ZoneLifecycleLoad } from './authoring-reads.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../manage/types.ts';
import { readZoneManagementFrame, readZoneRecoveryReturnAddress } from './authoring-reads.ts';
import { loadCompleteZoneNavigation } from './api.ts';
import { loadSavedPreviewFrame } from './saved-preview-frame.ts';

/** The layout and lifecycle page share one admitted address and its saved reads. */
export async function readLifecyclePage(main: MainClient, space: string, locale: UiLocale, actingSubject: string) {
  const frame = await readZoneManagementFrame(main, space, locale, actingSubject);
  const loaded = frame.lifecycle;
  const returnAddress = loaded.kind === 'ready'
    ? await readZoneRecoveryReturnAddress(main, loaded.returnAddress, loaded, actingSubject) : undefined;
  return { frame, loaded, returnAddress };
}

/** These saved fixtures select no package or Realm; unexpected enrichment is an evidence gap. */
export function readLifecyclePreview(main: MainClient, frame: Awaited<ReturnType<typeof readLifecyclePage>>['frame'],
  locale: UiLocale, actingSubject: string) {
  const unexpected = async () => { throw new Error('Unrecorded preview enrichment'); };
  return loadSavedPreviewFrame({ authoring: async () => frame.authoring,
    navigation: saved => loadCompleteZoneNavigation(main, saved.model.zoneId, actingSubject, saved.model.state),
    presentation: unexpected, realmHeader: unexpected, installedDigest: unexpected,
    packages: { load: unexpected, declarations: unexpected },
  }, { locale, homeName: 'Home', lookEnabled: true });
}

/** The installed lifecycle route and replay render the same admitted page. */
export function zoneLifecycleBody(loaded: ZoneLifecycleLoad, input: {
  locale: UiLocale; actingSubject: string; signInHref: string; returnAddress?: string;
  api?: ZoneLifecycleClient; onCompleted?: () => void;
}) {
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return createElement(ZoneAuthoringFailure, { failure: loaded.failure, copy: messages[input.locale] });
  return createElement(ZoneLifecycleEditor, { ...input, copy: messages[input.locale], zoneId: loaded.zoneId,
    initial: { revision: loaded.revision, status: loaded.status } });
}


/** Public admission keeps anonymous presentation and address reads, plus the session's private fallback. */
export function readLifecyclePublic(main: MainClient, personal: MainClient, fetcher: typeof fetch,
  space: string, actingSubject?: string) {
  const presentations = new Map<string, ReturnType<ReturnType<typeof realmFrameReads>['readCompletePresentation']>>();
  const publicReads = realmFrameReads({ main });
  const readCompletePresentation = (zone: string) => {
    if (!presentations.has(zone)) presentations.set(zone, publicReads.readCompletePresentation(zone));
    return presentations.get(zone)!;
  };
  const reads = realmFrameReads({ main, personal, actingSubject, resolution: { readCompletePresentation,
    readPrivateRealm: (ref, _locale, address) => readSpacePage(ref, 'en', { address, actingSubject,
      read: path => fetcher(`https://record.invalid${BFF_PREFIX}${path}`, {
        headers: { 'accept-language': 'en', 'x-rezics-display-languages': 'en' },
      }),
    }),
  } });
  return readIndependentZoneHome(independentZoneHomeBoundary({ personal, actingSubject, editorClient: actingSubject ? personal : null,
    production: { resolveSite: reads.resolveSite, readCompletePresentation } }), { space, locale: 'en', actingSubject });
}
