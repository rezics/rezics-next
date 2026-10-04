import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { seedRelationLexicon, seedVariantKindConcepts } from '../../../scripts/dev/seed/relation-lexicon.ts';
import type { RelationRendering } from '../../../services/main/src/modules/lexicon/render.ts';

const uiLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
const keys = ['variant-of', 'holds-title', 'represents', 'in-continuity'];
const scopes = 'openid work:create work:edit work:read classification:define';

type Changed = { component: string; revision: string };
type Written = { occurrence: string; revision: string; replayed: boolean };
type Relation = { occurrence: string; revision: string; participations: { role: string;
  creditedName?: { lexical: string; language: string } }[]; definition: { star: { leaf: string; hub: string } | null } };
type Batch = { items: { definition: string; status: string; renderings: RelationRendering[] }[] };
type Page = { items: { rendering: RelationRendering | null }[] };

test('identity links: credited names, star refusals and seeded definitions through the API', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', 'identity-links-qa', Bun.env.REZICS_QA_RUN_ID), scopes, undefined, { readingPositions: true });
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
    // Private copies under unique keys: canonical keys, their Concepts and their retained bytes belong to
    // whichever file seeded them first, and this file must not depend on that.
    const namespace = `il-${randomUUID()}`;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const keyOf = (key: string) => `${key}-${suffix}`;
    const kinds = await seedVariantKindConcepts(client, f.actor, namespace);
    const seeded = await seedRelationLexicon(client, f.actor, namespace,
      relationLexiconSeed.filter(item => keys.includes(item.key)).map(item => ({ ...item, key: keyOf(item.key) })),
      undefined, kinds);
    const definitions = new Map<string, { definition: string; revision: string }>();
    for (const key of keys) {
      const saved = seeded.find(item => item.key === keyOf(key))!;
      definitions.set(key, { definition: saved.component, revision: saved.revision });
    }

    // The four definitions resolve by key; the star is definition metadata.
    const byKey = async (key: string) => f.json<{ roles: { key: string }[]; star: { leaf: string; hub: string } | null;
      workSubjectRole: string | null }>(await f.call('GET',
      `/v1/lexicon/definitions/${keyOf(key)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(await byKey('variant-of')).toMatchObject({ star: { leaf: 'variant', hub: 'hub' }, workSubjectRole: null });
    expect((await byKey('variant-of')).roles.map(role => role.key)).toEqual(['hub', 'kind', 'variant']);
    expect((await byKey('holds-title')).star).toBeNull();
    expect((await byKey('represents')).roles.map(role => role.key)).toEqual(['character', 'unit']);
    expect(await byKey('in-continuity')).toMatchObject({ workSubjectRole: 'work' });

    // Labels in the eight UI locales, rendered both ways: "Variant of" on the variant, "Variants" on the hub.
    for (const key of keys) {
      for (const language of uiLocales) {
        const batch = await f.json<Batch>(await f.call('GET', `/v1/lexicon/presentations?${new URLSearchParams({
          actingSubject: f.actor, definitions: definitions.get(key)!.definition, languages: language })}`), 200);
        const [item] = batch.items;
        expect(item!.status).toBe('available');
        const seed = relationLexiconSeed.find(entry => entry.key === key)!;
        for (const rendering of item!.renderings) for (const projection of rendering.projections) {
          if (!seed.roles.includes(projection.fromRole as never) || !seed.roles.includes(projection.toRole as never)) continue;
          expect(projection.language).toBe(language);
          expect(projection.labels?.noun).toBeTruthy();
          expect(projection.fallback).toBeNull();
        }
      }
    }
    const english = await f.json<Batch>(await f.call('GET', `/v1/lexicon/presentations?${new URLSearchParams({
      actingSubject: f.actor, definitions: definitions.get('variant-of')!.definition, languages: 'en' })}`), 200);
    const direction = (viewingRole: string, toRole: string) => english.items[0]!.renderings
      .find(rendering => rendering.viewingRole === viewingRole)!.projections.find(item => item.toRole === toRole)!.labels!;
    expect(direction('variant', 'hub')).toMatchObject({ noun: 'Variant of' });
    expect(direction('hub', 'variant')).toMatchObject({ noun: 'Variant', heading: 'Variants' });

    // Participants: characters, and the two kind Concepts.
    const person = async () => (await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
      state: { component: 'resource', types: ['https://schema.org/Person'], properties: [] } }), 201)).component;
    const [hub, alter, second, other] = [await person(), await person(), await person(), await person()];
    const readGrants = new Map<string, string>();
    for (const ref of [hub, alter, second, other, kinds.persona, kinds.counterpart]) {
      readGrants.set(ref, await f.grant(`semantic:read:${ref}`, 'semantic.read'));
    }
    const resource = (ref: string) => ({ kind: 'resource', ref });
    const variantOf = definitions.get('variant-of')!.revision;
    const link = (variant: string, hubRef: string, extra: object = {}, variantCredit?: object) => ({
      profile: 'relation-change-v1', actingSubject: f.actor, expectedHead: null, definition: variantOf,
      participations: [{ role: 'variant', participant: resource(variant), ...(variantCredit ? { creditedName: variantCredit } : {}) },
        { role: 'hub', participant: resource(hubRef) }, { role: 'kind', participant: resource(kinds.persona) }], ...extra });
    const write = (body: object, key = randomUUID()) => f.call('POST', '/v1/relations/changes', body, key);
    const path = (occurrence: string, revision?: string) => `/v1/relations/${shortId(occurrence)}${revision
      ? `/revisions/${shortId(revision)}` : ''}?actingSubject=${encodeURIComponent(f.actor)}`;

    // The seeded kind role takes only the two seeded Concepts.
    expect((await write({ ...link(alter, hub), participations: [{ role: 'variant', participant: resource(alter) },
      { role: 'hub', participant: resource(hub) }, { role: 'kind', participant: resource(other) }] })).status).toBe(400);

    // Credited names: validated, retained per participation and carried by the relation read and the traversal.
    for (const bad of [{ lexical: '', language: 'en' }, { lexical: 'Saber', language: 'not a tag' },
      { lexical: 'Saber', language: 'en', direction: 'ltr' }, { lexical: 'x'.repeat(201), language: 'en' }]) {
      expect((await write(link(alter, hub, {}, bad))).status).toBeGreaterThanOrEqual(400);
    }
    const first = await f.json<Written>(await write(link(alter, hub, {}, { lexical: 'Saber', language: 'en' })), 201);
    await f.grant(`semantic:read:${first.occurrence}`, 'semantic.read');
    const read = await f.json<Relation>(await f.call('GET', path(first.occurrence)), 200);
    expect(read.definition.star).toEqual({ leaf: 'variant', hub: 'hub' });
    expect(read.participations.find(item => item.role === 'variant')!.creditedName)
      .toEqual({ lexical: 'Saber', language: 'en' });
    expect(read.participations.filter(item => item.creditedName)).toHaveLength(1);
    expect((await f.json<Relation>(await f.call('GET', path(first.occurrence, first.revision)), 200))
      .participations.find(item => item.role === 'variant')!.creditedName).toEqual({ lexical: 'Saber', language: 'en' });
    const traversal = await f.json<Page>(await f.call('GET',
      `/v1/resources/${shortId(hub)}/relations?actingSubject=${encodeURIComponent(f.actor)}&languages=en`), 200);
    const rendered = traversal.items.find(item => item.rendering?.occurrence?.component === first.occurrence)!.rendering!;
    expect(rendered.bindings.find(item => item.role === 'variant')!.creditedName).toEqual({ lexical: 'Saber', language: 'en' });
    expect(rendered.projections.flatMap(item => item.arguments).find(item => item.role === 'variant')!.creditedName)
      .toEqual({ lexical: 'Saber', language: 'en' });

    // The credited name belongs to its participant: a reader who loses the participant loses the name with it.
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [readGrants.get(alter)]);
    const redacted = await f.json<Relation>(await f.call('GET', path(first.occurrence)), 200);
    const variant = redacted.participations.find(item => item.role === 'variant')! as typeof redacted.participations[number] & {
      participant: { kind: string }; availability: string };
    expect(variant.availability).toBe('unavailable');
    expect(variant.participant).toEqual({ kind: 'unavailable-reference' });
    expect(variant.creditedName).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain('Saber');
    readGrants.set(alter, await f.grant(`semantic:read:${alter}`, 'semantic.read'));

    // Occurrences without a credited name read as having none.
    const plain = await f.json<Written>(await write({ ...link(second, hub) }), 201);
    await f.grant(`semantic:read:${plain.occurrence}`, 'semantic.read');
    expect((await f.json<Relation>(await f.call('GET', path(plain.occurrence)), 200))
      .participations.some(item => item.creditedName)).toBe(false);

    // Star: a leaf holds the leaf role once, a hub never holds it and a leaf never holds the hub role.
    const refused = async (body: object, key = randomUUID()) => {
      const response = await write(body, key);
      expect(response.status).toBe(422);
      expect((await response.json() as { code: string }).code).toBe('star_violation');
      return key;
    };
    const secondHubKey = await refused(link(alter, other));
    expect((await write(link(alter, other), secondHubKey)).status).toBe(422); // the refusal replays
    await refused(link(hub, other));
    await refused(link(other, alter));
    await refused(link(other, other));
    expect((await write({ ...link(other, hub), participations: [
      { role: 'variant', participant: { kind: 'external', provider: 'x', namespace: 'y', key: 'z' } },
      { role: 'hub', participant: resource(hub) }, { role: 'kind', participant: resource(kinds.persona) }] })).status)
      .toBe(400);
    // A refusal names a link only when the caller can read it; a hidden link answers like any unavailable reference.
    const quiet = await person();
    readGrants.set(quiet, await f.grant(`semantic:read:${quiet}`, 'semantic.read'));
    const quietLink = await f.json<Written>(await write(link(quiet, hub)), 201); // its occurrence is not granted
    const problemOf = async (response: Response) => (await response.json() as { code: string }).code;
    const hiddenRefusal = await write(link(quiet, other));
    expect(hiddenRefusal.status).toBe(422);
    const hiddenCode = await problemOf(hiddenRefusal);
    expect(hiddenCode).toBe('unavailable_reference');
    const missing = await write(link(nativeId(), other));
    expect([missing.status, await problemOf(missing)]).toEqual([422, hiddenCode]);
    await f.grant(`semantic:read:${quietLink.occurrence}`, 'semantic.read');
    await refused(link(quiet, other));

    // The occurrence that holds the leaf may itself be revised.
    await f.grant(`relation:edit:${first.occurrence}`, 'relation.change');
    await f.json<Written>(await write(link(alter, hub, { occurrence: first.occurrence, expectedHead: first.revision },
      { lexical: 'Saber Alter', language: 'en' })), 200);
    // Concurrent creates for one leaf: exactly one wins.
    const racer = await person();
    await f.grant(`semantic:read:${racer}`, 'semantic.read');
    const racers = await Promise.all([hub, other].map(target => write(link(racer, target))));
    expect(racers.map(response => response.status).sort()).toEqual([201, 422].sort());

    // Retiring the occurrence frees the leaf.
    const head = (await f.json<Relation>(await f.call('GET', path(first.occurrence)), 200)).revision;
    await f.json<Written>(await write({ ...link(alter, hub), occurrence: first.occurrence, expectedHead: head,
      lifecycle: 'retired' }), 200);
    const moved = await f.json<Written>(await write(link(alter, other)), 201);
    expect(moved.occurrence).not.toBe(first.occurrence);

    // Other definitions carry no uniqueness: a holder with two titles, a unit for two characters.
    const holds = definitions.get('holds-title')!.revision;
    const [title, titleToo] = [await person(), await person()];
    for (const ref of [title, titleToo]) await f.grant(`semantic:read:${ref}`, 'semantic.read');
    for (const target of [title, titleToo]) {
      await f.json<Written>(await write({ profile: 'relation-change-v1', actingSubject: f.actor, expectedHead: null,
        definition: holds, participations: [{ role: 'holder', participant: resource(alter) },
          { role: 'title', participant: resource(target) }] }), 201);
    }

    // A link can be a spoiler: it is recorded at a position of a Work's reading order, as Statements record theirs.
    const spoilerWork = (await f.json<{ work: string }>(await f.call('POST', '/v1/works', await f.catalogueBody({
      profile: 'metadata-only-v1', language: 'en', title: `Spoiler Work ${randomUUID()}`, actingSubject: f.actor })), 201)).work;
    await f.grant(`work:read:${spoilerWork}`, 'work.read');
    const chapter = nativeId();
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH <urn:rezics:graph:current> {
      <${nativeId()}> a rv:OccurrencePlacement ; rv:occurrence <${chapter}> } }`);
    const [spoilerLeaf, spoilerHub] = [await person(), await person()];
    for (const ref of [spoilerLeaf, spoilerHub]) await f.grant(`semantic:read:${ref}`, 'semantic.read');
    const revealedAt = { work: spoilerWork, occurrence: chapter };
    const spoilerKey = randomUUID();
    const spoiler = await f.json<Written>(await write(link(spoilerLeaf, spoilerHub, { revealedAt }), spoilerKey), 201);
    await f.grant(`semantic:read:${spoiler.occurrence}`, 'semantic.read');
    const at = (occurrence: string, position: string) => f.call('GET', `${path(occurrence)}&position=${position}`);
    expect((await at(spoiler.occurrence, 'start')).status).toBe(404); // before the revealing chapter
    expect((await at(spoiler.occurrence, 'all')).status).toBe(200);
    expect((await at(plain.occurrence, 'start')).status).toBe(200); // links without a position stay visible
    expect((await write(link(spoilerLeaf, spoilerHub, { revealedAt }), spoilerKey)).status).toBe(201); // replay
    // The position pins the command: it cannot be reused for another position, and an unknown one is refused.
    expect((await write(link(spoilerLeaf, spoilerHub, { revealedAt: { ...revealedAt, occurrence: nativeId() } }), spoilerKey))
      .status).toBe(409);
    const unplaced = await write(link(await person(), spoilerHub, { revealedAt: { ...revealedAt, occurrence: nativeId() } }));
    expect([unplaced.status, await problemOf(unplaced)]).toEqual([422, 'unavailable_reference']);
    expect((await write(link(await person(), spoilerHub, { revealedAt: { work: nativeId(), occurrence: chapter } }))).status).toBe(422);
    expect((await write(link(await person(), spoilerHub, { revealedAt: { work: spoilerWork } }))).status).toBeGreaterThanOrEqual(400);
    // An occurrence's position never moves.
    await f.grant(`relation:edit:${spoiler.occurrence}`, 'relation.change');
    const movedPosition = await write(link(spoilerLeaf, spoilerHub, { occurrence: spoiler.occurrence, expectedHead: spoiler.revision,
      revealedAt: { ...revealedAt, occurrence: nativeId() } }));
    expect(movedPosition.status).toBeGreaterThanOrEqual(400);

    // Role members and the star are definition data: no code names `variant-of`.
    const roles = ['variant', 'hub', 'kind'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false,
      ...(key === 'kind' ? { members: [kinds.persona, kinds.counterpart] } : {}) }));
    const defineBound = async () => {
      const notation = `bound-${randomUUID()}`;
      return { notation, ...await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
        state: { component: 'definition', kind: 'relation', notation, roles, star: { leaf: 'variant', hub: 'hub' } } }), 201) };
    };
    const bound = await defineBound();
    const onBound = (kind: string, leaf: string, hubRef: string) => ({ profile: 'relation-change-v1', actingSubject: f.actor,
      expectedHead: null, definition: bound.revision, participations: [{ role: 'variant', participant: resource(leaf) },
        { role: 'hub', participant: resource(hubRef) }, { role: 'kind', participant: resource(kind) }] });
    expect((await write(onBound(alter, second, other))).status).toBe(400); // a person is not a kind
    expect((await write(onBound(hub, second, other))).status).toBe(400);
    const counterpart = await f.json<Written>(await write(onBound(kinds.counterpart, second, other)), 201);
    // A hub is one participant; a star definition with two hub slots is not admitted.
    const twoHubs = await f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', actingSubject: f.actor,
      expectedHead: null, state: { component: 'definition', kind: 'relation', notation: `bound-${randomUUID()}`,
        roles: roles.map(role => role.key === 'hub' ? { ...role, maxParticipants: 2 } : role),
        star: { leaf: 'variant', hub: 'hub' } } });
    expect(twoHubs.status).toBe(400);
    // Occurrences rely on the star: a revision keeps it.
    await f.grant(`semantic:edit:${bound.component}`, 'semantic.change');
    await f.grant(`semantic:read:${bound.component}`, 'semantic.read');
    const revise = (target: Changed & { notation: string }, state: object = {}) => f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, target: target.component, expectedHead: target.revision,
      state: { component: 'definition', kind: 'relation', notation: target.notation, roles, ...state } });
    const dropped = await revise(bound);
    expect([dropped.status, (await dropped.json() as { code: string }).code]).toEqual([400, 'invalid_semantic_change']);
    expect((await revise(bound, { star: { leaf: 'hub', hub: 'variant' } })).status).toBe(400);
    const kept = await f.json<Changed>(await revise(bound, { star: { leaf: 'variant', hub: 'hub' } }), 200);
    expect(kept.revision).not.toBe(bound.revision);
    expect(counterpart.occurrence).toBeTruthy();
    // With no occurrence to protect, the star may go.
    const fresh = await defineBound();
    await f.grant(`semantic:edit:${fresh.component}`, 'semantic.change');
    await f.grant(`semantic:read:${fresh.component}`, 'semantic.read');
    expect((await revise(fresh)).status).toBe(200);
  } finally { await f.close(); }
}, 600_000);
