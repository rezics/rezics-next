import type { CorpusApi } from './work-profile-corpus.ts';
import { seedCatalogueProfileWorks } from './catalogue-work.ts';

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
  const definitions: { concept: string; sense: string; definitionRevision: string }[] = [];
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
  const works: (Awaited<ReturnType<typeof seedCatalogueProfileWorks>>[number] & { language: string })[] = [];
  for (let start = 0; start < input.works; start += 128) {
    input.signal.throwIfAborted();
    const items = Array.from({ length: Math.min(128, input.works - start) }, (_, offset) => {
      const index = start + offset;
      return { key: `${input.key}:work:${index}`, input: { profile: 'work-catalogue-import-v1' as const,
        expectedWorkHead: null, title: `Catalogue common Work ${index}`, language: index % 20 === 0 ? 'ja' : 'en',
        evidence: 'G1032 deterministic catalogue scope fixture', aliases: [], semanticTypes: [],
        credits: [{ agent: input.actingSubject, role: 'author' as const }],
        classifications: queryCatalogueTopics(index, input.vocabulary).map(topic => ({ sense: definitions[topic]!.sense,
          expectedSenseHead: definitions[topic]!.definitionRevision, expectedDecisionHead: null, outcome: 'accepted' as const })) } };
    });
    const rows = await seedCatalogueProfileWorks(input.api, input.actingSubject, items, input.signal);
    works.push(...rows.map((row, index) => ({ ...row, language: items[index]!.input.language })));
    input.progress?.(works.length);
    await input.settle?.();
  }
  // The Query corpus is public catalogue metadata, not a selected-text corpus.
  // Sample both language cohorts and exact creation revisions through the API.
  for (const index of new Set([0, 1, Math.floor(input.works / 2), input.works - 1])) {
    const work = works[index]!;
    const header = await input.api.read<{ id: string; revision: string; mainVersion: string; title: { value: string } }>(
      `/v1/works/${work.work.slice(-36)}?language=${work.language}&actingSubject=${encodeURIComponent(input.actingSubject)}`, input.signal);
    if (header.id !== work.work || header.revision !== work.workRevision || header.mainVersion !== work.mainVersion
      || header.title.value !== `Catalogue common Work ${index}`) throw new Error('Catalogue command verification failed');
  }
  input.signal.throwIfAborted();
  return { works, definitions };
}
