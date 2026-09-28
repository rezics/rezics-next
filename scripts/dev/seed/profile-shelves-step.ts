import { profileOperations } from './profile-step-context.ts';
import { afterCatchUp, type SeedState } from './state.ts';

export async function seedProfileShelves(state: SeedState) {
  // Each shelf is read before it is written, so the whole step can start again once Main has caught up.
  await state.optional('Profile shelves', () => afterCatchUp(profileOperations(state).libraries));
}
