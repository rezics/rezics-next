import { expect, test } from 'bun:test';
import { catalogueTermsFixture, termsSubjectId } from '../src/kernel/fake/catalogue-terms';
import { languageDraft, termsPatch, type TermsCommand, type TermsRead } from '../src/features/catalogue/subject-terms';
import { patchSubjectTerms } from '../src/features/catalogue/subject-terms-request';
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
    ['unserved', 'unavailable'],
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
