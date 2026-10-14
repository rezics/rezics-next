import { expect, test } from 'bun:test';
import { actingSubject, id, structure } from './fixtures.ts';
import { mainRecipeImportApi, RecipeImportError, RECIPE_FILE_MAX_BYTES,
  type RecipeImportRequest } from './import-api.ts';
import { englishMessages } from './messages.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

const revision = id(902);
const answer = { structure, revision, sourceObservation: id(903), residualDigest: 'a'.repeat(64), replayed: false, receipts: [id(904)] };
const input: RecipeImportRequest = { structure, expectedHead: id(901), actingSubject,
  idempotencyKey: 'recipe-file-import:test-1',
  file: new File(['{"@context":"https://schema.org","@type":"Recipe","recipeIngredient":["1 cup flour"]}'],
    'recipe.json', { type: 'application/ld+json' }) };

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('the file import sends the raw Schema.org file with its expected head and idempotency key', async () => {
  const sent: { url: URL; init: RequestInit }[] = [];
  const api = mainRecipeImportApi({ origin: 'https://web.rezics.test', pageUrl: 'https://web.rezics.test/en/recipe',
    fetch: async (url, init) => {
      sent.push({ url: new URL(String(url)), init: init! });
      return response(201, answer);
    } });

  await expect(api.importFile(input)).resolves.toEqual(answer);
  const request = sent[0]!;
  expect(request.url.pathname).toBe(`/api/main/v1/recipes/${structure.slice(-36)}/file-imports`);
  expect(request.url.searchParams.get('actingSubject')).toBe(actingSubject);
  expect(request.url.searchParams.get('expectedHead')).toBe(input.expectedHead);
  expect(request.init.method).toBe('POST');
  expect(request.init.body).toBe(input.file);
  const headers = new Headers(request.init.headers);
  expect(headers.get('content-type')).toBe('application/ld+json');
  expect(headers.get('idempotency-key')).toBe(input.idempotencyKey);
  expect(headers.get('x-rezics-page-url')).toBe('https://web.rezics.test/en/recipe');
});

test('a file larger than 256 KiB is refused before any request is sent', async () => {
  let sends = 0;
  const api = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async () => {
    sends++;
    return response(201, answer);
  } });
  const oversized = { ...input, file: new File([new Uint8Array(RECIPE_FILE_MAX_BYTES + 1)], 'large.json') };

  await expect(api.importFile(oversized)).rejects.toMatchObject({ failure: 'too-large' });
  expect(sends).toBe(0);
});

test('typed stale-head refusal is identified so the editor can refresh and ask again', async () => {
  const api = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async () => response(409, {
    code: 'recipe_conflict', detail: 'expected composition head is stale',
  }) });
  await expect(api.importFile(input)).rejects.toMatchObject({ failure: 'stale' });
});

test('typed file validation and access refusals keep their distinct outcomes', async () => {
  const invalid = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async () => response(422, {
    code: 'invalid_recipe_file', detail: 'Recipe file must use the fixed Schema.org context',
  }) });
  const denied = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async () => response(403, {
    code: 'authority_denied', title: 'Authority is not admitted',
  }) });
  const tooLarge = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async () => response(413, {
    code: 'recipe_file_too_large', detail: 'Recipe file exceeds 256 KiB',
  }) });
  const conflict = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async () => response(409, {
    code: 'recipe_conflict', detail: 'Recipe import exceeds the supported occurrence bound',
  }) });

  await expect(invalid.importFile(input)).rejects.toMatchObject({ failure: 'invalid',
    detail: 'Recipe file must use the fixed Schema.org context' });
  await expect(denied.importFile(input)).rejects.toMatchObject({ failure: 'denied' });
  await expect(tooLarge.importFile(input)).rejects.toBeInstanceOf(RecipeImportError);
  await expect(tooLarge.importFile(input)).rejects.toMatchObject({ failure: 'too-large', detail: 'Recipe file exceeds 256 KiB' });
  await expect(conflict.importFile(input)).rejects.toMatchObject({ failure: 'conflict',
    detail: 'Recipe import exceeds the supported occurrence bound' });
});

test('a lost response can be retried unchanged with the same idempotency key', async () => {
  const sent: { url: string; body: BodyInit | null; key: string | null }[] = [];
  const api = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async (url, init) => {
    sent.push({ url: String(url), body: init?.body ?? null, key: new Headers(init?.headers).get('idempotency-key') });
    if (sent.length === 1) throw new TypeError('connection lost after request');
    return response(200, { ...answer, replayed: true });
  } });

  await expect(api.importFile(input)).rejects.toMatchObject({ failure: 'unavailable' });
  await expect(api.importFile(input)).resolves.toMatchObject({ replayed: true, revision });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]?.key).toBe(input.idempotencyKey);
  expect(sent[0]?.body).toBe(input.file);
});

test('import controls are translated in all eight editor locales', () => {
  const catalogs = { en: englishMessages, de, es, fr, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };
  const keys = ['importAction', 'importing', 'importedRevision', 'importTooLarge', 'importInvalid',
    'importConflict', 'importDenied', 'importUnavailable', 'importStale', 'importStaleAction', 'importRefreshFailed',
    'importRefreshAction', 'importRefreshing'] as const;
  for (const catalog of Object.values(catalogs)) {
    for (const key of keys) expect(catalog[key]).toBeTruthy();
  }
});


test('only HTTP 202 is pending; retry retains the file, head, actor and command key', async () => {
  const sent: unknown[] = [];
  const api = mainRecipeImportApi({ origin: 'https://web.rezics.test', fetch: async (url, init) => {
    sent.push({ url: String(url), key: new Headers(init?.headers).get('idempotency-key'), body: init?.body });
    if (sent.length === 1) return response(202, { operationId: 'queued', status: 'reconciling', phase: 'dispatch',
      result: null, retry: { allowed: true, afterMs: 100 } });
    return response(200, { ...answer, replayed: true });
  } });
  await expect(api.importFile(input)).rejects.toMatchObject({ failure: 'pending' });
  await expect(api.importFile(input)).resolves.toMatchObject({ replayed: true });
  expect(sent[1]).toEqual(sent[0]);
  const malformed = mainRecipeImportApi({ fetch: async () => response(200, { operationId: 'unexpected' }) });
  await expect(malformed.importFile(input)).rejects.toMatchObject({ failure: 'unavailable' });
});
