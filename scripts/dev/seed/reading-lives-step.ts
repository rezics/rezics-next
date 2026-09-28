import { person } from './community-step.ts';
import { seedKey } from './plan.ts';
import { readingLives } from './reading-lives-plan.ts';
import { refreshSeedTokens, type SeedState } from './state.ts';

// Public libraries: each person opens their library and shelves what they
// read, with its dates, as the reader-status command records it. Each entry is
// read first and written only when it differs, so a replay only reads and a
// shelf the base plan filled earlier converges to the plan.

const short = (id: string) => id.slice(-36);

interface Status { status: string | null; startedOn: string | null; finishedOn: string | null; version: number }

export async function seedReadingLives(state: SeedState) {
  const works = new Map<string, string>([...state.created].map(([id, receipt]) => [id, receipt.work]));
  for (const [id, shared] of state.publicWorks) works.set(id, shared.work.work);
  let opened = 0, shelved = 0, entries = 0;
  for (const life of readingLives) {
    await refreshSeedTokens(state);
    await state.optional(`Reading life ${life.person}`, async () => {
      const reader = person(state, life.person);
      const path = `/v1/agents/${short(reader.actingSubject)}/library-visibility`;
      const visibility = await state.api.get<{ visibility: string; version: number }>(path, reader.token);
      if (visibility.visibility !== 'public') {
        await state.api.put(path, { visibility: 'public', expectedVersion: visibility.version }, reader.token,
          seedKey('library-visibility', `${life.person}:${visibility.version}`));
        opened++;
      }
      for (const entry of life.shelf) {
        const work = works.get(entry.work);
        if (!work) throw new Error(`Shelf Work ${entry.work} is unavailable`);
        entries++;
        const current = (await state.api.get<{ status: Status }>(`/v1/works/${short(work)}/reader-state?actingSubject=${
          encodeURIComponent(reader.actingSubject)}`, reader.token)).status;
        if (current.status === entry.status && current.startedOn === entry.startedOn
          && current.finishedOn === entry.finishedOn) continue;
        await state.api.put(`/v1/works/${short(work)}/reader-status`, { actingSubject: reader.actingSubject,
          expectedVersion: current.version, status: entry.status, startedOn: entry.startedOn,
          finishedOn: entry.finishedOn }, reader.token,
        seedKey('reading-life', `${life.person}:${entry.work}:${current.version}`));
        shelved++;
      }
    });
  }
  console.log(`Reading lives: ${readingLives.length} public libraries (${opened} opened), ${entries} shelf entries (${shelved} set).`);
}
