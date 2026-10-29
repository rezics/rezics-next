import type { ProgressUnitWrite } from './progress-reads';

/** Choose a useful starting unit from the subject's semantic types while keeping the existing unit choices. */
export function progressDefaultUnit(types: readonly string[] | undefined): ProgressUnitWrite {
  const values = (types ?? []).map((type) => type.toLowerCase());
  if (values.some((type) => /videogame|game/.test(type))) return 'percent';
  if (values.some((type) => /video|movie|tvseries|tvseason|tv.*episode/.test(type))) return 'episode';
  return 'page';
}
