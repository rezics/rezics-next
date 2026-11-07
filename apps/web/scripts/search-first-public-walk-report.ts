/** Complete user paths, rather than successful requests, are the census unit. */
export const journeySteps = {
  'Mixed Search': ['submit', 'open-result', 'return-query', 'phone-results', 'continue', 'current-visibility'],
  'Refine and continue': ['typed-search', 'facets', 'continue', 'restart', 'mounted-facets', 'reader-retirement'],
  'Multilingual names': ['original-name', 'alias', 'suggestion', 'open-subject', 'locale-query-language-order'],
  'Search recovery': ['invalid-input', 'corrected-native', 'mounted-correction', 'lost-generation', 'useful-restart'],
  'Configured reading': [
    'selected-profile',
    'subject-lists',
    'static-zone-lists',
    'document-order',
    'continue-or-retry',
    'usable-siblings',
  ],
  'Published composition': [
    'publish-A',
    'working-B',
    'public-A-over-B',
    'lost-or-refused-response',
    'reconcile-publication',
    'mounted-public-A',
  ],
} as const;

export type JourneyName = keyof typeof journeySteps;

/** Native persona setup prints a generated password; retained walk logs are public evidence. */
export function redactWalkLog(line: string): string {
  return line.replace(/^(\s*Password:)\s*[^\r\n]*/gim, '$1 [redacted]');
}

export type JourneyProgress = {
  name: JourneyName;
  startedAt: string;
  endedAt?: string;
  elapsedSeconds: number;
  result: 'PASS' | 'FAIL' | 'blocked';
  completedSteps: string[];
  unreachedSteps: string[];
  firstFailure?: string;
};

export function completeStep(record: JourneyProgress, step: string): void {
  record.completedSteps.push(step);
}

/** Missing observations cannot be inferred from a successful earlier response. */
export function finishJourney(record: JourneyProgress, endedAt = new Date()): void {
  record.endedAt = endedAt.toISOString();
  record.elapsedSeconds = Number(((endedAt.getTime() - Date.parse(record.startedAt)) / 1000).toFixed(3));
  record.unreachedSteps = journeySteps[record.name].filter((step) => !record.completedSteps.includes(step));
  if (record.firstFailure) {
    record.result = 'FAIL';
    return;
  }
  if (record.result === 'blocked') return;
  if (record.unreachedSteps.length) {
    record.result = 'FAIL';
    record.firstFailure = `Required steps not observed: ${record.unreachedSteps.join(', ')}`;
  } else {
    record.result = 'PASS';
  }
}

/** The slowest failure excludes setup and successful paths. */
export function censusSummary(records: readonly JourneyProgress[]): {
  passing: number;
  total: number;
  slowestFailure?: { name: JourneyName; elapsedSeconds: number };
} {
  const failures = records.filter((record) => record.result !== 'PASS');
  const slowest = failures.reduce<JourneyProgress | undefined>(
    (previous, record) => (!previous || record.elapsedSeconds > previous.elapsedSeconds ? record : previous),
    undefined,
  );
  return {
    passing: records.filter((record) => record.result === 'PASS').length,
    total: Object.keys(journeySteps).length,
    ...(slowest ? { slowestFailure: { name: slowest.name, elapsedSeconds: slowest.elapsedSeconds } } : {}),
  };
}
