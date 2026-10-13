import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions } from '../support/personas.ts';

test('credited original accepts the actual current public Work basis', async () => {
  const started = performance.now();
  const sessions = await personaSessions('public');
  const author = sessions.owner;
  const requests: unknown[] = [];
  async function command<T>(method: string, path: string, body?: unknown, status = 200) {
    const key = method === 'POST' ? randomUUID() : undefined;
    const at = performance.now();
    const response = await author.main(method, path, body, key);
    const raw = await response.text();
    requests.push({ caller: author.accountId, actingSubject: author.actingSubject,
      method, path, body, idempotencyKey: key,
      elapsedMs: performance.now() - at, sinceStartMs: performance.now() - started,
      answer: { status: response.status, body: raw, etag: response.headers.get('etag') } });
    expect(response.status, `${method} ${path}: ${raw}`).toBe(status);
    return JSON.parse(raw) as T;
  }
  try {
    const work = await command<{ work: string; workRevision: string }>('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `Credited original ${randomUUID()}`, language: 'en',
      authoring: 'own-work', actingSubject: author.actingSubject,
    }, 201);
    const root = `/v1/works/${work.work.slice(-36)}`;
    const acting = `actingSubject=${encodeURIComponent(author.actingSubject!)}`;
    const current = await command<{ revision: string }>('GET', `${root}?${acting}`);
    const before = await command<{ items: { agent: string; role: string }[] }>('GET', `${root}/agent-credits?${acting}`);
    console.log('Original credit basis', JSON.stringify({ creationHead: work.workRevision,
      publicCurrentHead: current.revision, interveningCommands: [], nativeCredits: before.items }));
    const credit = await command<{ agent: string; role: string }>('POST', `${root}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
      agent: author.actingSubject, role: 'author', expectedWorkHead: current.revision,
      actingSubject: author.actingSubject,
    }, 201);
    expect(credit).toMatchObject({ agent: author.actingSubject, role: 'author' });
    const after = await command<{ items: { agent: string; role: string }[] }>('GET', `${root}/agent-credits?${acting}`);
    expect(after.items).toContainEqual(expect.objectContaining({ agent: author.actingSubject, role: 'author' }));
  } finally {
    console.log('Original credit qualification', JSON.stringify({ setupSeconds: sessions.elapsedSeconds,
      elapsedSeconds: (performance.now() - started) / 1000, requests }));
    await sessions.close();
  }
}, 180_000);
