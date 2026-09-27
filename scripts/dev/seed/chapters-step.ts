import { prepareHomeV2Chapters } from './home-v2.ts';
import { seedChapterProgress } from './progress.ts';
import type { SeedState } from './state.ts';

export async function seedChapters(state: SeedState) {
  if (!state.operatorInput) return;
  const owner = state.sessions[0]!;
  const ready = await state.optional('Home chapter Content', () =>
    prepareHomeV2Chapters(state.api, owner, state.created, state.operatorInput!));
  if (ready) await state.optional('Chapter reading progress', () =>
    seedChapterProgress(state.api, owner, state.sessions, state.created));
}
