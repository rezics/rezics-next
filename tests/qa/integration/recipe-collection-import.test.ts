import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import sharp from 'sharp';
import { personaSessions, type PersonaSessions, type PersonaSession } from '../support/personas.ts';
import type { RecipeCollectionOutcome } from '../../../services/main/src/modules/recipe/collection-import.ts';
import type { RecipeCollectionFormat } from '../../../services/main/src/modules/recipe/collection-file.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';
import type { DocumentSnapshot } from '@rezics/document';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions;
let image: string;
let ratingContext: string;
beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated integration QA');
  sessions = await personaSessions('public');
  image = (await sharp(randomBytes(640 * 480 * 3), { raw: { width: 640, height: 480, channels: 3 } })
    .png().toBuffer()).toString('base64');
  await grantPersonaFixtureAuthority(sessions.owner, [{ scope: GLOBAL_CONTEXT_SCOPE, action: 'rating.context.create' }]);
  ratingContext = (await json<{ context: string }>(sessions.owner.main('POST', '/v1/global-rating-contexts', {
    profile: 'global-rating-standing-context-v2', question: 'How much did you like this recipe?',
    scale: { min: 1, max: 5, step: 1 }, actingSubject: sessions.owner.actingSubject,
  }), 201)).context;
  await grantPersonaFixtureAuthority(sessions.owner, [
    { scope: `rating:observe:${ratingContext}`, action: 'rating.observation.set' },
  ]);
}, 240_000);
afterAll(async () => { await sessions?.close(); });

const short = (value: string) => value.slice(-36);
const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}
interface ImportedPage { items: Array<RecipeCollectionOutcome & { index: number; name: string }>;
  total: number; next: number | null; pending: boolean }
function source(format: RecipeCollectionFormat, identity = randomUUID()) {
  const paprika = format === 'paprikarecipes';
  const value = JSON.parse(readFileSync(new URL(paprika
    ? '../../fixtures/recipes/move-in.paprikarecipe.json' : '../../fixtures/recipes/move-in.melarecipe', import.meta.url), 'utf8'));
  value[paprika ? 'uid' : 'id'] = identity;
  value[paprika ? 'photo_data' : 'images'] = paprika ? image : [image];
  return value;
}
function file(format: RecipeCollectionFormat, value: object): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value));
  return format === 'paprikarecipes' ? zipSync({ 'recipe.paprikarecipe': gzipSync(bytes) })
    : format === 'melarecipes' ? zipSync({ 'recipe.melarecipe': bytes }) : bytes;
}
function upload(person: PersonaSession, bytes: Uint8Array, format: RecipeCollectionFormat,
  extra = '', actingSubject = person.actingSubject!) {
  return person.main('POST', `/v1/recipes/file-imports?actingSubject=${encodeURIComponent(actingSubject)}&format=${format}${extra}`,
    undefined, randomUUID(), { bytes, headers: { 'content-type': 'application/octet-stream' } });
}

for (const format of ['paprikarecipes', 'melarecipes', 'melarecipe'] as const) {
  test(`${format}: owner moves in a private recipe twice with exact facts, procedure, notes, source and photo`, async () => {
    const owner = sessions.owner, stranger = sessions.stranger;
    const original = source(format), bytes = file(format, original);
    const first = await json<ImportedPage>(upload(owner, bytes, format));
    expect(first).toMatchObject({ total: 1, next: null, pending: false });
    expect(first.items).toHaveLength(1);
    const imported = first.items[0]!;
    expect(imported).toMatchObject({ status: 'imported', replayed: false, losses: [] });
    expect(imported.kept).toContain('categories');
    expect(imported.kept).toContain('photos/0');
    if (format === 'paprikarecipes') {
      expect(imported.kept).toContain('rating');
      expect(imported.rating).toMatchObject({ status: 'native', context: ratingContext, value: 4,
        scale: { min: 1, max: 5, step: 1 } });
    } else {
      expect(imported.retainedOnly).toContain('rating');
      expect(imported.rating).toMatchObject({ status: 'retained', reason: 'unknown-source-scale' });
    }
    expect(imported.retainedOnly).toContain('future_field');
    expect(imported.photos[0]?.use).toBeTruthy();
    const twice = await json<ImportedPage>(upload(owner, bytes, format));
    expect(twice.items[0]).toEqual({ ...imported, replayed: true });
    const page = await json<{ occurrences: OccurrenceRecord[]; instructions: Array<{ status: string; document: DocumentSnapshot }> }>(
      owner.main('GET', `/v1/recipes/works/${short(imported.work)}?${query(owner)}`));
    const ingredients = page.occurrences.filter(row => row.role === 'ingredient');
    expect(ingredients).toHaveLength(7);
    expect(ingredients[0]!.qualifier).toMatchObject({ amount: { numerator: 1, denominator: 1 },
      amountUpper: { numerator: 2, denominator: 1 } });
    expect(ingredients[1]!.qualifier).toMatchObject({ amount: { numerator: 1, denominator: 2 } });
    expect(ingredients[2]!.qualifier).toMatchObject({ amount: { numerator: 2, denominator: 1 } });
    expect((ingredients[2]!.qualifier as { unitText?: string }).unitText).toBeUndefined();
    expect(ingredients[3]!.qualifier).toMatchObject({ originalText: { value: '200 克 牛奶', language: 'und' } });
    expect(page.occurrences.filter(row => row.role === 'step')).toHaveLength(0);
    expect(page.instructions).toHaveLength(1);
    expect(page.instructions[0]!.status).toBe('available');
    expect(JSON.stringify(page.instructions[0]!.document)).toContain('https://rezics.com/definition/procedure-v1');
    expect(JSON.stringify(page.instructions[0]!.document)).toContain(original.notes);
    expect(page.instructions[0]!.document.doc.content?.some(node => node.type === 'image')).toBe(true);
    const retained = await json<{ rawBytesBase64: string; rightsEvidence: { basis: string };
      coverage: { complete: boolean; omittedFields: string[] } }>(owner.main('GET',
      `/v1/sources/observations/${short(imported.sourceObservation)}`));
    expect(retained.coverage).toMatchObject({ complete: false, omittedFields: [format === 'paprikarecipes' ? 'photo_data' : 'images'] });
    expect(JSON.parse(Buffer.from(retained.rawBytesBase64, 'base64').toString())).toEqual(
      Object.fromEntries(Object.entries(original).filter(([key]) => !retained.coverage.omittedFields.includes(key))));
    expect(imported.sourceOmittedFields).toEqual(retained.coverage.omittedFields);
    expect(retained.rightsEvidence.basis).toBe('unknown');
    const content = await json<{ reference: { provenance: Record<string, unknown> } }>(owner.main('GET',
      `/v1/content-revisions/${imported.content.revisionId}?${query(owner)}`));
    expect(content.reference.provenance).toMatchObject({ kind: 'admitted-private-import-v1',
      transcriber: owner.actingSubject, rightsBasis: 'unknown', sourceObservation: imported.sourceObservation });
    expect(content.reference.provenance.author).toBeUndefined();
    const photo = imported.photos[0]!;
    const photoPath = `/v1/media/representations/${photo.representation}/bytes?use=${photo.use}`;
    const delivered = await owner.main('GET', `${photoPath}&${query(owner)}`);
    expect(delivered.status).toBe(200);
    expect(Buffer.from(await delivered.arrayBuffer()).toString('base64')).toBe(image);
    expect((await stranger.main('GET', `${photoPath}&${query(stranger)}`)).status).toBe(404);
    const library = await json<{ customShelves: Array<{ id: string; name: string }>;
      rating: { global: { value: number; scale: object } | null } }>(owner.main('GET',
      `/v1/works/${short(imported.work)}/reader-state?${query(owner)}`));
    if (format === 'paprikarecipes') expect(library.rating.global).toMatchObject({ value: 4, scale: { min: 1, max: 5, step: 1 } });
    expect(library.customShelves.map(shelf => shelf.name).sort()).toEqual(['Family', '汤']);
    for (const shelf of library.customShelves) {
      expect((await stranger.main('GET', `/v1/collections/${short(shelf.id)}?${query(stranger)}`)).status).toBe(404);
    }
    expect((await stranger.main('GET', `/v1/compositions/${short(imported.structure)}?${query(stranger)}`)).status).toBe(404);
    expect((await stranger.main('GET', `/v1/content-revisions/${imported.content.revisionId}?${query(stranger)}`)).status).toBe(404);
    expect((await stranger.main('GET', `/v1/sources/observations/${short(imported.sourceObservation)}`)).status).toBe(404);
    expect((await upload(stranger, bytes, format, '', owner.actingSubject!)).status).toBe(403);
    // The source identity is stable even when the caller uses another request key.
    // A changed export cannot overwrite the imported or subsequently edited recipe.
    const changed = { ...original, notes: 'A changed export must be reviewed.' };
    const conflict = await json<{ items: Array<{ status: string; reason: string }> }>(upload(owner, file(format, changed), format));
    expect(conflict.items[0]).toMatchObject({ status: 'failed', reason: 'source-changed' });
  });
}

test('a collection reports malformed recipes and continues to later entries', async () => {
  const original = source('melarecipes');
  const bytes = zipSync({ 'a-broken.melarecipe': Buffer.from('{'),
    'b-valid.melarecipe': Buffer.from(JSON.stringify(original)) });
  const first = await json<{ items: Array<{ status: string }>; next: number; total: number }>(
    upload(sessions.owner, bytes, 'melarecipes', '&limit=1'));
  expect(first).toMatchObject({ items: [{ status: 'failed' }], total: 2, next: 1 });
  const rest = await json<ImportedPage>(upload(sessions.owner, bytes, 'melarecipes', `&after=${first.next}&limit=1`));
  expect(rest.items[0]).toMatchObject({ status: 'imported', identity: original.id });
  expect(rest.next).toBeNull();
  const key = randomUUID(), path = `/v1/recipes/file-imports?${query(sessions.owner)}&format=melarecipes&after=1&limit=1`;
  const retry = () => sessions.owner.main('POST', path, undefined, key,
    { bytes, headers: { 'content-type': 'application/octet-stream' } });
  expect((await json<ImportedPage>(retry())).items[0]!.replayed).toBe(true);
  expect((await json<ImportedPage>(retry())).items[0]!.replayed).toBe(true);
  const changed = zipSync({ 'a-broken.melarecipe': Buffer.from('{'),
    'b-valid.melarecipe': Buffer.from(JSON.stringify({ ...original, notes: 'Changed intent' })) });
  expect((await sessions.owner.main('POST', path, undefined, key,
    { bytes: changed, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(409);
});
