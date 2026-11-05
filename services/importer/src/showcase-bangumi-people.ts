import type { CrossMediaPlan } from './cross-media-seed.ts';
import {
  acquireBangumiPersonCareerSources,
  type BangumiPersonCareerSourceJournal,
} from './showcase-bangumi-careers.ts';
import type { BangumiPersonCareerSource } from './showcase-media.ts';

/** PersonDetail receipts reused from the selected Person career acquisition. */
export type BangumiPersonSource = BangumiPersonCareerSource;
export type BangumiPersonSourceJournal = BangumiPersonCareerSourceJournal;

/** One shared GET /v0/persons/{id} per selected Person, reused for careers and birth dates. */
export async function acquireBangumiPersonSources(
  plan: CrossMediaPlan,
  options: {
    journal?: BangumiPersonSourceJournal;
    fetch?: typeof fetch;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<CrossMediaPlan> {
  const next = await acquireBangumiPersonCareerSources(plan, options);
  return { ...next, personSources: next.personCareerSources };
}
