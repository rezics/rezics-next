import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import {
  createGrowthQuestionDirectoryFixture,
  DIRECTORY_SELECTED_PREFIX,
  QUESTION_DIRECTORY_SCALES,
  QUESTION_DIRECTORY_STANDARD_ID,
  type DirectoryQuestion,
} from './support/growth-question-directory-fixture.ts';

type Scenario = 'first' | 'deep' | 'terminal-empty' | 'denied-current-authority';
type GrowthAxis = 'unrelated-catalogue' | 'measurement-identity' | 'closed-global-denial-history';
type DirectoryPage = { readonly ratingQuestions: readonly DirectoryQuestion[]; readonly next: string | null };

const scenarios: readonly Scenario[] = ['first', 'deep', 'terminal-empty', 'denied-current-authority'];
const axes: readonly GrowthAxis[] = ['unrelated-catalogue', 'measurement-identity', 'closed-global-denial-history'];
const unrelatedPrefix: Readonly<Record<Scenario, string>> = {
  first: 'f0000000-0000-7000-8000-',
  deep: '40000000-0000-7000-8000-',
  'terminal-empty': '40000000-0000-7000-8000-',
  'denied-current-authority': '40000000-0000-7000-8000-',
};
const standardQuestion: DirectoryQuestion = {
  id: QUESTION_DIRECTORY_STANDARD_ID,
  revision: 1,
  label: 'How much did you like this work?',
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
};

function pagePath(cursor: string): string {
  return `/v1/rating-questions?limit=20&cursor=${encodeURIComponent(cursor)}`;
}

function recordSerializedBytes(samples: Map<number, number[]>, scale: number, body: string): void {
  const bytes = samples.get(scale) ?? [];
  bytes.push(new TextEncoder().encode(body).byteLength);
  samples.set(scale, bytes);
}

async function page(response: Response, status = 200, observeBody?: (body: string) => void): Promise<DirectoryPage> {
  if (response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.status}: ${await response.clone().text()}`);
  const body = await response.text();
  observeBody?.(body);
  return JSON.parse(body) as DirectoryPage;
}

async function problem(
  response: Response,
  status: number,
  code: string,
  observeBody?: (body: string) => void,
): Promise<void> {
  const body = await response.text();
  observeBody?.(body);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.status).toBe(status);
  expect(JSON.parse(body)).toMatchObject({ status, code, type: `https://rezics.com/problems/${code}` });
}

async function prepareScenario(
  fixture: Awaited<ReturnType<typeof createGrowthQuestionDirectoryFixture>>,
  scenario: Scenario,
): Promise<{ readonly cursor?: string; readonly expected?: readonly DirectoryQuestion[] }> {
  const fixedCount = scenario === 'deep' ? 60 : 20;
  const selected = await fixture.seedQuestionRange(DIRECTORY_SELECTED_PREFIX, 1, fixedCount);

  if (scenario === 'first') return { expected: [standardQuestion, ...selected.slice(0, 19)] };

  const first = await page(await fixture.request('/v1/rating-questions'));
  expect(first.ratingQuestions).toEqual([standardQuestion, ...selected.slice(0, 19)]);
  expect(first.next).toEqual(expect.any(String));

  if (scenario === 'deep') {
    const second = await page(await fixture.request(pagePath(first.next!)));
    expect(second.ratingQuestions).toEqual(selected.slice(19, 39));
    expect(second.next).toEqual(expect.any(String));

    const alternateCredential = await fixture.issueCredential(
      'reader',
      'rating-question-directory-alternate',
      'subject:read realm:read',
    );
    await problem(await fixture.request(pagePath(second.next!), 'outsider'), 400, 'invalid_cursor');
    await problem(await fixture.request(pagePath(second.next!), 'anonymous'), 400, 'invalid_cursor');
    await problem(await fixture.request(pagePath(second.next!), 'reader', alternateCredential), 400, 'invalid_cursor');

    const current = {
      ...selected[39]!,
      revision: 2,
      label: 'Current metadata between pages',
      grain: 'release' as const,
      scale: { min: 2, max: 14, displayStep: 2 },
    };
    await fixture.updateQuestion(current);
    return { cursor: second.next!, expected: [current, ...selected.slice(40, 59)] };
  }

  if (scenario === 'terminal-empty') {
    // The first page emits a cursor after its twentieth consumed key while the last row is its lookahead.
    // Removing that lookahead makes a valid continuation with no rows after the signed position.
    await fixture.database.admin.query('DELETE FROM rating.question WHERE id = $1', [selected[19]!.id]);
    return { cursor: first.next! };
  }

  await fixture.seedCurrentDenial();
  return { cursor: first.next! };
}

function assertNativeEvidence(
  scenario: Scenario,
  name: string,
  samples: Awaited<ReturnType<typeof checkGrowth>>['samples'],
): void {
  expect(samples.map(({ scale }) => scale)).toEqual([...QUESTION_DIRECTORY_SCALES]);
  for (const sample of samples) {
    expect(sample.repetitions).toHaveLength(2);
    expect(sample.backendRepetitions).toHaveLength(2);
    for (const cost of sample.repetitions) {
      const relations = Object.keys(cost.relations);
      expect(relations).toContain('access.resource_denial');
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      // The shared observer keeps SQL failures in the same classification; none is expected for this HTTP result.
      expect(cost.failedStatements ?? {}).toEqual({});

      const questionCost = cost.relations['rating.question'];
      if (scenario === 'denied-current-authority') {
        expect(questionCost).toBeUndefined();
      } else {
        expect(questionCost).toBeDefined();
        expect(questionCost!.rows).toBeLessThanOrEqual(21);
        expect(questionCost!.sequentialScans).toBe(0);
      }
    }
    for (const backends of sample.backendRepetitions) expect(new Set(backends).size).toBe(1);
    for (const statements of sample.statementRepetitions) {
      expect(statements.filter(({ statement }) => /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(statement))).toEqual([]);
    }
  }

  const relationNames = [
    ...new Set(samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations)))),
  ];
  assertGrowthAccessPaths(name, samples, relationNames);
}

test('rating-question directory pages retain bounded native Access work across source, identity and authority growth', async () => {
  const fixture = await createGrowthQuestionDirectoryFixture();
  try {
    for (const scenario of scenarios) {
      for (const axis of axes) {
        await fixture.reset();
        // Setup fixes the selected neighbourhood, signed page position and authority state outside observation.
        const prepared = await prepareScenario(fixture, scenario);
        const name = `rating question directory ${scenario} under ${axis}`;
        const serializedBytes = new Map<number, number[]>();
        let currentScale: number = QUESTION_DIRECTORY_SCALES[0]!;
        const report = await checkGrowth(fixture.database, {
          name,
          scales: QUESTION_DIRECTORY_SCALES,
          repetitions: 2,
          includeBackends: true,
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
          indexProbes: 128,
          grow: async (_database, scale, previous) => {
            currentScale = scale;
            if (axis === 'unrelated-catalogue')
              await fixture.seedQuestionRange(
                unrelatedPrefix[scenario],
                previous + 1,
                scale,
                `Unrelated ${scenario} question `,
              );
            else if (axis === 'measurement-identity')
              await fixture.seedMeasurementIdentityRange(unrelatedPrefix[scenario], previous + 1, scale);
            else await fixture.seedClosedDenialHistory(previous + 1, scale);
          },
          operation: async () => {
            // Selection and completion use one real HTTP request in the measured operation. Repeated
            // checkGrowth samples replay this same signed position and viewer credential.
            if (scenario === 'first') {
              const result = await page(await fixture.request('/v1/rating-questions'), 200, (body) =>
                recordSerializedBytes(serializedBytes, currentScale, body),
              );
              expect<unknown>(result.ratingQuestions).toEqual(prepared.expected);
              expect(result.next).toEqual(expect.any(String));
              return result;
            }

            const response = await fixture.request(pagePath(prepared.cursor!));
            if (scenario === 'denied-current-authority') {
              await problem(response, 404, 'not_found', (body) =>
                recordSerializedBytes(serializedBytes, currentScale, body),
              );
              return response.status;
            }
            const result = await page(response, 200, (body) =>
              recordSerializedBytes(serializedBytes, currentScale, body),
            );
            if (scenario === 'terminal-empty') expect(result).toEqual({ ratingQuestions: [], next: null });
            else {
              expect<unknown>(result.ratingQuestions).toEqual(prepared.expected);
              expect(result.next).toEqual(expect.any(String));
            }
            return result;
          },
        });
        expect([...serializedBytes.keys()]).toEqual([...QUESTION_DIRECTORY_SCALES]);
        for (const samples of serializedBytes.values()) {
          expect(samples.length).toBeGreaterThanOrEqual(2);
          expect(new Set(samples).size).toBe(1);
        }
        assertNativeEvidence(scenario, name, report.samples);
      }
    }
  } finally {
    await fixture.close();
  }
}, 1_800_000);
