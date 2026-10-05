import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { pickPositionLabel } from '../wiki/position-picker.ts';
import { idOf } from '../work-page/route.ts';
import type { ResourceSummary } from './types.ts';

// A summary names a chapter or episode after its Work, so two episodes of one series read alike. The name the story gives each
// is the label its reading order wrote; this gives a place's frames those names, reading each Work's order once.

/** Compositions are read this many pages (100 occurrences each) while an episode is still unfound. */
const MAX_PAGES = 10;

type Labels = { value: string; language: string }[];

async function labelsOf(main: MainClient, work: string, wanted: ReadonlySet<string>, actingSubject?: string):
  Promise<Map<string, Labels>> {
  const found = new Map<string, Labels>();
  const id = idOf(work);
  if (!id) return found;
  const parts = await main.v1.resources({ resource: id }).parts.get({ query: { limit: 1, ...actingSubject ? { actingSubject } : {} } });
  const structure = parts.data?.structure && idOf(parts.data.structure);
  if (!structure) return found;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await main.v1.compositions({ id: structure }).get({ query: { limit: 100, ...after ? { after } : {},
      ...actingSubject ? { actingSubject } : {} } });
    if (!read.data) break;
    for (const item of read.data.occurrences) if (item.state === 'active' && wanted.has(item.occurrence)) found.set(item.occurrence, item.labels);
    if (found.size === wanted.size || !read.data.next || read.data.next === after) break;
    after = read.data.next;
  }
  return found;
}

/**
 * The summaries with each episode or chapter frame named by its label in `locale`'s language (else the language it was
 * written in), where the Work's reading order is readable. A frame whose label cannot be read keeps the name it came with.
 */
export async function nameOccurrences(main: MainClient, summaries: readonly (ResourceSummary | null)[], locale: UiLocale,
  actingSubject?: string, cache = new Map<string, Promise<Map<string, Labels>>>()): Promise<(ResourceSummary | null)[]> {
  const wanted = new Map<string, Set<string>>();
  for (const summary of summaries) {
    if (summary?.status !== 'available' || !summary.parts) continue;
    for (const frame of summary.parts.frames) {
      if (frame.type !== 'occurrence' || !frame.work) continue;
      wanted.set(frame.work, (wanted.get(frame.work) ?? new Set()).add(frame.reference));
    }
  }
  if (!wanted.size) return [...summaries];
  const read = new Map<string, Map<string, Labels>>();
  await Promise.all([...wanted].map(async ([work, occurrences]) => {
    const key = `${work}\n${[...occurrences].sort().join(' ')}`;
    const pending = cache.get(key) ?? labelsOf(main, work, occurrences, actingSubject).catch(() => new Map<string, Labels>());
    cache.set(key, pending);
    read.set(work, await pending);
  }));
  return summaries.map(summary => {
    if (summary?.status !== 'available' || !summary.parts) return summary;
    const frames = summary.parts.frames.map(frame => {
      const text = frame.work ? pickPositionLabel(read.get(frame.work)?.get(frame.reference), locale) : null;
      return text ? { ...frame, name: { ...frame.name, value: text.value, language: text.lang, direction: text.dir,
        basis: 'requested' as const } } : frame;
    });
    return { ...summary, parts: { ...summary.parts, frames } };
  });
}
