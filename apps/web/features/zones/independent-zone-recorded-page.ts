import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext } from '@rezics/zone-sdk';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey } from '../address/path.ts';
import type { MainClient } from '../discover/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { siteHref } from '../realm/route.ts';
import { realmFrameReads, type SiteResolution } from '../realm/read.ts';
import type { ReadFailure, ZonePresentationRead } from '../realm/types.ts';
import type { RealmFrameRead } from '../realm/zone-presentation-read.ts';
import { zonePresentationReads } from '../realm/zone-presentation-read.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import {
  readShowcaseEditor,
  showcaseEditorAuthority,
  type ShowcaseEditorAuthority,
} from '../zone-editor/edit-site-link.tsx';
import { mapZoneSiteHome, type ZoneSiteCredit, type ZoneSiteMapped } from './zone-site-recorded-page.ts';

/**
 * Published home of a Zone with no Realm. Production and a recorded story call
 * this with their own clients: the request-cached host readers, or the replaying client.
 * An empty path does not read a route. A presentation that names a Realm is a different page.
 */

export interface IndependentZoneHomeBoundary {
  resolveSite: (space: string, locale: UiLocale) => Promise<SiteResolution>;
  readCompletePresentation: (zone: string) => Promise<RealmFrameRead<ZonePresentationRead>>;
  editorOpen: ((zoneId: string, actingSubject: string) => Promise<ShowcaseEditorAuthority>) | null;
}

export function independentZoneHomeBoundary(input: {
  main?: MainClient;
  personal?: MainClient;
  actingSubject?: string;
  /** Host readers. Present only in production, where address resolution keeps its cache and headers. */
  production?: {
    resolveSite: IndependentZoneHomeBoundary['resolveSite'];
    readCompletePresentation: IndependentZoneHomeBoundary['readCompletePresentation'];
  };
  editorOpen?: IndependentZoneHomeBoundary['editorOpen'];
  /** Replaying editor client. Production passes `editorOpen` so the session cache stays the one the link uses. */
  editorClient?: MainClient | null;
}): IndependentZoneHomeBoundary {
  const actingSubject = input.actingSubject;
  const editorOpen = input.editorOpen ?? (actingSubject && input.editorClient
    ? async (zoneId: string, subject: string) => showcaseEditorAuthority(await readShowcaseEditor(input.editorClient!, zoneId, subject))
    : null);
  if (input.production) return { ...input.production, editorOpen };
  if (!input.main) throw new Error('independent zone home needs a supplied client');
  const personal = input.personal ?? input.main;
  const pages = zonePresentationReads(personal, actingSubject, false);
  const pending = new Map<string, Promise<RealmFrameRead<ZonePresentationRead>>>();
  const readCompletePresentation = (zone: string) => {
    const existing = pending.get(zone);
    if (existing) return existing;
    const read = pages.readCompletePresentation(zone);
    pending.set(zone, read);
    return read;
  };
  const reads = realmFrameReads({
    main: input.main,
    personal,
    actingSubject,
    keepProblem: false,
    resolution: { readCompletePresentation },
  });
  return {
    resolveSite: (space, locale) => reads.resolveSite(space, locale),
    readCompletePresentation,
    editorOpen,
  };
}

/** The space key and acting person on the selected visit, taken from its request URLs. */
export function independentZoneVisit(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[]): {
  space: string;
  actingSubject?: string;
} {
  const samples = selections.map(selection => {
    const found = record.personas[persona].filter(sample => sample.label === selection.label);
    if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${selection.label}`);
    return found[0]!;
  });
  const address = samples.find(sample => new URL(sample.path, 'https://recorded.invalid').pathname === '/v1/addresses/resolve');
  if (!address) throw new Error(`${record.row}/${persona} visit has no address request`);
  const addressUrl = new URL(address.path, 'https://recorded.invalid');
  const space = addressUrl.searchParams.get('key');
  if (addressUrl.searchParams.get('scope') !== 'space' || !space) {
    throw new Error(`${record.row}/${persona} address request is not a space key`);
  }
  const subjects = new Set(samples.flatMap(sample => {
    const acting = new URL(sample.path, 'https://recorded.invalid').searchParams.get('actingSubject');
    return acting ? [acting] : [];
  }));
  if (subjects.size > 1) throw new Error(`${record.row}/${persona} visit names two acting subjects`);
  const actingSubject = [...subjects][0];
  return actingSubject ? { space, actingSubject } : { space };
}

/** Realm stays null: this path is only the Zone, using the address the visit resolved. */
export function independentZoneContext(
  presentation: ZonePresentationRead,
  canonical: CanonicalAddress,
  locale: UiLocale,
): { zone: ZoneContext; ref: string } {
  const ref = addressKey(canonical);
  return {
    ref,
    zone: {
      slug: presentation.official,
      realm: null,
      name: zoneContentText(presentation.name ?? canonical.suffixSource, presentation.language),
      description: null,
      icon: null,
      hero: null,
      tokens: presentation.presentation.tokens,
      locale,
      links: {
        home: siteHref(locale, ref, []),
        browse: siteHref(locale, ref, ['browse']),
        works: siteHref(locale, ref, ['browse']),
        discussions: '',
        decisions: '',
        about: '',
      },
    },
  };
}

export type IndependentZoneRead =
  | {
      kind: 'published';
      mapped: Extract<ZoneSiteMapped, { kind: 'published' }>;
      presentation: ZonePresentationRead;
      zone: ZoneContext;
      ref: string;
      zoneId: string;
      credit: ZoneSiteCredit | null;
      editor: ShowcaseEditorAuthority | null;
    }
  | {
      kind: 'empty';
      mapped: Extract<ZoneSiteMapped, { kind: 'empty' }>;
      presentation: ZonePresentationRead;
      zone: ZoneContext;
      ref: string;
      zoneId: string;
      editor: ShowcaseEditorAuthority | null;
    }
  | { kind: 'unavailable'; failure: ReadFailure; reference?: string }
  | { kind: 'discrepancy'; detail: string };

/** Address, one complete presentation, and the editor link when an acting person is selected. No route read. */
export async function readIndependentZoneHome(boundary: IndependentZoneHomeBoundary, input: {
  space: string;
  locale: UiLocale;
  actingSubject?: string;
}): Promise<IndependentZoneRead> {
  const site = await boundary.resolveSite(input.space, input.locale);
  if (site.kind === 'missing' || site.kind === 'join') return { kind: 'discrepancy', detail: `site resolution is ${site.kind}` };
  if (site.kind === 'unavailable') {
    return { kind: 'unavailable', failure: site.failure ?? 'unavailable', ...(site.reference ? { reference: site.reference } : {}) };
  }
  if (site.realm) return { kind: 'discrepancy', detail: 'presentation realm is not null' };
  const presentation = await boundary.readCompletePresentation(site.zone);
  if (!presentation.ok) {
    return { kind: 'unavailable', failure: presentation.failure, ...(presentation.reference ? { reference: presentation.reference } : {}) };
  }
  if (presentation.data.realm) return { kind: 'discrepancy', detail: 'presentation realm is not null' };
  const mapped = mapZoneSiteHome(presentation.data);
  if (mapped.kind === 'empty' && presentation.data.home) {
    return { kind: 'discrepancy', detail: 'presentation home is present but not a document the page can show' };
  }
  const { zone, ref } = independentZoneContext(presentation.data, site.address.canonical, input.locale);
  const editor = input.actingSubject && boundary.editorOpen
    ? await boundary.editorOpen(site.zone, input.actingSubject)
    : null;
  if (mapped.kind === 'empty') {
    return { kind: 'empty', mapped, presentation: presentation.data, zone, ref, zoneId: site.zone, editor };
  }
  return {
    kind: 'published',
    mapped,
    presentation: presentation.data,
    zone,
    ref,
    zoneId: site.zone,
    credit: mapped.credit,
    editor,
  };
}
