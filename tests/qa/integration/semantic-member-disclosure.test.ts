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
    await f.grant(`semantic:read:${hidden}`, 'semantic.read');
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
    expect(written.status).toBe(201);
  } finally { await f.close(); }
}, 600_000);
