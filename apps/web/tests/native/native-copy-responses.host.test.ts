import { expect, test } from 'bun:test';
import {
  assertCopyIsolation,
  assertCopyPaging,
  assertCopyPersonalFacts,
  assertCopyRetainedMeaning,
  assertCopyPrivateResponse,
  assertCopyResponseUnmodified,
  assertCopyRestored,
  assertCopyUndoCommand,
  assertNativeCopyResponses,
  captureCopyResponse,
  copyResponseHeaders,
  createNativeCopyResponsesFixture,
  nativeCopyScenarios,
  type CopyCommand,
  type CopyResponseExport,
  type NativeCopyManifest,
} from './native-copy-responses-fixture.ts';

// Host-only contract checks. These Response inputs are unit data, never native
// recordings. Controller integration invokes createNativeCopyResponsesFixture;
// that entry point verifies its actual positive/negative native response sequence.
const command = (overrides: Partial<CopyCommand> = {}): CopyCommand => ({
  method: 'GET', path: '/v1/copies/first?presentation=FULL', persona: 'alice', ...overrides,
});
const copy = (id = 'first', revision = 2) => ({
  id, subjectId: 'same-subject', kind: 'physical', status: 'owned', revision,
  location: 'Shelf', source: 'Gift', acquiredOn: '2024-02-29', disposedOn: null,
  note: 'Private long note. '.repeat(48),
});
async function capture(body: unknown, cmd = command(), status = 200, headers: Record<string, string> = {}) {
  return captureCopyResponse(cmd, new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  }));
}
function changed(exchange: CopyResponseExport): CopyResponseExport {
  return structuredClone(exchange);
}

test('the typed native entry point and closed Copies route scenarios are installed', () => {
  expect(typeof createNativeCopyResponsesFixture).toBe('function');
  for (const name of ['historicalAcceptedMeaning', 'expiredRestore', 'terminalRestore', 'noJsOperation'] as const)
    expect(nativeCopyScenarios[name][1]).toBe('alice');
  expect(() => assertNativeCopyResponses({} as NativeCopyManifest)).toThrow('native producer binding absent');
  expect(() => assertNativeCopyResponses({ evidence: 'native-api-responses' } as NativeCopyManifest)).toThrow('source-authored data is not native execution');
});

test('transport preserves exact body bytes, omission, private caching, Retry-After and only safe headers', async () => {
  const text = ' { "copy": {"id":"first", "kind":null}, "next":"opaque/+==" }\n';
  const response = await captureCopyResponse(command(), new Response(text, { status: 200, headers: {
    'cache-control': 'private, no-store', 'retry-after': '17', 'vary': 'Accept-Language',
    'set-cookie': 'secret-session', authorization: 'Bearer secret', 'x-signature': 'secret-signature',
  } }));
  assertCopyResponseUnmodified(response);
  expect(response.response.bodyText).toBe(text);
  expect(response.response.body).toEqual({ copy: { id: 'first', kind: null }, next: 'opaque/+==' });
  expect(response.response.body).not.toHaveProperty('copy.presentation');
  expect(response.response.headers).toEqual({ 'content-type': 'text/plain;charset=UTF-8', 'cache-control': 'private, no-store', 'retry-after': '17', vary: 'Accept-Language' });
  expect(Object.keys(response.response.headers).every((name) => (copyResponseHeaders as readonly string[]).includes(name))).toBe(true);
  expect(JSON.stringify(response)).not.toContain('secret');
  const unavailable = await capture({ code: 'dependency_unavailable' }, command(), 503, { 'retry-after': '3' });
  expect(unavailable.response.status).toBe(503);
  expect(unavailable.response.headers['retry-after']).toBe('3');
  assertCopyResponseUnmodified(unavailable);
});

test('added meaning, normalized bytes, changed input and detached command pairs are rejected', async () => {
  for (const mutate of [
    (value: CopyResponseExport) => { (value.response.body as Record<string, unknown>).presentation = { meaning: 'known' }; },
    (value: CopyResponseExport) => { value.response.bodyText += '\n'; },
    (value: CopyResponseExport) => { (value.command as { idempotencyKey?: string }).idempotencyKey = 'replacement'; },
    (value: CopyResponseExport) => { value.response.headers['retry-after'] = '0'; },
  ]) {
    const value = await capture({ copy: copy() });
    assertCopyResponseUnmodified(value);
    mutate(value);
    expect(() => assertCopyResponseUnmodified(value)).toThrow('changed or detached');
  }
  const cmd = command({ method: 'PATCH', input: { revision: 1, note: 'original' }, bodyText: '{"revision":1,"note":"original"}', idempotencyKey: 'original-key' });
  const value = await capture({ copy: copy() }, cmd);
  (cmd.input as { note: string }).note = 'mutated caller input';
  assertCopyResponseUnmodified(value);
  expect(value.command.input).toEqual({ revision: 1, note: 'original' });
  expect(() => assertCopyResponseUnmodified(changed(value))).toThrow('changed or detached');
});

test('independent holding edits and exact Undo keep identity, note, accepted kind and status', async () => {
  const first = await capture({ copy: copy() });
  const second = await capture({ copy: { ...copy('second'), note: 'Independent edited note' } });
  const sibling = await capture(second.response.body);
  assertCopyIsolation(first, second, sibling);
  const restored = await capture({ copy: copy('first', 4) });
  assertCopyRestored(first, restored);
  expect(() => assertCopyIsolation(first, first, first)).toThrow('merged by Subject');
  expect(() => assertCopyIsolation(first, second, restored)).toThrow('other holding changed');
  for (const field of ['id', 'subjectId', 'kind', 'status', 'location', 'source', 'acquiredOn', 'disposedOn', 'note']) {
    const wrong = await capture({ copy: { ...copy('first', 4), [field]: 'replacement' } });
    expect(() => assertCopyRestored(first, wrong)).toThrow(`Undo changed original ${field}`);
  }
  expect(() => assertCopyRestored(first, first)).toThrow('advance revision');
});

test('Undo uses the original receipt revision and holding, with its retained original command key', async () => {
  const remove = await capture(null, command({ method: 'DELETE', path: '/v1/copies/first?revision=2', idempotencyKey: 'delete-original' }), 204, {
    'library-copy-deletion-id': 'original-deletion', 'library-copy-deletion-revision': '3',
  });
  const restoreCommand = command({ method: 'POST', path: '/v1/copies/first:restore', input: { deletionId: 'original-deletion', revision: 3 }, bodyText: '{"deletionId":"original-deletion","revision":3}', idempotencyKey: 'restore-original' });
  const restore = await capture({ copy: copy('first', 4) }, restoreCommand);
  assertCopyResponseUnmodified(remove);
  assertCopyResponseUnmodified(restore);
  assertCopyUndoCommand(remove, restore);
  for (const input of [{ deletionId: 'new-deletion', revision: 3 }, { deletionId: 'original-deletion', revision: 4 }]) {
    const wrong = await capture({}, { ...restoreCommand, input, bodyText: JSON.stringify(input) });
    expect(() => assertCopyUndoCommand(remove, wrong)).toThrow('changed original removal intent');
  }
  expect(() => assertCopyUndoCommand(remove, { ...restore, command: { ...restore.command, path: '/v1/copies/second:restore' } })).toThrow('another holding');
  const noReceipt = await capture(null, remove.command, 204);
  expect(() => assertCopyUndoCommand(noReceipt, restore)).toThrow('receipt headers absent');
});

test('native cursor boundaries keep both holdings and a real final row, including opaque cursors', async () => {
  const cursor = 'opaque/+==';
  const first = await capture({ copies: [copy()], next: cursor }, command({ path: '/v1/copies?limit=1' }));
  const finalCommand = command({ path: `/v1/copies?limit=1&cursor=${encodeURIComponent(cursor)}` });
  const final = await capture({ copies: [copy('second')], next: null }, finalCommand);
  assertCopyPaging(first, final, ['first', 'second']);
  const empty = await capture({ copies: [], next: null }, finalCommand);
  expect(() => assertCopyPaging(first, empty, ['first', 'second'])).toThrow('constructed empty page');
  const duplicate = await capture({ copies: [copy()], next: null }, finalCommand);
  expect(() => assertCopyPaging(first, duplicate, ['first', 'second'])).toThrow('lost an independent holding');
  expect(() => assertCopyPaging(first, { ...final, command: command({ path: '/v1/copies?cursor=reconstructed' }) }, ['first', 'second'])).toThrow('next cursor changed');
});

test('other and anonymous responses cannot reveal the owner holdings or private notes', async () => {
  for (const persona of ['bob', 'anonymous'] as const) {
    const denied = await capture({ code: persona === 'bob' ? 'not_found' : 'authentication_required' }, command({ persona }), persona === 'bob' ? 404 : 401);
    assertCopyPrivateResponse(denied, ['owner-copy-id', 'owner-private-note']);
    for (const body of [{ copies: [{ id: 'owner-copy-id' }], next: null }, { note: 'owner-private-note' }]) {
      const leaked = await capture(body, command({ persona }));
      expect(() => assertCopyPrivateResponse(leaked, ['owner-copy-id', 'owner-private-note'])).toThrow('private facts disclosed');
    }
  }
});

test('retained accepted labels never come from current Advice and independent personal facts survive', async () => {
  const accepted = { meaning: 'known', kindLabel: 'Original physical', statusLabel: 'Original owned', statusEditing: { state: 'unavailable' } };
  const original = await capture({ copy: { ...copy(), presentation: accepted } });
  const restored = await capture({ copy: { ...copy('first', 4), presentation: accepted } });
  assertCopyRetainedMeaning(original, restored);
  const reconstructed = await capture({ copy: { ...copy('first', 4), presentation: { ...accepted, statusLabel: 'Current renamed status' } } });
  expect(() => assertCopyRetainedMeaning(original, reconstructed)).toThrow('reconstructed from current Advice');
  for (const body of [{ libraryEntry: { state: 'reading', revision: 1 } }, { progressSession: { amount: '37', revision: 2 } }]) {
    const before = await capture(body);
    assertCopyPersonalFacts(before, await capture(body));
    const lost = await capture({});
    expect(() => assertCopyPersonalFacts(before, lost)).toThrow('independent personal facts changed');
  }
});
