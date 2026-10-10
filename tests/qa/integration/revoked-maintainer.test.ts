import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { memberFixture } from '../../../services/main/tests/member-reply-fixture.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

const idOf = (iri: string) => iri.slice(-36);

test('a co-maintainer removed while editing is refused, leaves the work unchanged, and can edit again once restored', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const h = await memberFixture();
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (h.env as typeof h.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  const read = async (path: string, authorization?: string) => {
    const response = await h.app.handle(new Request(`http://main.local${path}`, {
      headers: authorization ? { authorization: `Bearer ${authorization}` } : {},
    }));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  };
  try {
    const created = await h.post('/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', language: 'en',
      title: `Revoked editor ${randomUUID()}`, semanticTypes: ['https://schema.org/Recipe'],
      actingSubject: h.actor,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const work = created.body.work as string;
    const mainVersion = created.body.mainVersion as string;
    const members = await h.get(`/v1/works/${idOf(work)}/maintainers`);
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    expect(members.body.maintainers).toEqual([h.actor]);
    const added = await h.post('/v1/work-maintainer-changes', {
      profile: 'work-maintainer-change-v1', work, actingSubject: h.actor, target: h.pen,
      action: 'add', expectedGeneration: members.body.generation,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect([...(added.body.maintainers as string[])].sort()).toEqual([h.actor, h.pen].sort());

    const composition = await h.post('/v1/compositions', {
      profile: 'recipe-composition', work, mainVersion, actingSubject: h.pen,
    });
    expect(composition.status, JSON.stringify(composition.body)).toBe(201);
    const structure = composition.body.structure as string;
    const line = (sourceKey: string, text: string) => ({
      op: 'insert', parent: structure, position: 'last', role: 'ingredient', sourceKey,
      qualifier: { type: 'ingredient-line', originalText: { value: text, language: 'en' },
        amountLexical: text, optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial' },
    });
    const saved = await h.post(`/v1/compositions/${idOf(structure)}/changes`, {
      profile: 'recipe-composition', expectedHead: composition.body.revision, actingSubject: h.pen,
      operations: [line('salt', '1 pinch salt')],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const revision = saved.body.revision as string;

    const blocked = await h.post('/v1/work-maintainer-changes', {
      profile: 'work-maintainer-change-v1', work, actingSubject: h.pen, target: h.actor,
      action: 'remove', expectedGeneration: added.body.generation,
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(403);
    expect(blocked.body.code).toBe('authority_denied');
    const still = await h.get(`/v1/works/${idOf(work)}/maintainers`);
    expect([...(still.body.maintainers as string[])].sort()).toEqual([h.actor, h.pen].sort());

    const removed = await h.post('/v1/work-maintainer-changes', {
      profile: 'work-maintainer-change-v1', work, actingSubject: h.actor, target: h.pen,
      action: 'remove', expectedGeneration: added.body.generation,
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect(removed.body.maintainers).toEqual([h.actor]);

    const refused = await h.post(`/v1/compositions/${idOf(structure)}/changes`, {
      profile: 'recipe-composition', expectedHead: revision, actingSubject: h.pen,
      operations: [line('pepper', '1 pinch pepper')],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('authority_denied');
    const held = await h.get(`/v1/compositions/${idOf(structure)}?actingSubject=${encodeURIComponent(h.actor)}`);
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body.revision).toBe(revision);

    const asPen = await read(`/v1/compositions/${idOf(structure)}?actingSubject=${encodeURIComponent(h.pen)}`, h.token);
    const asReader = await read(`/v1/compositions/${idOf(structure)}`);
    expect(asPen.status, JSON.stringify({ asPen, asReader })).toBe(asReader.status);
    expect(asPen.body.code).toBe(asReader.body.code);
    const workAsPen = await read(`/v1/works/${idOf(work)}?actingSubject=${encodeURIComponent(h.pen)}`, h.token);
    const workAsReader = await read(`/v1/works/${idOf(work)}`);
    expect(workAsPen.status, JSON.stringify({ workAsPen, workAsReader })).toBe(workAsReader.status);
    expect(workAsPen.body.code).toBe(workAsReader.body.code);

    const restored = await h.post('/v1/work-maintainer-changes', {
      profile: 'work-maintainer-change-v1', work, actingSubject: h.actor, target: h.pen,
      action: 'add', expectedGeneration: removed.body.generation,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(201);
    const again = await h.post(`/v1/compositions/${idOf(structure)}/changes`, {
      profile: 'recipe-composition', expectedHead: revision, actingSubject: h.pen,
      operations: [line('pepper', '1 pinch pepper')],
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.revision).not.toBe(revision);
  } finally { await h.close(); }
}, 240_000);
