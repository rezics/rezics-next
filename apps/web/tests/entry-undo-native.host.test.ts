import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { startNativeWebStack, type NativeWebStack } from './native/stack';
import { createLibraryEntry } from './native/library-navigation-fixture';
import {
  changePersonalLibraryEntry,
  removePersonalLibraryEntry,
  restorePersonalLibraryEntry,
} from '../src/library/entries-read';
import { libraryEntryFormResponse } from '../src/library/entry-form';

let stack: NativeWebStack;
beforeAll(async () => {
  stack = await startNativeWebStack();
}, 360_000);
afterAll(async () => {
  await stack?.stop();
}, 180_000);

test('mounted native parser preserves exact removal receipts, uncertain commands and newer slots', async () => {
  const owner = await stack.authPersona('alice');
  const subject = await createLibraryEntry(stack, 'alice', owner.authorization);
  const path = `/v1/libraryEntries/${subject.id}`;
  const request = new Request('https://rezics.test/library/entry', { headers: { authorization: owner.authorization } });
  const sent: Request[] = [];
  let lose: string | undefined;
  let receipt: Headers | undefined;
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input, init) => {
      const call = new Request(input, init);
      sent.push(call.clone());
      const url = new URL(call.url);
      const response = await stack.kernel(url.pathname + url.search, {
        method: call.method,
        headers: call.headers,
        ...(call.method === 'GET' || call.method === 'DELETE' ? {} : { body: await call.text() }),
      });
      if (call.method === 'DELETE' && response.status === 204) {
        receipt = new Headers(response.headers);
        expect(await response.clone().text()).toBe('');
      }
      if (lose === call.method && response.ok) {
        lose = undefined;
        throw new TypeError('Lost acknowledgement');
      }
      return response;
    }) as typeof fetch,
  });
  const read = async () => {
    const response = await stack.kernel(path + '?view=FULL&presentation=FULL', { headers: request.headers });
    expect(response.status).toBe(200);
    return (await response.json()).libraryEntry;
  };
  const post = (path: string, body: unknown) =>
    stack.kernel(path, {
      method: 'POST',
      headers: {
        ...Object.fromEntries(request.headers),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify(body),
    });
  expect(
    (
      await stack.kernel(
        '/v1/platform/exposure/reading_progress:open',
        {
          method: 'POST',
          headers: { 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        },
        'governor',
      )
    ).status,
  ).toBe(200);
  expect(
    (await post('/v1/copies', { subjectId: subject.id, kind: 'physical', status: 'owned', note: 'Independent copy' }))
      .status,
  ).toBe(201);
  const progress = await post('/v1/progressSessions', {
    subjectId: subject.id,
    mode: 'scalar_amount',
    unit: 'page',
    total: '300',
  });
  expect(progress.status).toBe(201);
  const independent = async () =>
    Promise.all(
      ['/v1/copies', '/v1/progressSessions'].map(async (path) => {
        const response = await stack.kernel(`${path}?subjectId=${subject.id}&view=FULL`, { headers: request.headers });
        expect(response.status).toBe(200);
        return response.json();
      }),
    );
  const facts = await independent();
  const initial = await read();
  const changed = await changePersonalLibraryEntry(
    client,
    request,
    {},
    {
      subjectId: subject.id,
      state: initial.state,
      revision: initial.revision,
      incarnationId: initial.incarnationId,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(changed.ok).toBe(true);
  const current = await read();
  const command = {
    subjectId: subject.id,
    revision: current.revision,
    incarnationId: current.incarnationId,
    idempotencyKey: crypto.randomUUID(),
  };
  lose = 'DELETE';
  expect(await removePersonalLibraryEntry(client, request, {}, command)).toEqual({ ok: false, reason: 'unavailable' });
  const deleted = new Headers(receipt);
  expect((await stack.kernel(path, { headers: request.headers })).status).toBe(404);
  // A replacement cannot be deleted by an uncertain command, even when its revision restarts.
  const refill = await changePersonalLibraryEntry(
    client,
    request,
    {},
    {
      subjectId: subject.id,
      state: initial.state,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  expect(refill.ok).toBe(true);
  const replacement = await read();
  const recovered = await removePersonalLibraryEntry(client, request, {}, command);
  expect(recovered.ok && recovered.undo).toMatchObject({
    deletionId: deleted.get('Library-Entry-Deletion-Id'),
    revision: Number(deleted.get('Library-Entry-Deletion-Revision')),
  });
  expect(await read()).toEqual(replacement);
  if (!recovered.ok || !recovered.undo) throw new Error('Missing native receipt');
  const undo = { subjectId: subject.id, ...recovered.undo, idempotencyKey: recovered.undo.idempotencyKey! };
  expect(undo.idempotencyKey).not.toBe(command.idempotencyKey);
  expect(await restorePersonalLibraryEntry(client, request, {}, undo)).toMatchObject({ ok: false, reason: 'occupied' });
  expect(await read()).toEqual(replacement);
  const removed = await removePersonalLibraryEntry(
    client,
    request,
    {},
    {
      subjectId: subject.id,
      revision: replacement.revision,
      incarnationId: replacement.incarnationId,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  if (!removed.ok || !removed.undo) throw new Error('Missing replacement receipt');
  const restore = { subjectId: subject.id, ...removed.undo, idempotencyKey: removed.undo.idempotencyKey! };
  lose = 'POST';
  expect(await restorePersonalLibraryEntry(client, request, {}, restore)).toEqual({ ok: false, reason: 'unavailable' });
  const committed = await read();
  const before = sent.length;
  expect(await restorePersonalLibraryEntry(client, request, {}, restore)).toMatchObject({
    ok: true,
    entry: { revision: committed.revision, incarnationId: committed.incarnationId },
  });
  expect(sent.slice(before).map((call) => call.method)).toEqual(['POST']);
  expect(await read()).toEqual(committed);
  expect(await independent()).toEqual(facts);
  const deletes = sent.filter((call) => call.method === 'DELETE');
  expect(deletes[0]!.url).toBe(deletes[1]!.url);
  expect(deletes[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.idempotencyKey));
  expect(deletes[1]!.headers.get('idempotency-key')).toBe(deletes[0]!.headers.get('idempotency-key'));
  const posts = sent.filter((call) => call.method === 'POST');
  expect(posts.at(-1)!.headers.get('idempotency-key')).toBe(posts.at(-2)!.headers.get('idempotency-key'));
  expect(await posts.at(-1)!.json()).toEqual(await posts.at(-2)!.json());
  // A script-free POST receives the installed empty-204 headers and keeps its exact return.
  const returnTo = '/en/library?type=schema%3ABook&cursor=original%2Bnext';
  const submit = (body: URLSearchParams) =>
    libraryEntryFormResponse(new Request(request.url, { method: 'POST', headers: request.headers, body }), {}, client);
  const response = await submit(
    new URLSearchParams({
      intent: 'remove',
      subjectId: subject.id,
      revision: String(committed.revision),
      incarnationId: committed.incarnationId,
      idempotencyKey: crypto.randomUUID(),
      locale: 'en',
      returnTo,
    }),
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain('<script');
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g))
    fields.set(match[1]!, match[2]!.replaceAll('&amp;', '&'));
  expect(fields.get('deletionId')).toBe(receipt!.get('Library-Entry-Deletion-Id'));
  expect(fields.get('returnTo')).toBe(returnTo);
  const restoredHtml = await (await submit(fields)).text();
  expect(restoredHtml).toContain('data-restored-entry');
  expect(restoredHtml).toContain(`data-entry-revision="${(await read()).revision}"`);
  expect(await independent()).toEqual(facts);
}, 180_000);
