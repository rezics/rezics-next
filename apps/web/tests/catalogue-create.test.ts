import { expect, test } from 'bun:test';
import { catalogueCreateFixture, catalogueCreatedId } from '../src/kernel/fake/catalogue-create';
import { initialTerms, type CreateSubjectCommand } from '../src/features/catalogue/create-subject';
import { createSubjectRecord, readCreatedSubject } from '../src/features/catalogue/create-subject-request';
import type { SessionEnv } from '../src/session/client';

const draft = () =>
  initialTerms('schema:Movie', [
    {
      language: 'en',
      label: 'A new film',
      description: 'An independent film',
      aliases: 'Working title\nFestival title',
    },
    { language: 'ja', label: '新しい映画', description: '', aliases: '' },
  ]);
const command = (): CreateSubjectCommand => ({ item: draft().item, key: crypto.randomUUID() });

function sessionRequest(csrf = 'AAAAAAAAAAAAAAAAAAAAAA') {
  return new Request('https://site.invalid/api', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.invalid',
      'X-CSRF-Token': csrf,
    },
  });
}
const sessionEnv = {
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

test('Create a real catalogue subject from an admitted Type through the existing API and reader with honest failure states', async () => {
  const fixture = catalogueCreateFixture();
  const definitions = await fixture.transport.definitions();
  expect(definitions.ok).toBe(true);
  if (!definitions.ok) throw new Error('Expected released Types');
  expect(definitions.types.some(({ id }) => id === 'schema:Movie')).toBe(true);
  expect(definitions.types.some(({ id }) => id === 'schema:Book')).toBe(true);
  expect(definitions.types.find(({ id }) => id === 'rezics:AnimeRelease')?.description).toContain('publication');
  expect(draft().errors).toEqual([]);
  const input = command();
  const result = await createSubjectRecord(fixture.client, sessionRequest(), sessionEnv, input, 'en');
  expect(result).toEqual({
    ok: true,
    id: catalogueCreatedId,
    reader: { state: 'ready', href: `/en/subjects/${catalogueCreatedId}/a-new-film` },
  });
  expect(fixture.calls).toEqual([
    {
      method: 'POST',
      path: '/v1/subjects',
      authorization: 'Bearer server-only',
      session: null,
      key: input.key,
      body: {
        type: 'schema:Movie',
        labels: { en: 'A new film', ja: '新しい映画' },
        descriptions: { en: 'An independent film' },
        aliases: { en: ['Working title', 'Festival title'] },
      },
    },
    {
      method: 'GET',
      path: `/v1/subjects/${catalogueCreatedId}`,
      authorization: null,
      session: 'created-session',
      key: null,
      body: null,
    },
  ]);
  // Native replay retains both request bytes and identity after delivery uncertainty.
  const uncertain = catalogueCreateFixture('uncertain');
  expect(await uncertain.transport.submit(input)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await uncertain.transport.submit(input)).toMatchObject({ ok: true, id: catalogueCreatedId });
  expect(uncertain.calls[0]?.body).toEqual(uncertain.calls[1]?.body);
  expect(uncertain.calls[0]?.key).toBe(uncertain.calls[1]?.key);
  expect(uncertain.receipts.size).toBe(1);
});

test('refused, invalid, conflicting, concealed and unreadable outcomes retain honest failure states without another write', async () => {
  const input = command();
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['signed-out', 'signed-out'],
    ['invalid', 'invalid'],
    ['conflict', 'conflict'],
  ] as const) {
    const fixture = catalogueCreateFixture(scenario);
    const result = await fixture.transport.submit(input);
    expect(result).toMatchObject({ ok: false, reason });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.receipts.size).toBe(0);
    if (scenario === 'invalid')
      expect(result).toMatchObject({ refreshDefinitions: true, errors: [{ pointer: '/labels/en' }] });
  }
  const csrf = catalogueCreateFixture();
  expect(await createSubjectRecord(csrf.client, sessionRequest('wrong'), sessionEnv, input, 'en')).toEqual({
    ok: false,
    reason: 'denied',
  });
  expect(csrf.calls).toHaveLength(0);
  expect(
    await createSubjectRecord(
      csrf.client,
      new Request('https://site.invalid/api', { method: 'POST' }),
      sessionEnv,
      input,
      'en',
    ),
  ).toEqual({ ok: false, reason: 'signed-out' });
  expect(csrf.calls).toHaveLength(0);
  const invalid = catalogueCreateFixture();
  const bad = initialTerms('schema:Movie', [
    { language: 'English', label: '', description: '', aliases: 'same\nsame' },
  ]);
  expect(bad.errors.some(({ pointer }) => pointer === '/labels/English')).toBe(true);
  expect(await invalid.transport.submit({ ...input, item: bad.item })).toMatchObject({ ok: false, reason: 'invalid' });
  expect(invalid.calls).toHaveLength(0);
  for (const [scenario, state] of [
    ['reader-unavailable', 'unavailable'],
    ['concealed', 'concealed'],
    ['mismatched', 'unavailable'],
  ] as const) {
    const fixture = catalogueCreateFixture(scenario);
    expect(await fixture.transport.submit(input)).toEqual({ ok: true, id: catalogueCreatedId, reader: { state } });
    fixture.setScenario('ready');
    expect(await readCreatedSubject(fixture.client, catalogueCreatedId, 'en')).toMatchObject({ state: 'ready' });
    expect(fixture.calls.filter(({ method }) => method === 'POST')).toHaveLength(1);
    expect(
      fixture.calls
        .filter(({ method }) => method === 'GET')
        .every(({ path, authorization }) => path === `/v1/subjects/${catalogueCreatedId}` && authorization === null),
    ).toBe(true);
  }
});

test('Creation corrections map only actual draft fields, including escaped and duplicate language rows', async () => {
  const { createSubjectControls } = await import('../src/features/catalogue/create-subject-guidance');
  const rows = [
    { language: ' en ', label: 'A film', description: '', aliases: '' },
    { language: 'ja', label: '映画', description: '', aliases: '' },
    { language: 'en', label: 'Another name', description: '', aliases: '' },
    { language: 'en/~', label: 'A name', description: '', aliases: '' },
  ];
  const control = createSubjectControls(rows);
  expect(control('/type')).toBe('create-type');
  expect(control('/labels')).toBe('create-label-0');
  expect(control('/labels/en')).toBe('create-language-2');
  expect(control('/descriptions/ja')).toBe('create-description-1');
  expect(control('/aliases/ja/31')).toBe('create-aliases-1');
  expect(control('/labels/en~1~0')).toBe('create-language-3');
  for (const pointer of [
    '',
    '/future',
    '/type/future',
    '/labels/fr',
    '/labels/ja/future',
    '/aliases/ja/not-an-index',
    '/statements/schema:duration/0/value',
  ])
    expect(control(pointer)).toBeUndefined();
  expect(createSubjectControls([])('/labels')).toBeUndefined();
  expect(rows[0]!.language).toBe(' en ');
});
