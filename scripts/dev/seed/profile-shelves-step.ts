import { profileOperations } from './profile-step-context.ts';
import type { SeedState } from './state.ts';

export async function seedProfileShelves(state: SeedState) {
  await state.optional('Profile shelves', profileOperations(state).libraries);
}
