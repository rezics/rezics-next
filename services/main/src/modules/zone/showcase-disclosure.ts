import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readResourceSummaries, type SummaryReader } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { readZonePublication } from './publication.ts';
import { ZoneUnavailable } from './configuration.ts';
import { zoneCampaignUses, type ZoneSlide } from './presentation-format.ts';

export const ZONE_SHOWCASE_DISCLOSURE_COST = { maxSlides: 6, maxTargets: 7,
  configurationReads: 1, targetBatches: 1 } as const;

export function slideIsCurrent(slide: ZoneSlide, now = Date.now()): boolean {
  return (!slide.startsAt || Date.parse(slide.startsAt) <= now)
    && (!slide.endsAt || now < Date.parse(slide.endsAt));
}

/** Exact originating Zone head plus one bounded target batch; never scan Zones
 * by Realm or media inventory. The immutable creation event supplies the Zone. */
export async function currentZoneCampaignUses(env: WorkActivationEnvironment,
  zone: string | null | undefined, reader: SummaryReader, realm: string): Promise<ReadonlySet<string>> {
  if (!zone || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(zone)) return new Set();
  let state;
  try { state = await readZonePublication(env, zone); }
  catch (error) { if (error instanceof ZoneUnavailable) return new Set(); throw error; }
  if (state.disclosure !== 'public' || state.realm !== realm) return new Set();
  const slides = state.presentation.slides.filter(slide => slideIsCurrent(slide));
  const works = [...new Set(slides.flatMap(slide => 'work' in slide ? [slide.work] : []))];
  const summaries = await readResourceSummaries(env, undefined, reader, {
    resources: [zone, ...works], context: DEFAULT_MEDIA_CONTEXT, language: null, channel: 'media',
  });
  if (summaries.summaries[0]?.status !== 'available') return new Set();
  const readable = new Set(summaries.summaries.flatMap(summary =>
    summary.status === 'available' && summary.type === 'work' ? [summary.reference] : []));
  return new Set(zoneCampaignUses(slides.filter(slide => !('work' in slide) || readable.has(slide.work))));
}
