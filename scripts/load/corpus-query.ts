import type { CorpusApi } from './work-profile-corpus.ts';
import { seedPublicProfileWork } from './work-profile-work.ts';
import { runBoundedIndices } from './schedule.ts';

/** Diagnostic catalogue axes; none are production capacity qualifications. */
export const QUERY_CATALOGUE_SCALES = [
  { works: 1_000, vocabulary: 128 },
  { works: 10_000, vocabulary: 512 },
  { works: 50_000, vocabulary: 2_048 },
] as const;

/** Deterministic skew: a 90% topic, a 50% topic, overlapping 10% topics and
 * a long tail. Every Work gets a tail term; vocabulary grows separately from
 * the hot postings. Include/exclude combinations have both dense and rare paths. */
export function queryCatalogueTopics(index: number, vocabulary: number): number[] {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(vocabulary) ||
    vocabulary < 16
  )
    throw new Error('Invalid catalogue topic axes');
  return [
    ...new Set([
      ...(index % 10 !== 0 ? [0] : []),
      ...(index % 2 === 0 ? [1] : []),
      ...(index % 10 < 2 ? [2 + (index % 2)] : []),
      4 + Math.floor(((Math.imul(index, 2654435761) >>> 0) / 2 ** 32) * (vocabulary - 4)),
    ]),
  ];
}

/** The recipe only sees public APIs. Owners supply a stopped, all-store backup
 * driver after successful verification; a failed build is never reusable. */
export async function seedQueryCatalogue(input: {
  api: CorpusApi;
  actingSubject: string;
  key: string;
  works: number;
  vocabulary: number;
  signal: AbortSignal;
  workers?: number;
  /** Drain the real relay between bounded chunks, without altering admission. */
  settle?: () => Promise<unknown>;
  progress?: (completed: number) => void;
}) {
  if (!Number.isSafeInteger(input.works) || input.works < 1 || input.works > 50_000)
    throw new Error('Invalid catalogue Work count');
  queryCatalogueTopics(0, input.vocabulary);
  const definitions: { concept: string; sense: string }[] = [];
  for (let index = 0; index < input.vocabulary; index++) {
    input.signal.throwIfAborted();
    definitions.push(
      await input.api.command(
        `${input.key}:topic:${index}`,
        {
          method: 'POST',
          path: '/v1/classification-vocabulary',
          body: {
            profile: 'classification-proposition-v2',
            scheme: null,
            labels: [{ language: 'en', value: `Catalogue topic ${index}` }],
            alternativeLabels: [],
            broader: [],
            narrower: [],
            actingSubject: input.actingSubject,
          },
        },
        input.signal,
      ),
    );
    if ((index + 1) % 32 === 0) await input.settle?.();
  }
  if (input.vocabulary % 32 !== 0) await input.settle?.();
  const works: Awaited<ReturnType<typeof seedPublicProfileWork>>[] = [];
  for (let start = 0; start < input.works; start += 32) {
    await runBoundedIndices(
      Math.min(32, input.works - start),
      input.workers ?? 2,
      async (offset) => {
        const index = start + offset;
        input.signal.throwIfAborted();
        const work = await seedPublicProfileWork(input.api, `${input.key}:work:${index}`, {
          actingSubject: input.actingSubject,
          title: `Catalogue common Work ${index}`,
          body: `Catalogue selected text ${index}`,
          language: index % 20 === 0 ? 'ja' : 'en',
        });
        for (const topic of queryCatalogueTopics(index, input.vocabulary)) {
          input.signal.throwIfAborted();
          await input.api.command(
            `${input.key}:classification:${index}:${topic}`,
            {
              method: 'POST',
              path: '/v1/classification-decisions',
              body: {
                profile: 'classification-direct-decision-v1',
                context: { kind: 'global' },
                work: work.work,
                mainVersion: work.mainVersion,
                sense: definitions[topic]!.sense,
                expectedDecisionHead: null,
                outcome: 'accepted',
                actingSubject: input.actingSubject,
              },
            },
            input.signal,
          );
        }
        works[index] = work;
      },
      (count) => input.progress?.(start + count),
    );
    input.signal.throwIfAborted();
    await input.settle?.();
  }
  // Exact selected bytes/revision checks are outside the timed query. Sample
  // both language cohorts, edges and the middle of the retained command set.
  for (const index of new Set([0, 1, Math.floor(input.works / 2), input.works - 1])) {
    if (index >= works.length) continue;
    input.signal.throwIfAborted();
    const work = works[index]!;
    const selected = await input.api.read<{
      contribution: string;
      selectedDraft: string;
      body: string;
    }>(
      `/v1/main-versions/${work.mainVersion.slice(-36)}/selection?language=${work.language}`,
      input.signal,
    );
    if (
      selected.contribution !== work.contribution ||
      selected.selectedDraft !== work.draftRevision ||
      selected.body !== `Catalogue selected text ${index}`
    )
      throw new Error('Catalogue command verification failed');
  }
  input.signal.throwIfAborted();
  return { works, definitions };
}
