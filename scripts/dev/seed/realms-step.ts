import { grantCuratedCollectionSeed, grantHomeSeedAuthority, grantOfficialZoneSeed } from './operator.ts';
import { realms, seedKey } from './plan.ts';
import { stableId, type SeedState, type SpaceReceipt } from './state.ts';
import { officialPresentation, withoutTabLabels } from './official-plan.ts';
import { retainedSlides } from './showcase-plan.ts';
import { SeedApiError } from './api.ts';
import { readOrCreateOfficialZone, updateOfficialZonePresentation } from './zones.ts';

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

const officialZone = (realm: string) => `https://rezics.com/id/${stableId(`zone:${realm}`)}`;

export type SpaceRead = (path: string) => Promise<Record<string, unknown> | null>;

/** A 404 means the Zone or Realm is absent. The Zone read also needs `zone:edit` scope and authority: with
 * an operator the steward is granted first, so 401 or 403 is a scope or grant defect and must throw rather
 * than create a second Space. Without an operator no grant is possible and the answer means nothing to adopt. */
export function isUnreadable(error: unknown, operator: boolean): boolean {
  return error instanceof SeedApiError
    && (error.status === 404 || !operator && (error.status === 401 || error.status === 403));
}

export function isIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof SeedApiError) || error.status !== 409) return false;
  try { return (JSON.parse(error.detail) as { code?: string }).code === 'idempotency_conflict'; }
  catch { return false; }
}

/** A Space created under an earlier request body cannot replay its key with the
 * current body, and Spaces have no read by handle. The plan fixes each Zone's id,
 * and a configured Zone names its Space and default Realm, so the Space is found
 * through those public reads. The Realm must belong to that Space. Two reads, no write. */
export async function adoptZoneSpace(get: SpaceRead, zone: string, actor: string): Promise<SpaceReceipt | null> {
  const query = `?${new URLSearchParams({ actingSubject: actor })}`;
  const current = await get(`/v1/zones/${zone.slice(-36)}/configuration${query}`);
  const configuration = current?.configuration as { space?: unknown; defaultRealm?: unknown } | undefined;
  const { space, defaultRealm } = configuration ?? {};
  if (typeof space !== 'string' || typeof defaultRealm !== 'string') return null;
  const realm = await get(`/v1/realms/${defaultRealm.slice(-36)}${query}`);
  return realm?.id === defaultRealm && realm.space === space ? { space, realm: defaultRealm, replayed: true } : null;
}

export async function seedRealms(state: SeedState) {
  const { api, created, createdRealms, seededZones, operatorInput, operatorSession } = state;
  const owner = state.sessions[0]!;
  for (const [index, realm] of realms.entries()) {
    // Separate stewards retain their own member quotas on a previously seeded stack.
    const steward = state.sessions[index + 1]!;
    const get: SpaceRead = path => api.get<Record<string, unknown>>(path, steward.token).catch((error: unknown) => {
      if (isUnreadable(error, !!operatorInput)) return null;
      throw error;
    });
    // The Zone's Space is the plan's Space: its key may have changed since (a handle was added), and replaying the
    // current key would then find or make another Space that the Zone does not belong to. Read the Zone first.
    const zone = officialZone(realm.id);
    const receipt = await state.optional('Space / Realm creation', async () => {
      // The Zone read needs the steward's grant, which expires between runs.
      if (operatorInput) await grantOfficialZoneSeed({ ...operatorInput, ownerAccountSubject: steward.accountId,
        actingSubject: steward.actingSubject }, zone);
      const adopted = await adoptZoneSpace(get, zone, steward.actingSubject);
      if (adopted) {
        if (state.endpoints.writeCounts) state.endpoints.writeCounts.lookups++;
        return adopted;
      }
      return api.post<SpaceReceipt>('/v1/spaces', {
        profile: 'space-realm-v2', name: realm.seedName,handle: 'handle' in realm ? realm.handle : realm.id,capabilities: ['realm'],
        actingSubject: steward.actingSubject }, steward.token,
      seedKey('realm', 'handle' in realm ? `${realm.id}:${realm.handle}` : realm.id));
    });
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
    const zone = officialZone(realm.id);
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
    const currentZone = await readOrCreateOfficialZone(api, {
      zone, space: parent.receipt.space, actor: parent.steward.actingSubject,
      token: parent.steward.token, key: seedKey('zone', realm.id),
      operatorApi: operatorSession.api, operatorToken: operatorSession.token });
    // The layout lives with the official Zones' content (official-plan.ts), which fills it later in the run.
    // A Main without localized tab labels gets the same layout with default labels.
    const context = realm.id === 'mods'
      ? configuredModsContext(currentZone.configuration.presentation)
        ?? await state.optional('Mods game and loader concepts', () => modsContext(state, parent.steward))
      : undefined;
    // The showcase step fills the slides once the Works exist; replaying the layout keeps them.
    const presentation = officialPresentation(realm.id, realm.preset, context ?? undefined,
      retainedSlides(currentZone.configuration.presentation));
    await updateOfficialZonePresentation(operatorSession.api, {
      zone, actor: parent.steward.actingSubject, token: operatorSession.token, head: currentZone,
      defaultRealm: parent.receipt.realm, candidates: [
        { variant: '', presentation },
        { variant: ':plain', presentation: withoutTabLabels(presentation) }],
      key: (revision, variant) => seedKey('official-zone', `${realm.id}:${revision.slice(-36)}${variant}`) });
    seededZones.push(zone);
  }
}
