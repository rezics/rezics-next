import { isDeepStrictEqual } from 'node:util';
import { grantCuratedCollectionSeed, grantHomeSeedAuthority, grantOfficialZoneSeed } from './operator.ts';
import { realms, seedKey } from './plan.ts';
import { stableId, type SeedState, type SpaceReceipt } from './state.ts';
import { officialPresentation, withoutTabLabels } from './official-plan.ts';
import { SeedApiError } from './api.ts';

/** Replay the same exact definitions for navigation and classification decisions. */
export async function modsConcepts(state: SeedState, steward: SeedState['createdRealms'][number]['steward']) {
  const input = { ...state.operatorInput!, ownerAccountSubject: steward.accountId,
    actingSubject: steward.actingSubject };
  await grantHomeSeedAuthority(input, [
    { action: 'classification.proposition.define', scope: 'classification:define:global' },
    { action: 'context.create', scope: 'context:create:root' },
  ]);
  const concepts = new Map<string, { concept: string; sense: string; definitionRevision: string }>();
  for (const label of ['Minecraft', 'Fabric', 'Forge', 'NeoForge']) {
    concepts.set(label, await state.api.post<{ concept: string; sense: string; definitionRevision: string }>(
      '/v1/classification-propositions', { profile: 'classification-proposition-v1', label,
        actingSubject: steward.actingSubject }, steward.token,
    // A new stable namespace leaves legacy cancelled admissions replayable.
    seedKey('official-mod-concept-v3', label.toLowerCase())));
  }
  return concepts;
}

/** Public Minecraft and loader concepts back the official Mods filter chips. */
async function modsContext(state: SeedState, steward: SeedState['createdRealms'][number]['steward']) {
  const concepts = await modsConcepts(state, steward);
  const context = await state.api.post<{ context: string }>('/v1/contexts', {
    profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
    entries: [...concepts.values()].map(item => ({ target: item.concept, relation: null, state: 'defined',
      definition: item.definitionRevision, applicability: [] })),
    actingSubject: steward.actingSubject }, steward.token, seedKey('official-mod-context', 'games'));
  return context.context;
}

function configuredModsContext(presentation: unknown): string | null {
  if (!presentation || typeof presentation !== 'object' || !('modules' in presentation)
    || !Array.isArray(presentation.modules)) return null;
  const games = presentation.modules.find((item: unknown) => item && typeof item === 'object'
    && 'id' in item && item.id === 'games');
  const source = games && typeof games === 'object' && 'source' in games ? games.source : null;
  return source && typeof source === 'object' && 'kind' in source && source.kind === 'context'
    && 'context' in source && typeof source.context === 'string'
    && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(source.context)
    && source.context !== `https://rezics.com/id/${stableId('official-context:mods-games')}`
    ? source.context : null;
}

export async function seedRealms(state: SeedState) {
  const { api, created, createdRealms, seededZones, operatorInput, operatorSession } = state;
  const owner = state.sessions[0]!;
  for (const [index, realm] of realms.entries()) {
    // Separate stewards retain their own member quotas on a previously seeded stack.
    const steward = state.sessions[index + 1]!;
    const receipt = await state.optional('Space / Realm creation', () => api.post<SpaceReceipt>('/v1/spaces', {
      profile: 'space-realm-v2', name: realm.seedName,handle: realm.id,capabilities: ['realm'],
      actingSubject: steward.actingSubject }, steward.token, seedKey('realm', realm.id)));
    if (receipt) createdRealms.push({ id: realm.id, receipt, steward });
  }
  for (const realm of realms) {
    if (!operatorInput || !operatorSession) break;
    const parent = createdRealms.find(item => item.id === realm.id);
    if (!parent) continue;
    const readGrants = realm.featured.map(id => ({ action: 'work.read' as const,
      scope: `work:read:${created.get(id)!.work}` }));
    for (let offset = 0; offset < readGrants.length; offset += 9) {
      await grantHomeSeedAuthority(operatorInput, readGrants.slice(offset, offset + 9));
    }
    const collection = `https://rezics.com/id/${stableId(`curated:${realm.id}`)}`;
    const zone = `https://rezics.com/id/${stableId(`zone:${realm.id}`)}`;
    await grantCuratedCollectionSeed(operatorInput, collection);
    // An earlier seed created this Collection under an older name; replay reads it instead of recreating it.
    const curated = await api.post<{ structure: string; revision: string }>('/v1/collections', {
      collection, name: `${realm.name} · Featured`, disclosure: 'public',
      actingSubject: owner.actingSubject }, owner.token, seedKey('curated-collection', realm.id))
      .catch(async (error: unknown) => {
        if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
        return api.get<{ structure: string; revision: string }>(`/v1/collections/${collection.slice(-36)}?actingSubject=${
          encodeURIComponent(owner.actingSubject)}&limit=1`, owner.token);
      });
    if (realm.featured.length) await api.post(`/v1/collections/${collection.slice(-36)}/changes`, {
      expectedHead: curated.revision, actingSubject: owner.actingSubject,
      operations: realm.featured.map(work => ({ op: 'insert', role: 'member',
        parent: curated.structure, position: 'last',
        target: created.get(work)!.work, selection: { mode: 'follow-context' } })),
    }, owner.token, seedKey('curated-members', realm.id)).catch((error: unknown) => {
      // The earlier seed already placed these members; the Collection has moved on since.
      if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
    });
    const stewardInput = { ...operatorInput, ownerAccountSubject: parent.steward.accountId,
      actingSubject: parent.steward.actingSubject };
    await grantOfficialZoneSeed(stewardInput, zone);
    await api.post('/v1/zones', { zone, space: parent.receipt.space, disclosure: 'public',
      actingSubject: parent.steward.actingSubject }, parent.steward.token, seedKey('zone', realm.id));
    const currentZone = await api.get<{ revision: string; configuration: {
      defaultRealm: string | null; official: Record<string,never> | null;
      presentation: unknown } }>(
      `/v1/zones/${zone.slice(-36)}/configuration?actingSubject=${encodeURIComponent(parent.steward.actingSubject)}`,
      parent.steward.token);
    // The layout lives with the official Zones' content (official-plan.ts), which fills it later in the run.
    // A Main without localized tab labels gets the same layout with default labels.
    const context = realm.id === 'mods'
      ? configuredModsContext(currentZone.configuration.presentation)
        ?? await state.optional('Mods game and loader concepts', () => modsContext(state, parent.steward))
      : undefined;
    const presentation = officialPresentation(realm.id, realm.preset, context ?? undefined);
    const current = { defaultRealm: currentZone.configuration.defaultRealm,
      official: currentZone.configuration.official, presentation: currentZone.configuration.presentation };
    for (const [variant, candidate] of [['', presentation], [':plain', withoutTabLabels(presentation)]] as const) {
      const desiredZone = { defaultRealm: parent.receipt.realm, official: {},
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
