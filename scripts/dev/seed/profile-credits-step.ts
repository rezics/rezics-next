import { profileOperations } from './profile-step-context.ts';
import type { SeedState } from './state.ts';

export async function seedProfileCredits(state: SeedState) {
  state.profileCreditCount = await state.optional('Profile credits', profileOperations(state).credits) ?? 0;
}
