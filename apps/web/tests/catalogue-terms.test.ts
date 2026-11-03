import { expect, test } from 'bun:test';
import { createKernelClient, type SubjectRead } from '@rezics/client';
import { catalogueTermsFixture, termsSubjectId } from '../src/kernel/fake/catalogue-terms';
import {
  isTermsCommand,
  languageDraft,
  patchedTerms,
  termsPatch,
  type TermsCommand,
  type TermsRead,
} from '../src/features/catalogue/subject-terms';
import {
  applyTermResolutions,
  partitionTermChanges,
  resolutionKey,
} from '../src/features/catalogue/subject-terms-resolution';
import { patchSubjectTerms, readSubjectTerms } from '../src/features/catalogue/subject-terms-request';
import type { SessionEnv } from '../src/session/client';

function ready(read: TermsRead) {
  if (read.state !== 'ready') throw new Error(`Expected ready, got ${read.state}`);
  return read.snapshot;
}
const request = (csrf = 'AAAAAAAAAAAAAAAAAAAAAA') =>
  new Request('https://site.invalid/api', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.invalid',
      'X-CSRF-Token': csrf,
    },
  });
const env = {
  AUTH_ISSUER: 'https://auth.invalid',
  API_RESOURCE: 'https://kernel.invalid',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'site',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({
        status: 'active',
        accessToken: 'server-only',
        subject: 'viewer',
        csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
      }),
    }),
  },
} as unknown as Partial<SessionEnv>;

test('an editor explicitly patches one language terms while preserving other languages and rereads the returned native subject with honest stale or denied states', async () => {
  const fixture = catalogueTermsFixture();
  const original = ready(await fixture.transport.read(termsSubjectId));
  const draft = languageDraft(original.subject, 'en');
  draft.labels = { mode: 'set', value: 'Corrected title' };
  draft.descriptions.mode = 'remove';
  const result = termsPatch(original.subject, { en: draft });
  expect(result.errors).toEqual([]);
  expect(result.patch).toEqual({ labels: { en: 'Corrected title' }, descriptions: { en: null } });
  const command: TermsCommand = {
    id: termsSubjectId,
    patch: result.patch,
    etag: original.etag,
    key: crypto.randomUUID(),
    session: original.session,
  };
  expect(await patchSubjectTerms(fixture.client, request('wrong'), env, command, 'en')).toEqual({
    ok: false,
    reason: 'denied',
  });
  expect(fixture.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  const saved = await patchSubjectTerms(fixture.client, request(), env, command, 'en');
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error('Expected saved terms');
  const current = ready(saved.reader);
  expect(current.subject.labels).toEqual({ en: 'Corrected title', ja: '元の映画' });
  expect(current.subject.descriptions).toEqual({ ja: '元の説明' });
  expect(current.subject.aliases).toEqual(original.subject.aliases);
  expect(current.etag).toBe('"8"');
  expect(current.href).toBe(`/en/subjects/${termsSubjectId}/corrected-title`);
  expect(fixture.calls.at(-2)).toMatchObject({
    method: 'PATCH',
    path: `/v1/subjects/${termsSubjectId}/terms`,
    authorization: 'Bearer server-only',
    etag: '"7"',
    key: command.key,
    body: result.patch,
  });
  expect(fixture.calls.at(-1)).toMatchObject({
    method: 'GET',
    path: `/v1/subjects/${termsSubjectId}`,
    session: 'terms-write',
  });

  // Blanks are invalid replacements. Only explicit removal deletes; the remaining labels are validated.
  draft.labels.value = '';
  expect(termsPatch(original.subject, { en: draft }).errors.length).toBeGreaterThan(0);
  const japanese = languageDraft(original.subject, 'ja');
  japanese.labels.mode = 'remove';
  draft.labels.mode = 'remove';
  expect(termsPatch(original.subject, { en: draft, ja: japanese }).errors).toContainEqual({
    pointer: '/labels',
    code: 'required',
  });
  const aliases = languageDraft(original.subject, 'en');
  aliases.aliases = { mode: 'set', value: 'Same\nSame' };
  expect(termsPatch(original.subject, { en: aliases }).errors.length).toBeGreaterThan(0);
  aliases.aliases.value = 'New alias';
  expect(termsPatch(original.subject, { en: aliases }).patch).toEqual({ aliases: { en: ['New alias'] } });
});

function nativeTermsFixture() {
  const subject = { ...catalogueTermsFixture().subject, revision: 9, labels: { en: 'Current native title' } };
  const current: SubjectRead = { subject, account: null, summary: null, related: {} };
  const replies = {
    write: {
      body: { subject: termsSubjectId, revision: 8 } as unknown,
      status: 200,
      headers: { etag: '"8"', 'rezics-session-token': 'native-terms-write' } as HeadersInit,
    },
    read: {
      body: current as unknown,
      status: 200,
      headers: { etag: '"9"', 'rezics-session-token': 'native-terms-read' } as HeadersInit,
    },
    failWrite: false,
  };
  const calls: Request[] = [];
  const client = createKernelClient('https://native-terms.test', {
    fetch: (async (input, init) => {
      const call = input instanceof Request ? input : new Request(String(input), init);
      calls.push(call.clone());
      if (call.method === 'PATCH' && replies.failWrite) throw new TypeError('Response lost');
      const reply = call.method === 'PATCH' ? replies.write : replies.read;
      return Response.json(reply.body, { status: reply.status, headers: reply.headers });
    }) as typeof fetch,
  });
  const command: TermsCommand = {
    id: termsSubjectId,
    key: crypto.randomUUID(),
    etag: '"7"',
    patch: { labels: { en: 'My draft' }, descriptions: { ja: null }, aliases: { en: [] } },
    session: 'prior-terms-session',
  };
  return { client, calls, replies, command, current };
}

test('An editor patches actual generated native terms with stable keys strong ETag and session-aware reread', async () => {
  const fixture = nativeTermsFixture();
  const { client, command, calls } = fixture;
  const result = await patchSubjectTerms(client, request(), env, command, 'en');
  expect(result).toMatchObject({ ok: true, id: termsSubjectId, revision: 8, session: 'native-terms-write' });
  if (!result.ok) throw new Error('Expected validated native terms result');
  const { id, type, revision, labels, descriptions, aliases } = fixture.current.subject;
  expect(ready(result.reader).subject).toEqual({ id, type, revision, labels, descriptions, aliases });
  expect(ready(result.reader).subject.labels.en).toBe('Current native title');
  expect(ready(result.reader).subject.revision).toBe(9);
  expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
    ['PATCH', `/v1/subjects/${termsSubjectId}/terms`],
    ['GET', `/v1/subjects/${termsSubjectId}`],
  ]);
  expect(await calls[0]!.json()).toEqual(command.patch);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer server-only');
  expect(calls[0]!.headers.get('if-match')).toBe('"7"');
  expect(calls[0]!.headers.get('idempotency-key')).toBe(command.key);
  expect(calls[0]!.headers.get('rezics-session-token')).toBe(command.session!);
  expect(calls[1]!.headers.get('rezics-session-token')).toBe('native-terms-write');
  expect(calls.every((call) => call.cache === 'no-store' && call.redirect === 'manual')).toBe(true);

  const fallback = nativeTermsFixture();
  fallback.replies.write.headers = { etag: '"8"' };
  await patchSubjectTerms(fallback.client, request(), env, fallback.command, 'en');
  expect(fallback.calls[1]!.headers.get('rezics-session-token')).toBe(fallback.command.session!);
});

test('native terms success requires the exact subject, positive revision and matching strong ETag before any reread', async () => {
  const invalid = [
    { body: { subject: crypto.randomUUID(), revision: 8 }, etag: '"8"' },
    { body: { subject: termsSubjectId, revision: 0 }, etag: '"0"' },
    { body: { subject: termsSubjectId, revision: 1.5 }, etag: '"1.5"' },
    { body: { subject: termsSubjectId, revision: '8' }, etag: '"8"' },
    { body: { subject: termsSubjectId, revision: 8, labels: { en: 'Forged preview' } }, etag: '"8"' },
    { body: { subject: termsSubjectId, revision: 8 }, etag: 'W/"8"' },
    { body: { subject: termsSubjectId, revision: 8 }, etag: '"9"' },
    { body: { subject: termsSubjectId, revision: 8 }, etag: '8' },
    { body: { subject: termsSubjectId, revision: 8 }, etag: '' },
    { body: null, etag: '"8"' },
  ];
  for (const reply of invalid) {
    const fixture = nativeTermsFixture();
    fixture.replies.write.body = reply.body;
    fixture.replies.write.headers = reply.etag ? { etag: reply.etag } : {};
    expect(await patchSubjectTerms(fixture.client, request(), env, fixture.command, 'en')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(fixture.calls).toHaveLength(1);
  }
  for (const etag of ['8', 'W/"8"', '"0"']) {
    const fixture = nativeTermsFixture();
    expect(await patchSubjectTerms(fixture.client, request(), env, { ...fixture.command, etag }, 'en')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(fixture.calls).toHaveLength(0);
  }
});

test('native terms refusals and replay never infer authority or current reading from a retained result', async () => {
  for (const [status, code, reason] of [
    [400, 'invalid_request', 'invalid'],
    [401, 'unauthorized', 'signed-out'],
    [403, 'derived_account_terms', 'denied'],
    [404, 'not_found', 'concealed'],
    [412, 'precondition_failed', 'stale'],
    [422, 'idempotency_conflict', 'conflict'],
    [422, 'remaining_label_required', 'invalid'],
    [503, 'overloaded', 'unavailable'],
  ] as const) {
    const fixture = nativeTermsFixture();
    fixture.replies.write.status = status;
    fixture.replies.write.body = { code };
    expect(await patchSubjectTerms(fixture.client, request(), env, fixture.command, 'en')).toEqual({
      ok: false,
      reason,
    });
    expect(fixture.calls).toHaveLength(1);
  }
  const uncertain = nativeTermsFixture();
  uncertain.replies.failWrite = true;
  expect(await patchSubjectTerms(uncertain.client, request(), env, uncertain.command, 'en')).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  uncertain.replies.failWrite = false;
  uncertain.replies.read.status = 404;
  uncertain.replies.read.body = { code: 'not_found' };
  const replayed = await patchSubjectTerms(uncertain.client, request(), env, uncertain.command, 'en');
  expect(replayed.ok && replayed.reader).toEqual({ state: 'concealed' });
  expect(await uncertain.calls[0]!.json()).toEqual(await uncertain.calls[1]!.json());
  for (const header of ['idempotency-key', 'if-match'])
    expect(uncertain.calls[0]!.headers.get(header)).toBe(uncertain.calls[1]!.headers.get(header));
  uncertain.replies.write.status = 403;
  uncertain.replies.write.body = { code: 'forbidden' };
  expect(await patchSubjectTerms(uncertain.client, request(), env, uncertain.command, 'en')).toEqual({
    ok: false,
    reason: 'denied',
  });
  expect(uncertain.calls).toHaveLength(4);

  for (const status of [302, 403, 404, 503]) {
    const fixture = nativeTermsFixture();
    fixture.replies.read.status = status;
    fixture.replies.read.body = status === 302 ? null : { code: 'unavailable' };
    if (status === 302) fixture.replies.read.headers = { location: `/v1/subjects/${crypto.randomUUID()}` };
    const saved = await patchSubjectTerms(fixture.client, request(), env, fixture.command, 'en');
    expect(saved.ok && saved.reader).toEqual({
      state: status === 403 ? 'denied' : status === 404 ? 'concealed' : 'unavailable',
    });
    expect(fixture.calls).toHaveLength(2);
  }
  const foreign = nativeTermsFixture();
  foreign.replies.read.body = { ...foreign.current, subject: { ...foreign.current.subject, id: crypto.randomUUID() } };
  expect(await readSubjectTerms(foreign.client, termsSubjectId, 'en')).toEqual({ state: 'unavailable' });
  const lagging = nativeTermsFixture();
  lagging.replies.read.body = { ...lagging.current, subject: { ...lagging.current.subject, revision: 7 } };
  lagging.replies.read.headers = { etag: '"7"' };
  const saved = await patchSubjectTerms(lagging.client, request(), env, lagging.command, 'en');
  expect(saved.ok && saved.reader).toEqual({ state: 'unavailable' });
  const signedOut = nativeTermsFixture();
  expect(
    await patchSubjectTerms(
      signedOut.client,
      new Request('https://site.invalid/api', { method: 'POST' }),
      {},
      signedOut.command,
      'en',
    ),
  ).toEqual({ ok: false, reason: 'signed-out' });
  expect(signedOut.calls).toHaveLength(0);
});

test('native term maps preserve kept languages and explicitly set or remove each field including empty alias arrays', () => {
  const original = catalogueTermsFixture().subject;
  const english = languageDraft(original, 'en');
  const japanese = languageDraft(original, 'ja');
  english.labels = { mode: 'set', value: 'New name' };
  japanese.descriptions.mode = 'remove';
  japanese.aliases = { mode: 'set', value: '新しい別名' };
  const { patch, errors } = termsPatch(original, { en: english, ja: japanese });
  expect(errors).toEqual([]);
  expect(patch).toEqual({ labels: { en: 'New name' }, descriptions: { ja: null }, aliases: { ja: ['新しい別名'] } });
  const next = patchedTerms(original, patch);
  expect(next.labels).toEqual({ en: 'New name', ja: original.labels.ja! });
  expect(next.descriptions).toEqual({ en: original.descriptions.en! });
  expect(next.aliases).toEqual({ en: original.aliases.en!, ja: ['新しい別名'] });
  expect(patchedTerms(original, { aliases: { en: [] } }).aliases).toEqual({ ja: original.aliases.ja! });
  expect(patchedTerms(original, { aliases: { en: null } }).aliases).toEqual({ ja: original.aliases.ja! });
  expect(isTermsCommand({ ...nativeTermsFixture().command, patch: { aliases: { en: [] } } })).toBe(true);
});

test('a stale terms edit retains every language draft for explicit comparison, while uncertain retry keeps its payload and key', async () => {
  const fixture = catalogueTermsFixture('stale');
  const original = ready(await fixture.transport.read(termsSubjectId));
  const drafts = { en: languageDraft(original.subject, 'en'), ja: languageDraft(original.subject, 'ja') };
  drafts.en.labels = { mode: 'set', value: 'My correction' };
  const command: TermsCommand = {
    id: termsSubjectId,
    patch: termsPatch(original.subject, drafts).patch,
    etag: original.etag,
    key: crypto.randomUUID(),
    session: original.session,
  };
  expect(await fixture.transport.submit(command)).toEqual({ ok: false, reason: 'stale' });
  const latest = ready(await fixture.transport.read(termsSubjectId, original.session));
  expect(latest.subject.labels.en).toBe('Another editor’s title');
  expect(latest.etag).toBe('"8"');
  expect(drafts.en.labels.value).toBe('My correction');
  expect(drafts.ja.labels.value).toBe('元の映画');
  expect(fixture.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  fixture.setScenario('uncertain');
  const confirmed: TermsCommand = {
    ...command,
    etag: latest.etag,
    patch: termsPatch(latest.subject, drafts).patch,
    key: crypto.randomUUID(),
  };
  expect(await fixture.transport.submit(confirmed)).toEqual({ ok: false, reason: 'unavailable' });
  const saved = await fixture.transport.submit(confirmed);
  expect(saved.ok).toBe(true);
  const patches = fixture.calls.filter((call) => call.method === 'PATCH');
  expect(patches.at(-1)).toMatchObject({ key: confirmed.key, etag: confirmed.etag, body: confirmed.patch });
  expect(patches.at(-2)).toMatchObject({ key: confirmed.key, etag: confirmed.etag, body: confirmed.patch });
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['conflict', 'conflict'],
    ['invalid', 'invalid'],
    ['write-concealed', 'concealed'],
  ] as const) {
    fixture.setScenario(scenario);
    expect(await fixture.transport.submit({ ...confirmed, key: crypto.randomUUID() })).toEqual({ ok: false, reason });
  }
  fixture.setScenario('reader-denied');
  const deniedReader = await fixture.transport.submit({ ...confirmed, key: crypto.randomUUID() });
  expect(deniedReader.ok && deniedReader.reader).toEqual({ state: 'denied' });
  fixture.setScenario('concealed');
  expect(await fixture.transport.read(termsSubjectId)).toEqual({ state: 'concealed' });
});

test('overlapping term fields require an explicit choice and omit unchanged languages from the resolved patch', () => {
  const original = catalogueTermsFixture().subject;
  const current = {
    ...original,
    labels: { ...original.labels, en: 'Another editor’s title', ja: '同時の題名' },
  };
  const intent = { labels: { en: 'My correction' }, descriptions: { en: null } };
  const changes = partitionTermChanges(original, current, intent);
  expect(changes.map((change) => [change.language, change.field, change.overlap])).toEqual([
    ['en', 'labels', true],
    ['en', 'descriptions', false],
    ['ja', 'labels', false],
  ]);
  expect(changes.find((change) => change.language === 'en' && change.field === 'labels')).toMatchObject({
    currentUnchanged: false,
    userUnchanged: false,
    sameResult: false,
  });
  expect(changes.find((change) => change.language === 'ja' && change.field === 'labels')).toMatchObject({
    currentUnchanged: false,
    userUnchanged: true,
    overlap: false,
  });
  const incomplete = applyTermResolutions(changes, current, {}, {});
  expect(incomplete.unresolved).toHaveLength(1);
  expect(incomplete.patch).toEqual({ descriptions: { en: null } });
  const resolved = applyTermResolutions(changes, current, { [resolutionKey('en', 'labels')]: 'draft' }, {});
  expect(resolved.unresolved).toEqual([]);
  expect(resolved.patch).toEqual({ labels: { en: 'My correction' }, descriptions: { en: null } });
  expect(resolved.omittedLanguages).toEqual(['ja']);
  expect(resolved.removals).toEqual([{ language: 'en', field: 'descriptions' }]);
  const kept = applyTermResolutions(changes, current, { [resolutionKey('en', 'labels')]: 'current' }, {});
  expect(kept.patch).toEqual({ descriptions: { en: null } });
  const replacement = applyTermResolutions(
    changes,
    current,
    { [resolutionKey('en', 'labels')]: 'replacement' },
    { [resolutionKey('en', 'labels')]: { mode: 'set', value: 'Replacement title' } },
  );
  expect(replacement.patch).toEqual({ labels: { en: 'Replacement title' }, descriptions: { en: null } });
  const blank = applyTermResolutions(
    changes,
    current,
    { [resolutionKey('en', 'labels')]: 'replacement' },
    { [resolutionKey('en', 'labels')]: { mode: 'set', value: '' } },
  );
  expect(blank.unresolved).toHaveLength(1);
});
