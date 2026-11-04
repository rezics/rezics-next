import { expect, test } from 'bun:test';
import { createOwnClassificationClient } from '../src/ratings/own-classifications/native';
import { captureClassificationIntent } from '../src/ratings/own-classifications/intent';
import { accountId, associationId, classificationRow, classificationsPage, frontier, subjectId } from './own-classification-assessments-fixture';

function harness() {
  const calls: Request[] = [];
  let reply: () => Response = () => Response.json(classificationsPage());
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return reply();
  }) as typeof fetch;
  return {
    calls,
    reply: (next: () => Response) => { reply = next; },
    client: createOwnClassificationClient({ origin: 'https://kernel.test', authorization: 'Bearer original', accountId, csrfToken: 'csrf-original', locale: 'en', fetcher }),
  };
}

test('installed native receiver preserves selected frontier, original advice and same-key unknown retries', async () => {
  const h = harness();
  const client = await h.client;
  const selected = { cursor: ' raw +/=%opaque ', selected: { subjectId, associationId } };
  const read = await client.read(selected);
  expect(read.state).toBe('ready');
  if (read.state !== 'ready') throw new Error('Expected native page');
  const url = new URL(h.calls[0]!.url);
  expect(url.pathname).toBe('/v1/me/classification-assessments');
  expect(url.searchParams.get('cursor')).toBe(selected.cursor);
  expect(url.searchParams.get('selectedAssociationId')).toBe(associationId);
  expect(h.calls[0]!.headers.get('authorization')).toBe('Bearer original');
  expect(h.calls[0]!.headers.get('accept-language')).toBe('en');
  const intent = captureClassificationIntent(read, read.page.items[0]!, 'PUT', 'csrf-original', { assessment: 'oppose', falsePositive: false });
  h.reply(() => { throw new Error('acknowledgement lost'); });
  expect(await client.execute(intent)).toEqual({ kind: 'uncertain' });
  h.reply(() => Response.json({ associationId, revision: '2', delivery: 'enqueued' }));
  expect(await client.execute(intent)).toEqual({ kind: 'acknowledged' });
  const [first, retry] = h.calls.slice(1);
  expect(retry!.url).toBe(first!.url);
  expect(new URL(retry!.url).searchParams.get('expectedRevision')).toBe('1');
  expect([...retry!.headers]).toEqual([...first!.headers]);
  const serialized = await retry!.text();
  expect(serialized).toBe(await first!.text());
  expect(serialized).toBe(intent.serializedBody!);
  expect(retry!.headers.get('idempotency-key')).toBe(JSON.stringify(intent.key));
  expect(intent.path).toBe(classificationRow().actions.set!);
  expect(Object.isFrozen(intent.body)).toBe(true);
});

test('readback is separate, validates opposite and malformed states, and never acknowledges an intent', async () => {
  const h = harness();
  const client = await h.client;
  const read = await client.read(frontier);
  if (read.state !== 'ready') throw new Error('Expected page');
  const intent = captureClassificationIntent(read, read.page.items[0]!, 'DELETE', 'csrf-original');
  const current = { associationId, hasBallot: true, assessment: 'oppose', falsePositive: false, revision: '2', pending: false };
  h.reply(() => Response.json(current));
  expect(await client.review(intent)).toEqual({ kind: 'current', own: current });
  expect(h.calls.at(-1)!.method).toBe('GET');
  expect(new URL(h.calls.at(-1)!.url).search).toBe('');
  for (const bad of [{ ...current, associationId: subjectId }, { ...current, hasBallot: false }, { ...current, pending: 'current' }]) {
    h.reply(() => Response.json(bad));
    expect(await client.review(intent)).toEqual({ kind: 'unavailable' });
  }
  expect(intent.method).toBe('DELETE');
  expect(intent.precondition).toBe('1');
});

test('binding mismatch, read-only and withheld advice cannot manufacture set or withdrawal authority', async () => {
  const h = harness();
  const client = await h.client;
  const read = await client.read(frontier);
  if (read.state !== 'ready') throw new Error('Expected page');
  const row = read.page.items[0]!;
  const readonly = { ...row, actions: { state: 'read-only' as const, set: null, clear: null, readback: row.actions.readback } };
  expect(() => captureClassificationIntent(read, readonly, 'DELETE', 'csrf-original')).toThrow();
  const withheld = { ...row, state: 'withheld' as const, subject: null, target: null, association: null, aggregate: null, actions: { state: 'withheld' as const, set: null, clear: null, readback: null } };
  expect(() => captureClassificationIntent(read, withheld, 'DELETE', 'csrf-original')).toThrow();
  const withdrawal = { ...withheld, actions: { ...withheld.actions, state: 'withdraw-only' as const, clear: row.actions.clear } };
  const ownRead = { ...read, page: { ...read.page, items: [withdrawal] } };
  const intent = captureClassificationIntent(ownRead, withdrawal, 'DELETE', 'csrf-original');
  expect(await client.review(intent)).toEqual({ kind: 'unavailable' });
  expect(h.calls).toHaveLength(1);
  h.reply(() => new Response(null, { status: 204 }));
  expect(await client.execute(intent)).toEqual({ kind: 'acknowledged' });
  expect(h.calls.at(-1)!.method).toBe('DELETE');
  expect(() => captureClassificationIntent(ownRead, withdrawal, 'PUT', 'csrf-original', { assessment: 'support', falsePositive: false })).toThrow();
});

test('credential replacement, mismatched viewers and oversized native bodies remain closed', async () => {
  const h = harness();
  const client = await h.client;
  const read = await client.read(frontier);
  if (read.state !== 'ready') throw new Error('Expected page');
  const intent = captureClassificationIntent(read, read.page.items[0]!, 'DELETE', 'csrf-original');
  const other = await createOwnClassificationClient({ origin: 'https://kernel.test', authorization: 'Bearer replacement', accountId, csrfToken: 'csrf-original', locale: 'en' });
  expect(await other.execute(intent)).toEqual({ kind: 'stale' });
  h.reply(() => Response.json({ ...classificationsPage(), viewer: { accountId: subjectId } }));
  expect((await client.read(frontier)).state).toBe('unavailable');
  h.reply(() => new Response('x'.repeat(1_048_577)));
  expect((await client.read(frontier)).state).toBe('unavailable');
});
