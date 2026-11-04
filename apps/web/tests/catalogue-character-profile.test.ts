import { expect, mock, test } from 'bun:test';
import { createElement as h } from 'react';
import * as start from '../.storybook/react-start';
import { allowedCreateAuthority, type CreateAuthority } from '../src/features/catalogue/identity-intake';
import type { CharacterCommand, CharacterTransport } from '../src/features/catalogue/character-profile';
import type { CreateResult, CreatedReader } from '../src/features/catalogue/create-subject';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
import {
  characterProfileFixture,
  characterCreatedId,
  characterProfileId,
} from '../src/kernel/fake/catalogue-character-profile';
import {
  characterDraft,
  characterGroups,
  characterRelations,
  characterType,
  characterWorkDefinitions,
  characterWorkFields,
  filterCharacterWorks,
  isCurrentCharacterRead,
  validateCharacter,
} from '../src/features/catalogue/character-profile';
import { readCreatedSubject } from '../src/features/catalogue/create-subject-request';
import { relationActor, relationRole } from '../src/kernel/fake/catalogue-relations';
import { factChanged, sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { characterFacts } from '../src/features/catalogue/character-profile';
import { readDirectoryDescriptor, readTypeDescriptor } from '../src/features/catalogue/type-directory-client';

test('shared display descriptors retain nullable languages and hints without certifying work admission', async () => {
  const fixture = characterProfileFixture();
  const descriptor = {
    typeId: characterType,
    label: 'Character',
    language: null,
    description: null,
    descriptionLanguage: null,
    definition: { listPresentation: { imageAspect: 'portrait', keyFacts: [] } },
  };
  fixture.descriptorResponses.set(characterType, { status: 200, body: descriptor });
  expect(await readDirectoryDescriptor(fixture.client, characterType, 'en')).toEqual({ ok: true, descriptor });
  expect(await readTypeDescriptor(fixture.client, characterType, 'en')).toEqual({ ok: false, reason: 'unavailable' });
});

test('retained Character reads are disclosed only for a settled successful exact-address match', async () => {
  const fixture = characterProfileFixture();
  const read = await fixture.transport.load({ id: characterProfileId });
  if (!read.ok) throw new Error('Expected Character');
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: false }, { id: characterProfileId })).toBe(true);
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: true }, { id: characterProfileId })).toBe(false);
  expect(isCurrentCharacterRead(read, { isSuccess: false, isFetching: false }, { id: characterProfileId })).toBe(false);
  expect(isCurrentCharacterRead(read, { isSuccess: true, isFetching: false }, { id: characterCreatedId })).toBe(false);
  expect(
    isCurrentCharacterRead(
      read,
      { isSuccess: true, isFetching: false },
      { id: characterProfileId, work: characterCreatedId },
    ),
  ).toBe(false);
});

test('selected-work eligibility uses the exact current Type from another release and bounds picker reads', async () => {
  const fixture = characterProfileFixture();
  const type = 'example:AnotherWork';
  const original = fixture.work.publicRead.subject.type;
  const definition = fixture.release.types[original]!;
  fixture.work.publicRead.subject.type = type;
  const descriptor = {
    typeId: type,
    releaseDigest: `sha256:${'b'.repeat(64)}`,
    label: 'Another work',
    language: 'en',
    description: null,
    descriptionLanguage: null,
    definition,
    properties: Object.fromEntries(definition.properties.map((id) => [id, fixture.release.properties[id]!])),
  };
  fixture.descriptorResponses.set(type, { status: 200, body: descriptor });
  const read = await fixture.transport.load({ id: characterProfileId, work: fixture.work.id });
  if (!read.ok) throw new Error('Expected a work from another active release');
  expect(read.workDescriptor).toEqual(descriptor);
  expect(read.work?.subject.release).toBe(fixture.work.publicRead.subject.release);
  expect(characterWorkFields(characterWorkDefinitions(descriptor), type)).toContain('wdt:P725');
  expect(read.release.types[type]).toBeUndefined();
  const entries = Array.from({ length: 12 }, (_, id) => ({ id, types: [type] }));
  const start = fixture.calls.length;
  expect(await filterCharacterWorks(entries, fixture.transport.workType!, new AbortController().signal)).toEqual(
    entries.slice(0, 8),
  );
  expect(fixture.calls.slice(start).map((call) => call.path)).toEqual([
    `/v1/definitionTypes/${encodeURIComponent(type)}`,
  ]);
});

test('failed and mismatched descriptors conceal retained reads and recover at the same selected address', async () => {
  const fixture = characterProfileFixture();
  const address = { id: characterProfileId, work: fixture.work.id };
  const retained = await fixture.transport.load(address);
  if (!retained.ok || !retained.workDescriptor) throw new Error('Expected selected work');
  const draft = characterDraft(
    retained.release,
    [{ language: 'en', label: 'Retained traveler', description: '', aliases: '' }],
    [],
  );
  const command = { item: draft.item, key: crypto.randomUUID() };
  const exact = structuredClone(command);
  const type = retained.workDescriptor.typeId;
  for (const response of [
    { status: 503, body: {} },
    { status: 200, body: { ...retained.workDescriptor, typeId: characterType } },
  ]) {
    fixture.descriptorResponses.set(type, response);
    expect(await fixture.transport.load(address)).toEqual({ ok: false, reason: 'unavailable' });
    expect(isCurrentCharacterRead(retained, { isSuccess: false, isFetching: false }, address)).toBe(false);
    await expect(
      filterCharacterWorks([{ types: [type] }], fixture.transport.workType!, new AbortController().signal),
    ).rejects.toThrow();
    expect(command).toEqual(exact);
  }
  fixture.descriptorResponses.set(type, { status: 404, body: {} });
  expect(await fixture.transport.load(address)).toEqual({ ok: false, reason: 'invalid' });
  fixture.descriptorResponses.delete(type);
  const recovered = await fixture.transport.load(address);
  expect(isCurrentCharacterRead(recovered, { isSuccess: true, isFetching: false }, address)).toBe(true);
  expect(command).toEqual(exact);
});

test('Character identity and credit editor uses actual released metadata native writes and current reader without fabricated grain or authority', async () => {
  const fixture = characterProfileFixture();
  const read = await fixture.transport.load({ work: fixture.work.id });
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('Expected current release');
  expect(read.character).toBeNull();
  expect(read.work?.subject.id).toBe(fixture.work.id);
  expect(characterGroups(read.release).traits).toContain('schema:gender');
  expect(characterGroups(read.release).measurements).toContain('schema:height');
  const draft = characterDraft(
    read.release,
    [
      { language: 'en', label: 'A new traveler', description: '', aliases: '' },
      { language: 'ja', label: '新しい旅人', description: '', aliases: '旅人' },
    ],
    [
      {
        property: { id: 'schema:height' },
        value: { type: 'value', content: { amount: '+168', unit: 'http://www.wikidata.org/entity/Q174728' } },
        qualifiers: [],
        references: [],
        rank: 'normal',
      },
    ],
  );
  expect(draft.errors).toEqual([]);
  expect(draft.item.type).toBe(characterType);
  expect(Object.keys(draft.item.statements)).toEqual(['schema:height']);
  const command = { item: draft.item, key: crypto.randomUUID() };
  const result = await fixture.transport.create(command);
  expect(result).toMatchObject({ ok: true, id: characterCreatedId, reader: { state: 'ready' } });
  const write = fixture.calls.find((call) => call.method === 'POST');
  expect(write).toEqual({ method: 'POST', path: '/v1/subjects', key: command.key, body: draft.item });
  expect(fixture.calls.at(-1)?.path).toBe(`/v1/subjects/${characterCreatedId}`);
  expect(draft.item).not.toHaveProperty('source');
  expect(draft.item.statements).not.toHaveProperty('schema:character');
  expect(validateCharacter(read.release, { ...draft.item, type: 'schema:Person' }).length).toBeGreaterThan(0);
  expect(
    validateCharacter(read.release, {
      ...draft.item,
      statements: {
        'wdt:P725': [
          {
            property: { id: 'wdt:P725' },
            value: { type: 'value', content: relationActor },
            qualifiers: [],
            references: [],
          },
        ],
      },
    }).length,
  ).toBeGreaterThan(0);
  const fields = characterRelations(await fixture.work.transport.read(), read.release);
  expect(fields.ok).toBe(true);
  if (!fields.ok) throw new Error('Expected native work credit fields');
  expect(fields.fields.find((field) => field.id === 'wdt:P725')?.slotKey).toBe('wdt:P453');
  const proposed = await fixture.work.transport.propose({
    id: fixture.work.id,
    slot: { property: 'wdt:P725', target: relationActor, key: relationRole },
    statement: structuredClone(fixture.work.draft),
    key: crypto.randomUUID(),
  });
  expect(proposed.ok).toBe(true);
  const creditWrite = fixture.work.calls.find((call) => call.method === 'POST');
  expect(creditWrite?.path).toBe(`/v1/subjects/${fixture.work.id}/candidates`);
  expect(creditWrite?.body).toMatchObject({
    statement: {
      property: { id: 'wdt:P725' },
      qualifiers: expect.arrayContaining([
        { property: { id: 'wdt:P453' }, value: { type: 'value', content: characterProfileId } },
      ]),
    },
  });
  expect(fixture.work.adopted).toBe(false);
  expect(fixture.work.publicRead.subject.statements['wdt:P725']).toHaveLength(3);
});

test('character correction and uncertain creation retain native facts, keys and exact readback', async () => {
  const fixture = characterProfileFixture();
  const read = await fixture.transport.load({ id: characterProfileId });
  if (!read.ok) throw new Error('Expected character');
  const current = characterFacts(read);
  if (!current.ok) throw new Error('Expected facts');
  const staged = stageFact(current, 'schema:height', current.public.subject.statements['schema:height']![0]!.id)!;
  expect(factChanged(staged)).toBe(false);
  expect(sealFacts(characterProfileId, read.release, [staged])[0]?.command).toBeUndefined();
  staged.statement.value = {
    type: 'value',
    content: { amount: '+171', unit: 'http://www.wikidata.org/entity/Q174728' },
  };
  const sealed = sealFacts(characterProfileId, read.release, [staged]);
  let candidate: string | undefined;
  await sendFacts(sealed, fixture.props.facts(characterProfileId).propose, (_property, result) => {
    if (result.ok) candidate = result.candidate;
  });
  expect(candidate).toBeDefined();
  expect(fixture.candidates[0]?.id).toBe(candidate);
  expect(fixture.character.subject.labels).toEqual({ en: 'The traveler', ja: '旅人' });
  expect(fixture.character.subject.statements['schema:height']![0]!.value).toEqual(staged.baseline!.value);
  const lost = characterProfileFixture('uncertain');
  const draft = characterDraft(lost.release, [{ language: 'en', label: 'Traveler', description: '', aliases: '' }], []);
  const command = { item: draft.item, key: crypto.randomUUID() };
  expect(await lost.transport.create(command)).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await lost.transport.create(command)).toMatchObject({ ok: true, id: characterCreatedId });
  expect(lost.calls.filter((call) => call.method === 'POST').map((call) => call.key)).toEqual([
    command.key,
    command.key,
  ]);
  const concealed = characterProfileFixture('concealed');
  expect(await readCreatedSubject(concealed.client, characterCreatedId, 'en')).toEqual({ state: 'concealed' });
  expect(await characterProfileFixture('stale').transport.load({})).toEqual({ ok: false, reason: 'unavailable' });
});

async function mountCharacterCreate(options: {
  eligibility: () => Promise<CreateAuthority>;
  session?: string;
  subject?: string;
  work?: boolean;
  create?: CharacterTransport['create'];
  read?: CharacterTransport['read'];
}) {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.invalid/en/catalogue/character' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { CharacterProfile } = await import('../src/features/catalogue/character-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const fixture = characterProfileFixture();
  const commands: CharacterCommand[] = [];
  const reads: string[] = [];
  const transport: CharacterTransport = {
    ...fixture.transport,
    eligibility: options.eligibility,
    create: async (command) => {
      commands.push(structuredClone(command));
      return options.create ? options.create(command) : fixture.transport.create(command);
    },
    read: async (id) => {
      reads.push(id);
      return options.read ? options.read(id) : fixture.transport.read(id);
    },
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const user = userEvent.setup({ document: window.document, delay: null });
  let session = options.session ?? 'signed-in';
  let subject = options.subject ?? 'alice';
  const render = async (next: { session?: string; subject?: string } = {}) => {
    if (next.session !== undefined) session = next.session;
    if (next.subject !== undefined) subject = next.subject;
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(
            CandidateReaderBoundary,
            {
              address: `character-eligibility-${subject || 'guest'}`,
              observed:
                session === 'signed-in'
                  ? { state: 'signed-in' as const, subject, csrfToken: `csrf-${subject}` }
                  : { state: 'signed-out' as const, csrfToken: null },
            },
            h(CharacterProfile, {
              ...fixture.props,
              ...(options.work ? { work: fixture.work.id } : {}),
              locale: 'en',
              session,
              transport,
            }),
          ),
        ),
      ),
    );
  };
  await render();
  const canvas = () => within(host);
  return {
    host,
    canvas,
    user,
    m,
    waitFor,
    act,
    commands,
    reads,
    fixture,
    render,
    submit: async () => {
      const retry = canvas().queryByRole('button', { name: m.correction_retry() });
      if (retry) return act(async () => user.click(retry));
      const create = canvas().queryByRole('button', { name: m.character_create() });
      if (create) return act(async () => user.click(create));
      await act(async () => user.click(canvas().getByRole('button', { name: m.character_create_review() })));
    },
    async close() {
      await act(async () => root.unmount());
      window.close();
      setLocale(previousLocale, { reload: false });
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('refused, unknown and guest Character eligibility keep admitted descriptors and block a new create', async () => {
  const guest = await mountCharacterCreate({
    eligibility: async () => allowedCreateAuthority,
    session: 'signed-out',
    work: true,
  });
  try {
    await guest.waitFor(() => expect(guest.host.textContent).toContain(guest.m.identity_intake_authority_guest()));
    expect(guest.canvas().getByRole('textbox', { name: guest.m.catalogue_create_label() })).toBeDefined();
    await guest.act(async () =>
      guest.user.type(guest.canvas().getByRole('textbox', { name: guest.m.catalogue_create_label() }), 'Guest draft'),
    );
    expect(
      (guest.canvas().getByRole('button', { name: guest.m.character_create_review() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(guest.commands).toHaveLength(0);
  } finally {
    await guest.close();
  }

  let observation: CreateAuthority = { state: 'refused', reason: 'permission' };
  const page = await mountCharacterCreate({ eligibility: async () => observation, work: true });
  try {
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.host.textContent).toContain(page.m.character_title());
    expect(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() })).toBeDefined();
    await page.act(async () =>
      page.user.type(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Kept draft'),
    );
    expect(
      (page.canvas().getByRole('button', { name: page.m.character_create_review() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);

    observation = { state: 'unknown', reason: 'unavailable' };
    await page.act(async () =>
      page.user.click(page.canvas().getByRole('button', { name: page.m.identity_intake_authority_retry() })),
    );
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(page.m.identity_intake_authority_unknown()),
    );
    expect(
      (page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }) as HTMLInputElement).value,
    ).toBe('Kept draft');
    expect(
      (page.canvas().getByRole('button', { name: page.m.character_create_review() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('fresh Character create rechecks eligibility; viewer replacement drops a late allow; uncertain retry keeps the exact command', async () => {
  let observation: CreateAuthority = allowedCreateAuthority;
  let lost = true;
  let createdReads = 0;
  const page = await mountCharacterCreate({
    eligibility: async () => observation,
    create: async (command) => {
      if (lost) {
        lost = false;
        return { ok: false, reason: 'unavailable' };
      }
      return {
        ok: true,
        id: characterCreatedId,
        reader: { state: 'unavailable' },
      } satisfies Extract<CreateResult, { ok: true }>;
    },
    read: async (id) => {
      createdReads += 1;
      expect(id).toBe(characterCreatedId);
      return {
        state: 'ready',
        href: `/en/subjects/${id}/recovered`,
        identity: { id, type: 'wd:Q95074', label: 'Eligible traveler' },
      } satisfies CreatedReader;
    },
  });
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await page.act(async () =>
      page.user.type(
        page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }),
        'Eligible traveler',
      ),
    );
    await page.submit();
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.character_create_review_title()));
    observation = { state: 'refused', reason: 'permission' };
    await page.submit();
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.commands).toHaveLength(0);

    observation = allowedCreateAuthority;
    await page.act(async () =>
      page.user.click(page.canvas().getByRole('button', { name: page.m.identity_intake_authority_retry() })),
    );
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await page.submit();
    await page.waitFor(() =>
      expect(page.canvas().getByRole('button', { name: page.m.correction_retry() })).toBeDefined(),
    );
    expect(page.commands).toHaveLength(1);
    observation = { state: 'refused', reason: 'permission' };
    await page.submit();
    await page.waitFor(() => expect(page.host.textContent).toContain(characterCreatedId));
    expect(page.commands).toHaveLength(2);
    expect(page.commands[1]!.key).toBe(page.commands[0]!.key);
    expect(page.commands[1]!.item).toEqual(page.commands[0]!.item);
    expect(page.host.textContent).toContain(page.m.catalogue_create_reader_unavailable());
    await page.act(async () => page.user.click(page.canvas().getByRole('button', { name: page.m.correction_retry() })));
    await page.waitFor(() =>
      expect(page.canvas().getByRole('link', { name: page.m.candidate_view_public() }).getAttribute('href')).toBe(
        `/en/subjects/${characterCreatedId}/recovered`,
      ),
    );
    expect(page.commands).toHaveLength(2);
    expect(createdReads).toBe(1);
  } finally {
    await page.close();
  }
});

test('viewer replacement drops a late allowed Character observation', async () => {
  let pending: ((value: CreateAuthority) => void) | undefined;
  let calls = 0;
  const page = await mountCharacterCreate({
    eligibility: () => {
      calls += 1;
      if (calls === 1) return new Promise<CreateAuthority>((resolve) => (pending = resolve));
      return Promise.resolve({ state: 'refused', reason: 'permission' });
    },
  });
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_reading()));
    expect(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() })).toBeDefined();
    await page.render({ subject: 'bob' });
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    pending?.(allowedCreateAuthority);
    await page.act(async () => undefined);
    expect(page.canvas().getByRole('alert').textContent).toContain(
      page.m.identity_intake_authority_refused_permission(),
    );
    expect(
      (page.canvas().getByRole('button', { name: page.m.character_create_review() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});
