import { grantHomeSeedAuthority } from './operator.ts';
import { realms, seedKey } from './plan.ts';
import type { SeedState } from './state.ts';

/** Realm choices are review decisions on already public contributions. */
export async function seedAdoptions(state: SeedState) {
  const { api, created, createdRealms, operatorInput, publicForRealm } = state;
  for (const realm of createdRealms) {
    if (!operatorInput) break;
    const featured = realms.find(item => item.id === realm.id)?.featured.find(id => publicForRealm.has(id));
    if (!featured) continue;
    const target = created.get(featured)!, publication = publicForRealm.get(featured)!;
    const stewardInput = { ...operatorInput, ownerAccountSubject: realm.steward.accountId,
      actingSubject: realm.steward.actingSubject };
    await grantHomeSeedAuthority(stewardInput,
      [{ action: 'publication.adopt', scope: `publication:adopt:${realm.receipt.realm}` }]);
    await state.optional('Realm sample adoption', () => api.post('/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm.receipt.realm },
      work: target.work, mainVersion: target.mainVersion,
      contribution: publication.contribution, publicationDecision: publication.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
      actingSubject: realm.steward.actingSubject }, realm.steward.token,
    seedKey('realm-adoption', `${realm.id}:${featured}`)));
  }
}
