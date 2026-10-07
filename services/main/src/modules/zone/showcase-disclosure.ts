import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readResourceSummaries, type SummaryReader } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { assertZoneHomeContentCurrent, readZonePublication, readZonePublishedHomeContent } from './publication.ts';
import { ZoneUnavailable } from './configuration.ts';
import { zoneCampaignUses, type ZoneSlide } from './presentation-format.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { zoneDocumentShowcase } from '../presentation/zone-document.ts';
import { readerLanguages } from '../display-language/select.ts';

export const ZONE_SHOWCASE_DISCLOSURE_COST = { maxSlides: 6, maxTargets: 7,
  configurationReads: 5, maxHomeContentReads: 1, targetBatches: 1 } as const;

type ContentOwner = Pick<MainWorkDependencies, 'content' | 'contentAuthoring'>;
// Like media visibility, this owner binding survives a composed environment.
const contentOwner = Symbol('zoneShowcaseContent');
type ShowcaseEnvironment = WorkActivationEnvironment & { [contentOwner]?: ContentOwner };

/** Bind the existing exact Content owner without changing either media guard. */
export function configureZoneShowcaseDisclosure(work: MainWorkDependencies): void {
  (work.environment as ShowcaseEnvironment)[contentOwner] = {
    content: work.content, contentAuthoring: work.contentAuthoring,
  };
}

const displayLanguages = Symbol('zoneCampaignLanguages');
type CampaignReader = SummaryReader & { [displayLanguages]?: readonly string[] };

/** Keep media's selection identical to the home renderer, including translations. */
export function bindZoneCampaignReader<T extends SummaryReader>(reader: T, request: Request): T {
  (reader as CampaignReader)[displayLanguages] = readerLanguages(
    request.headers.get('x-rezics-display-languages'), request.headers.get('accept-language'));
  return reader;
}

export function slideIsCurrent(slide: ZoneSlide, now = Date.now()): boolean {
  return (!slide.startsAt || Date.parse(slide.startsAt) <= now)
    && (!slide.endsAt || now < Date.parse(slide.endsAt));
}

/** Exact originating Zone publication plus one bounded target batch; never scan
 * Zones by Realm or media inventory, or merge draft/config slides into Content. */
export async function currentZoneCampaignUses(env: WorkActivationEnvironment,
  zone: string | null | undefined, reader: SummaryReader, realm: string): Promise<ReadonlySet<string>> {
  if (!zone || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(zone)) return new Set();
  let state;
  try { state = await readZonePublication(env, zone); }
  catch (error) { if (error instanceof ZoneUnavailable) return new Set(); throw error; }
  if (state.disclosure !== 'public' || state.realm !== realm) return new Set();
  const owner = (env as ShowcaseEnvironment)[contentOwner];
  if (state.bundle && !owner?.content) return new Set();
  const work = { environment: env, ...owner };
  let home;
  try { home = await readZonePublishedHomeContent(work, state, (reader as CampaignReader)[displayLanguages]); }
  catch (error) { if (error instanceof ZoneUnavailable) return new Set(); throw error; }
  const local = home && zoneDocumentShowcase(home.document);
  const slides = (local ? local.payload['rv:slides'] : state.presentation.slides)
    .filter(slide => slideIsCurrent(slide));
  const works = [...new Set(slides.flatMap(slide => 'work' in slide ? [slide.work] : []))];
  const summaries = await readResourceSummaries(env, undefined, reader, {
    resources: [zone, ...works], context: DEFAULT_MEDIA_CONTEXT, language: null, channel: 'media',
  });
  if (summaries.summaries[0]?.status !== 'available') return new Set();
  const readable = new Set(summaries.summaries.flatMap(summary =>
    summary.status === 'available' && summary.type === 'work' ? [summary.reference] : []));
  try {
    if (home) await assertZoneHomeContentCurrent(work, state, home.page, home.reference.byteDigest);
    const current = await readZonePublication(env, zone);
    if (current.disclosure !== 'public' || current.realm !== realm || current.revision !== state.revision) return new Set();
  } catch (error) { if (error instanceof ZoneUnavailable) return new Set(); throw error; }
  return new Set(zoneCampaignUses(slides.filter(slide => !('work' in slide) || readable.has(slide.work))));
}
