import { profileOperations } from './profile-step-context.ts';
import type { SeedState } from './state.ts';

export async function seedProfileBios(state: SeedState) {
  await state.optional('Profile bios', profileOperations(state).bios);
}
