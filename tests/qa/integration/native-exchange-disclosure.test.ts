import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { personaSessions } from '../support/personas.ts';

async function json<T>(pending: Promise<Response>, status: number): Promise<T> {
  const response = await pending, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('native export and retained import status/resume conceal another Person\'s inputs like absent inputs', async () => {
  const sessions = await personaSessions('public');
  try {
    const owner = sessions.owner, stranger = sessions.stranger;
    const actingSubject = owner.actingSubject!;
    const work = await json<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Private native exchange', language: 'en',
      semanticTypes: ['https://schema.org/Book'], actingSubject,
    }), 201);
    const composition = await json<{ structure: string; revision: string }>(owner.main('POST', '/v1/compositions', {
      profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject,
    }), 201);
    const uploaded = await json<{ fileId: string }>(owner.main('POST', `/v1/recipes/file-imports?${new URLSearchParams({
      actingSubject, format: 'paprikarecipes', limit: '1',
    })}`, undefined, randomUUID(), { bytes: zipSync({ 'private.paprikarecipe': gzipSync(Buffer.from(JSON.stringify({
      uid: randomUUID(), name: 'A private import', ingredients: '1 cup water', directions: 'Boil.',
    }))) }), headers: { 'content-type': 'application/zip' } }), 200);
    const query = new URLSearchParams({ actingSubject: stranger.actingSubject! });
    const exportQuery = new URLSearchParams({ ...Object.fromEntries(query), revision: composition.revision });
    expect(await json(stranger.main('GET', `/v1/compositions/${composition.structure.slice(-36)}/export?${exportQuery}`), 404))
      .toEqual(await json(stranger.main('GET', `/v1/compositions/${randomUUID()}/export?${exportQuery}`), 404));
    expect(await json(stranger.main('GET', `/v1/recipes/file-imports/${uploaded.fileId}?${query}`), 404))
      .toEqual(await json(stranger.main('GET', `/v1/recipes/file-imports/${randomUUID()}?${query}`), 404));
    const resume = (fileId: string) => stranger.main('POST', `/v1/recipes/file-imports?${new URLSearchParams({
      ...Object.fromEntries(query), fileId,
    })}`, undefined, randomUUID());
    expect(await json(resume(uploaded.fileId), 404)).toEqual(await json(resume(randomUUID()), 404));
    const status = await json<{ completed: number; state: string }>(owner.main('GET',
      `/v1/recipes/file-imports/${uploaded.fileId}?${new URLSearchParams({ actingSubject })}`), 200);
    expect(status).toMatchObject({ completed: 1, state: 'completed' });
  } finally { await sessions.close(); }
}, 240_000);
