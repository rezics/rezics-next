import { type SeedApi, SeedApiError } from './api.ts';
import { seedKey } from './plan.ts';

const short = (id: string) => id.slice(-36);

/**
 * Demo readers' places in the serial, given its chapter occurrences in reading order. Each reader is in one
 * chapter, having finished the ones before it; progress is valid only for a real chapter occurrence of a Book.
 */
export async function seedChapterProgress(api: SeedApi,
  readers: readonly { id: string; token: string; actingSubject: string }[],
  serial: { structure: string; occurrences: readonly string[] }) {
  const { structure, occurrences } = serial;
  if (!occurrences.length) throw new Error('Seed composition has no readable chapters');
  const put = (reader: typeof readers[number], occurrence: string, body: { completed: boolean; position: string },
    key: string) => api.put(`/v1/compositions/${short(structure)}/occurrences/${short(occurrence)}/progress`,
    { actingSubject: reader.actingSubject, expectedVersion: 0, ...body }, reader.token, key);
  for (const [index, reader] of readers.entries()) {
    const at = index % occurrences.length;
    for (const earlier of occurrences.slice(0, at)) {
      // A reader who already keeps their own place in that chapter keeps it.
      await put(reader, earlier, { completed: true, position: 'paragraph:1' },
        seedKey('chapter-read', `${reader.id}:${earlier}`)).catch((error: unknown) => {
        if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
      });
    }
    const occurrence = occurrences[at]!;
    await put(reader, occurrence, { completed: index % 3 === 0, position: `paragraph:${index + 1}` },
      seedKey('chapter-progress', `${reader.id}:${occurrence}`)).catch((error: unknown) => {
      // So does a reader who has since moved on in this chapter.
      if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
    });
  }
  return { chapters: occurrences.length };
}
