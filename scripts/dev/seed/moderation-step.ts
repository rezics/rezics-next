import { openRealmReportScope } from './operator.ts';
import { seedRealmManagement } from './realm-management.ts';
import type { SeedState } from './state.ts';

export async function seedModeration(state: SeedState) {
  const managed = state.createdRealms.find(realm => realm.id === 'fiction');
  if (!managed) return;
  if (state.operatorInput) await openRealmReportScope(state.operatorInput, managed.receipt.realm);
  await state.optional('Realm moderation team and queue', () => seedRealmManagement(state.api,
    managed.receipt.realm, managed.steward,
    state.sessions.filter(session => session.id !== managed.steward.id).slice(0, 2),
    [...state.publicForRealm.keys()].map(id => state.created.get(id)!)));
}
