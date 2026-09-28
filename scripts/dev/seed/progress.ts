import type { SeedApi } from './api.ts';
import { seedKey } from './plan.ts';

interface CreatedWork { work: string; mainVersion: string }
interface Composition { structure: string; revision: string }
interface Changed extends Composition { occurrences?: string[] }

/** Progress is valid only for a real chapter occurrence in a Book composition. */
export async function seedChapterProgress(api: SeedApi, owner: { token: string; actingSubject: string },
  readers: readonly { id: string; token: string; actingSubject: string }[],
  works: ReadonlyMap<string, CreatedWork>) {
  const parent = works.get('serial');
  const first = works.get('serial-ch1'), publicChapter = works.get('serial-ch2');
  const third = works.get('serial-ch3');
  if (!parent || !first || !publicChapter || !third) return;
  const legacyChapters = [
    { key: 'serial-ch1', work: parent },
    { key: 'serial-ch2', work: publicChapter },
  ];
  const composition = await api.post<Composition>('/v1/compositions', {
    profile: 'book-composition', work: parent.work, mainVersion: parent.mainVersion,
    actingSubject: owner.actingSubject,
  }, owner.token, seedKey('composition', 'serial'));
  await api.post<Changed>(
    `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
      profile: 'book-composition', expectedHead: composition.revision,
      actingSubject: owner.actingSubject,
      operations: legacyChapters.map(({ key, work }) => ({ op: 'insert', parent: composition.structure,
        position: 'last', role: 'chapter', target: work.work, sourceKey: `seed:/serial/${key}` })),
    }, owner.token, seedKey('composition-chapters', 'serial'));
  const path = `/v1/compositions/${composition.structure.slice(-36)}`;
  const read = () => api.get<{ revision: string; occurrences: Array<{
    occurrence: string; state: string; role: string; target?: string }> }>(
      `${path}?actingSubject=${encodeURIComponent(owner.actingSubject)}&limit=20`, owner.token);
  let page = await read();
  const active = () => page.occurrences.filter(item => item.state === 'active' && item.role === 'chapter');
  const self = active().find(item => item.target === parent.work);
  if (self) {
    await api.post<Changed>(`${path}/changes`, {
      profile: 'book-composition', expectedHead: page.revision, actingSubject: owner.actingSubject,
      operations: [{ op: 'remove', occurrence: self.occurrence }],
    }, owner.token, seedKey('composition-remove-parent-chapter', 'serial'));
    page = await read();
  }
  const missing = [first, third].filter(chapter => !active().some(item => item.target === chapter.work));
  if (missing.length) {
    await api.post<Changed>(`${path}/changes`, {
      profile: 'book-composition', expectedHead: page.revision, actingSubject: owner.actingSubject,
      operations: missing.map(chapter => ({ op: 'insert', parent: composition.structure,
        position: 'last', role: 'chapter', target: chapter.work,
        sourceKey: `seed:/serial/${chapter === first ? 'serial-ch1' : 'serial-ch3'}` })),
    }, owner.token, seedKey('composition-add-real-chapters', 'serial'));
    page = await read();
  }
  const chapters = [first, publicChapter, third];
  const occurrences = chapters.map(chapter => active().find(item => item.target === chapter.work)?.occurrence);
  if (occurrences.some(occurrence => !occurrence)) throw new Error('Seed composition has too few readable chapters');
  for (const [index, reader] of readers.entries()) {
    const occurrence = occurrences[index % occurrences.length];
    if (!occurrence) continue;
    await api.put(`/v1/compositions/${composition.structure.slice(-36)}/occurrences/${occurrence.slice(-36)}/progress`, {
      actingSubject: reader.actingSubject, expectedVersion: 0,
      completed: index % 3 === 0, position: `paragraph:${index + 1}`,
    }, reader.token, seedKey('chapter-progress', `${reader.id}:${occurrence}`));
  }
  return { chapters: occurrences.length };
}
