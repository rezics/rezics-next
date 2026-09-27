import { profileOperations } from './profile-step-context.ts';
import type { SeedState } from './state.ts';

export async function seedProfileFollows(state: SeedState) {
  state.profileFollowCount = await state.optional('Profile follows', profileOperations(state).follows) ?? 0;
  console.log(`Profiles: ${state.profileCreditCount} credits, ${state.profileFollowCount} follows.`);
}
