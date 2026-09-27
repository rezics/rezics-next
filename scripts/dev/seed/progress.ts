import type { SeedApi } from './api.ts';
import { seedKey } from './plan.ts';

interface CreatedWork { work: string; mainVersion: string }
interface Composition { structure: string; revision: string }
interface Changed extends Composition { occurrences: string[] }

/** Progress is valid only for a real chapter occurrence in a Book composition. */
export async function seedChapterProgress(api: SeedApi, owner: { token: string; actingSubject: string },
  readers: readonly { id: string; token: string; actingSubject: string }[],
  works: ReadonlyMap<string, CreatedWork>) {
  const parent = works.get('serial');
  const publicChapter = works.get('serial-ch2');
  if (!parent || !publicChapter) return;
  const chapters = [
    { key: 'serial-ch1', work: parent },
    { key: 'serial-ch2', work: publicChapter },
  ];
  const composition = await api.post<Composition>('/v1/compositions', {
    profile: 'book-composition', work: parent.work, mainVersion: parent.mainVersion,
    actingSubject: owner.actingSubject,
  }, owner.token, seedKey('composition', 'serial'));
  const changed = await api.post<Changed>(
    `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
      profile: 'book-composition', expectedHead: composition.revision,
      actingSubject: owner.actingSubject,
      operations: chapters.map(({ key, work }) => ({ op: 'insert', parent: composition.structure,
        position: 'last', role: 'chapter', target: work.work, sourceKey: `seed:/serial/${key}` })),
    }, owner.token, seedKey('composition-chapters', 'serial'));
  for (const [index, reader] of readers.entries()) {
    const occurrence = changed.occurrences[index % changed.occurrences.length];
    if (!occurrence) continue;
    await api.put(`/v1/compositions/${composition.structure.slice(-36)}/occurrences/${occurrence.slice(-36)}/progress`, {
      actingSubject: reader.actingSubject, expectedVersion: 0,
      completed: index % 3 === 0, position: `paragraph:${index + 1}`,
    }, reader.token, seedKey('chapter-progress', `${reader.id}:${occurrence}`));
  }
}
