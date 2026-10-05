import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon, seedVariantKindConcepts } from '../../../scripts/dev/seed/relation-lexicon.ts';
import type { RelationRendering } from '../../../services/main/src/modules/lexicon/render.ts';

const scopes = 'openid work:create work:edit work:read classification:define';

type Changed = { component: string; revision: string };
type Batch = { items: { status: string; renderings: RelationRendering[] }[] };
type SemanticRead = { state: { roles: { key: string; members?: string[] }[] } };
type Participation = { role: string; participant: { kind: string; ref?: string }; availability: string };
type RelationRead = { definition: { roles: { key: string; members?: string[] }[] }; participations: Participation[] };
type ResourceRelations = { items: { relation: string; rendering: RelationRendering | null; counterparts: { reference: string }[] }[] };

test('reference disclosure: a public Concept role member is visible to every reader, a hidden one is not, and a relation naming Concepts is admitted', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', 'semantic-member-disclosure-qa', Bun.env.REZICS_QA_RUN_ID), scopes);
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    await f.grant('classification:define:global', 'classification.proposition.define');
    await f.grant('relation:create:root', 'relation.change');
    const client = {
      post: async <T>(path: string, body: object, key: string) => f.json<T>(await f.call('POST', path, body, key), 201),
      authorizeDefinition: async (receipt: { component: string }) => {
        await f.grant(`semantic:read:${receipt.component}`, 'semantic.read');
        await f.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
      },
    };
    // Private copies under unique keys, as the other lexicon files do; no read grant on the Concepts below:
    // a public Concept is disclosed by the target reader, not by a semantic grant.
    const namespace = `smd-${randomUUID()}`;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const kinds = await seedVariantKindConcepts(client, f.actor, namespace);
    const seeded = await seedRelationLexicon(client, f.actor, namespace,
      relationLexiconSeed.filter(item => item.key === 'variant-of').map(item => ({ ...item, key: `variant-of-${suffix}` })),
      undefined, kinds);
    const variantOf = seeded.find(item => item.key === `variant-of-${suffix}`)!;
    const expectedKinds = [kinds.persona, kinds.counterpart].sort();

    // Anonymous readers see both public Concepts on the kind role, through the lexicon and the semantic read.
    const lexicon = await f.json<Batch>(await f.call('GET', `/v1/lexicon/presentations?${new URLSearchParams({
      definitions: variantOf.component, languages: 'en' })}`, undefined, undefined, null), 200);
    expect(lexicon.items[0]!.status).toBe('available');
    for (const rendering of lexicon.items[0]!.renderings) {
      expect(rendering.meaning.roles.find(role => role.key === 'kind')!.members!.toSorted()).toEqual(expectedKinds);
    }
    const semantic = await f.json<SemanticRead>(await f.call('GET', `/v1/semantic/resources/${shortId(variantOf.component)}`,
      undefined, undefined, null), 200);
    expect(semantic.state.roles.find(role => role.key === 'kind')!.members!.toSorted()).toEqual(expectedKinds);

    // A member the reader cannot see stays absent beside a public one.
    const hidden = (await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
      state: { component: 'resource', types: ['https://schema.org/Person'], properties: [] } }), 201)).component;
    const hiddenGrant = await f.grant(`semantic:read:${hidden}`, 'semantic.read');
    const mixed = await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
      state: { component: 'definition', kind: 'relation', roles: [
        { key: 'subject', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'kind', minParticipants: 1, maxParticipants: 1, ordered: false, members: [kinds.persona, hidden] }] } }), 201);
    const mixedLexicon = await f.json<Batch>(await f.call('GET', `/v1/lexicon/presentations?${new URLSearchParams({
      definitions: mixed.component, languages: 'en' })}`, undefined, undefined, null), 200);
    for (const rendering of mixedLexicon.items[0]!.renderings) {
      expect(rendering.meaning.roles.find(role => role.key === 'kind')!.members).toEqual([kinds.persona]);
    }
    const mixedSemantic = await f.json<SemanticRead>(await f.call('GET', `/v1/semantic/resources/${shortId(mixed.component)}`,
      undefined, undefined, null), 200);
    expect(mixedSemantic.state.roles.find(role => role.key === 'kind')!.members).toEqual([kinds.persona]);
    expect(JSON.stringify(mixedSemantic)).not.toContain(hidden);
    // The grant holder still reads the member the anonymous reader cannot.
    const owner = await f.json<SemanticRead>(await f.call('GET',
      `/v1/semantic/resources/${shortId(mixed.component)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(owner.state.roles.find(role => role.key === 'kind')!.members!.toSorted()).toEqual([kinds.persona, hidden].sort());

    // A variant-of write that names public Concepts is admitted without a read grant on them.
    const person = async () => (await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
      state: { component: 'resource', types: ['https://schema.org/Person'], properties: [] } }), 201)).component;
    const [hub, variant] = [await person(), await person()];
    for (const ref of [hub, variant]) await f.grant(`semantic:read:${ref}`, 'semantic.read');
    const resource = (ref: string) => ({ kind: 'resource', ref });
    const written = await f.call('POST', '/v1/relations/changes', { profile: 'relation-change-v1', actingSubject: f.actor,
      expectedHead: null, definition: variantOf.revision, participations: [
        { role: 'variant', participant: resource(variant) }, { role: 'hub', participant: resource(hub) },
        { role: 'kind', participant: resource(kinds.persona) }] });
    const occurrence = (await f.json<{ occurrence: string }>(written, 201)).occurrence;

    // The relation read and the resource relations read carry the same rule: the public Concept participant and role
    // member are visible to the grant holder, who holds no grant on the Concept.
    const kindMembers = (roles: { key: string; members?: string[] }[]) => roles.find(role => role.key === 'kind')!.members!.toSorted();
    await f.grant(`semantic:read:${occurrence}`, 'semantic.read');
    const acting = encodeURIComponent(f.actor);
    const relation = await f.json<RelationRead>(await f.call('GET',
      `/v1/relations/${shortId(occurrence)}?actingSubject=${acting}`), 200);
    expect(relation.participations.find(item => item.role === 'kind')).toMatchObject({
      participant: { kind: 'resource', ref: kinds.persona }, availability: 'available' });
    expect(kindMembers(relation.definition.roles)).toEqual(expectedKinds);
    const related = await f.json<ResourceRelations>(await f.call('GET',
      `/v1/resources/${shortId(hub)}/relations?actingSubject=${acting}&languages=en`), 200);
    expect(related.items.map(item => item.relation)).toEqual([occurrence]);
    expect(related.items[0]!.counterparts.map(item => item.reference).toSorted()).toEqual([kinds.persona, variant].toSorted());
    expect(kindMembers(related.items[0]!.rendering!.meaning.roles)).toEqual(expectedKinds);

    // A member the grant holder loses sight of is absent from both reads, and the occurrence naming it is withheld.
    await f.grant(`semantic:read:${mixed.component}`, 'semantic.read');
    const publicKind = await f.json<{ occurrence: string }>(await f.call('POST', '/v1/relations/changes', {
      profile: 'relation-change-v1', actingSubject: f.actor, expectedHead: null, definition: mixed.revision,
      participations: [{ role: 'subject', participant: resource(hub) }, { role: 'kind', participant: resource(kinds.persona) }] }), 201);
    const hiddenKind = await f.json<{ occurrence: string }>(await f.call('POST', '/v1/relations/changes', {
      profile: 'relation-change-v1', actingSubject: f.actor, expectedHead: null, definition: mixed.revision,
      participations: [{ role: 'subject', participant: resource(hub) }, { role: 'kind', participant: resource(hidden) }] }), 201);
    for (const written of [publicKind, hiddenKind]) await f.grant(`semantic:read:${written.occurrence}`, 'semantic.read');
    await f.accessPool.query('DELETE FROM access.permission_grant WHERE id = $1', [hiddenGrant]);
    const withPublic = await f.json<RelationRead>(await f.call('GET',
      `/v1/relations/${shortId(publicKind.occurrence)}?actingSubject=${acting}`), 200);
    expect(kindMembers(withPublic.definition.roles)).toEqual([kinds.persona]);
    expect(withPublic.participations.find(item => item.role === 'kind')!.availability).toBe('available');
    const withHidden = await f.json<RelationRead>(await f.call('GET',
      `/v1/relations/${shortId(hiddenKind.occurrence)}?actingSubject=${acting}`), 200);
    expect(withHidden.participations.find(item => item.role === 'kind')!.participant).toEqual({ kind: 'unavailable-reference' });
    expect(JSON.stringify(withHidden)).not.toContain(hidden);
    const page = await f.json<ResourceRelations>(await f.call('GET',
      `/v1/resources/${shortId(hub)}/relations?actingSubject=${acting}&languages=en`), 200);
    expect(page.items.map(item => item.relation).toSorted()).toEqual([occurrence, publicKind.occurrence].toSorted());
    expect(JSON.stringify(page)).not.toContain(hidden);
  } finally { await f.close(); }
}, 600_000);
