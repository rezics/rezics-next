import { isDeepStrictEqual } from 'node:util';
import { grantCuratedCollectionSeed, grantOfficialZoneSeed } from './operator.ts';
import { realms, seedKey } from './plan.ts';
import { stableId, type SeedState, type SpaceReceipt } from './state.ts';
import { officialPresentation, withoutTabLabels } from './official-plan.ts';
import { SeedApiError } from './api.ts';

export async function seedRealms(state: SeedState) {
  const { api, created, createdRealms, seededZones, operatorInput, operatorSession } = state;
  const owner = state.sessions[0]!;
  for (const [index, realm] of realms.entries()) {
    // Separate stewards retain their own member quotas on a previously seeded stack.
    const steward = state.sessions[index + 1]!;
    const receipt = await state.optional('Space / Realm creation', () => api.post<SpaceReceipt>('/v1/spaces', {
      profile: 'space-realm-v1', name: realm.name, capabilities: ['realm'],
      actingSubject: steward.actingSubject }, steward.token, seedKey('realm', realm.id)));
    if (receipt) createdRealms.push({ id: realm.id, receipt, steward });
  }
  for (const realm of realms) {
    if (!operatorInput || !operatorSession) break;
    const parent = createdRealms.find(item => item.id === realm.id);
    if (!parent) continue;
    const collection = `https://rezics.com/id/${stableId(`curated:${realm.id}`)}`;
    const zone = `https://rezics.com/id/${stableId(`zone:${realm.id}`)}`;
    await grantCuratedCollectionSeed(operatorInput, collection);
    const curated = await api.post<{ structure: string; revision: string }>('/v1/collections', {
      collection, name: `${realm.name} · Featured`, disclosure: 'public',
      actingSubject: owner.actingSubject }, owner.token, seedKey('curated-collection', realm.id));
    await api.post(`/v1/collections/${collection.slice(-36)}/changes`, {
      expectedHead: curated.revision, actingSubject: owner.actingSubject,
      operations: realm.featured.map(work => ({ op: 'insert', role: 'member',
        parent: curated.structure, position: 'last',
        target: created.get(work)!.work, selection: { mode: 'follow-context' } })),
    }, owner.token, seedKey('curated-members', realm.id));
    const stewardInput = { ...operatorInput, ownerAccountSubject: parent.steward.accountId,
      actingSubject: parent.steward.actingSubject };
    await grantOfficialZoneSeed(stewardInput, zone);
    await api.post('/v1/zones', { zone, space: parent.receipt.space, disclosure: 'public',
      actingSubject: parent.steward.actingSubject }, parent.steward.token, seedKey('zone', realm.id));
    const currentZone = await api.get<{ revision: string; configuration: {
      defaultRealm: string | null; official: { routeSegment: string } | null;
      presentation: unknown } }>(
      `/v1/zones/${zone.slice(-36)}/configuration?actingSubject=${encodeURIComponent(parent.steward.actingSubject)}`,
      parent.steward.token);
    // The layout lives with the official Zones' content (official-plan.ts), which fills it later in the run.
    // A Main without localized tab labels gets the same layout with default labels.
    const presentation = officialPresentation(realm.id, realm.preset);
    const current = { defaultRealm: currentZone.configuration.defaultRealm,
      official: currentZone.configuration.official, presentation: currentZone.configuration.presentation };
    for (const [variant, candidate] of [['', presentation], [':plain', withoutTabLabels(presentation)]] as const) {
      const desiredZone = { defaultRealm: parent.receipt.realm, official: { routeSegment: realm.id },
        presentation: candidate };
      if (isDeepStrictEqual(current, desiredZone)) break;
      try {
        await operatorSession.api.put(`/v1/zones/${zone.slice(-36)}/configuration`, {
          expectedHead: currentZone.revision, actingSubject: parent.steward.actingSubject,
          ...desiredZone }, operatorSession.token,
        seedKey('official-zone', `${realm.id}:${currentZone.revision.slice(-36)}${variant}`));
        break;
      } catch (error) {
        if (variant || !(error instanceof SeedApiError) || error.status !== 400) throw error;
      }
    }
    seededZones.push(zone);
  }
}
