import { prepareHomeV2Chapters } from './home-v2.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedChapterProgress } from './progress.ts';
import type { SeedState } from './state.ts';

export async function seedChapters(state: SeedState) {
  const operator = state.operatorInput;
  if (!operator) return;
  const owner = state.sessions[0]!;
  const serial = await state.optional('Home chapter Content', () => prepareHomeV2Chapters(state.api, owner,
    state.created, grants => grantHomeSeedAuthority(operator, grants)));
  if (serial) await state.optional('Chapter reading progress', () =>
    seedChapterProgress(state.api, state.sessions, serial));
}
