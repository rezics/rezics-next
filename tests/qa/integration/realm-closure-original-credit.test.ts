import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions, type PersonaSession } from '../support/personas.ts';
import { closureCommand, closureOriginal } from './outcomes/realm/closure-fixture.ts';

type Credit = { id: string; agent: string; role: string };
type Evidence = {
  caller: string | null; actingSubject: string | null;
  method: string; path: string; body?: unknown; idempotencyKey?: string;
  elapsedMs: number; sinceStartMs: number;
  answer: { status: number; body: string; etag: string | null };
};

test('own-work originals retain native author credit and new credits fence the actual Work head', async () => {
  const started = performance.now();
  const sessions = await personaSessions('public');
  const author = sessions.owner;
  const requests: Evidence[] = [];
  const record = (person: PersonaSession) => {
    const call = person.main;
    person.main = async (method, path, body, key, options) => {
      // Retain the exact command key without changing persona credentials.
      const idempotencyKey = key ?? (method === 'POST' ? randomUUID() : undefined);
      const at = performance.now();
      const response = await call(method, path, body, idempotencyKey, options);
      requests.push({ caller: person.accountId, actingSubject: person.actingSubject,
        method, path, body, idempotencyKey,
        elapsedMs: performance.now() - at, sinceStartMs: performance.now() - started,
        answer: { status: response.status, body: await response.clone().text(), etag: response.headers.get('etag') } });
      return response;
    };
  };
  record(author);
  record(sessions.visitor);
  try {
    const original = await closureOriginal(author, `Credited original ${randomUUID()}`);
    const root = `/v1/works/${original.work.slice(-36)}`;
    const acting = `actingSubject=${encodeURIComponent(author.actingSubject!)}`;
    const creation = requests.find(request => request.method === 'POST' && request.path === '/v1/works')!;
    const supplied = requests.find(request => request.method === 'GET'
      && request.path === `${root}/agent-credits?${acting}`)!;
    expect(creation.answer.status).toBe(201);
    expect(JSON.parse(creation.answer.body)).toMatchObject({ work: original.work, workRevision: original.workRevision });
    const initial = JSON.parse(supplied.answer.body) as { items: Credit[] };
    expect(initial.items).toHaveLength(1);
    const authorCredit = initial.items[0]!;
    expect(authorCredit).toMatchObject({ agent: author.actingSubject, role: 'author' });
    expect(authorCredit.id).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
    const published = await closureCommand<{ revision: string; disclosure: string }>(sessions.visitor, 'GET', root);
    expect(published.disclosure).toBe('public');
    const inventory = () => closureCommand<{ items: Credit[] }>(sessions.visitor, 'GET', `${root}/agent-credits`);
    expect((await inventory()).items).toEqual(initial.items);

    const current = await closureCommand<{ revision: string }>(author, 'GET', `${root}?${acting}`);
    expect(current.revision).toBe(published.revision);
    const changed = await closureCommand<{ revision: string; predecessor: string }>(author,
      'POST', `${root}/scalar-value`, { profile: 'work-scalar-state-v1', expectedHead: current.revision,
        scalarValue: { kind: 'integer', lexical: '0' }, actingSubject: author.actingSubject });
    expect(changed.predecessor).toBe(current.revision);
    expect(changed.revision).not.toBe(current.revision);
    const latest = await closureCommand<{ revision: string }>(sessions.visitor, 'GET', root);
    expect(latest.revision).toBe(changed.revision);

    // This tuple is absent before both commands. Only the publicly observed
    // head changes; a duplicate tuple cannot explain the stale refusal.
    const credit = `https://rezics.com/id/${randomUUID()}`;
    const input = { profile: 'native-agent-credit-v1', credit, agent: author.actingSubject,
      role: 'editor', actingSubject: author.actingSubject };
    expect((await inventory()).items).toEqual(initial.items);
    const stale = await closureCommand<{ code: string }>(author, 'POST', `${root}/agent-credits`,
      { ...input, expectedWorkHead: current.revision }, 409, randomUUID());
    expect(stale.code).toBe('read_basis_changed');
    expect((await inventory()).items).toEqual(initial.items);
    const accepted = await closureCommand<{ credit: string; work: string; agent: string; role: string; replayed: boolean }>(author,
      'POST', `${root}/agent-credits`, { ...input, expectedWorkHead: latest.revision }, 201, randomUUID());
    expect(accepted).toMatchObject({ credit, work: original.work, agent: author.actingSubject, role: 'editor', replayed: false });
    const final = (await inventory()).items;
    expect(final).toHaveLength(2);
    expect(final).toContainEqual(authorCredit);
    expect(final).toContainEqual(expect.objectContaining({ id: credit, agent: author.actingSubject, role: 'editor' }));
  } finally {
    console.log('Original credit regression', JSON.stringify({ setupSeconds: sessions.elapsedSeconds,
      elapsedSeconds: (performance.now() - started) / 1000, requests }));
    await sessions.close();
  }
}, 180_000);
