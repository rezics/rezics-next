import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import * as start from '../.storybook/react-start';
import { allowedCreateAuthority, type CreateAuthority } from '../src/features/catalogue/identity-intake';
import type { CreateResult, CreatedReader, CreateSubjectCommand } from '../src/features/catalogue/create-subject';
import { releaseDigest } from '@rezics/definitions';
import {
  storyArcProfileFixture,
  storyArcProfileId,
  storyArcSiblingId,
  storyArcCreatedId,
} from '../src/kernel/fake/catalogue-story-arc-profile';
import {
  storyArcFacts,
  storyArcRelations,
  storyArcType,
  storyArcProperty,
  storyArcWork,
  type StoryArcTransport,
} from '../src/features/catalogue/story-arc-profile';
import { initialTerms } from '../src/features/catalogue/create-subject';
import { relationDraft } from '../src/subject/relation-candidates';
import { sealFacts, sendFacts, stageFact } from '../src/features/catalogue/subject-facts';
import { collectEditorialEntries, contributionMenu } from '../src/features/catalogue/editorial-entry';
import { StoryArcProfileEntry, storyArcEntry } from '../src/features/catalogue/story-arc-profile-entry';
import { contributionHref } from '../src/features/catalogue/catalogue-entry';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Narrative story-arc editor uses current admitted native fields and actual candidate-reader semantics', async () => {
  const fixture = storyArcProfileFixture();
  const read = await fixture.transport.load({ id: storyArcProfileId, work: fixture.work.id });
  if (!read.ok) throw new Error('Expected current arc and work');
  expect(fixture.calls.find((call) => call.path.startsWith('/v1/definitions/releases/'))).toMatchObject({
    method: 'GET',
    path: `/v1/definitions/releases/${encodeURIComponent(releaseDigest(fixture.release))}`,
  });
  expect(read.release.types[storyArcType]).toEqual(fixture.release.types[storyArcType]);
  expect(read.release.properties[storyArcProperty]).toEqual(fixture.release.properties[storyArcProperty]);
  expect(read.arc?.subject.type).toBe(storyArcType);
  expect(storyArcWork(read.release, read.work!.subject.type)).toBe(true);
  const relation = storyArcRelations(await fixture.work.transport.read(), read.release, true);
  if (!relation.ok) throw new Error('Expected emitted work relation');
  expect(relation.fields.map((field) => field.id)).toEqual([storyArcProperty]);
  expect(relation.fields[0]!.qualifiers.map((field) => field.id)).toEqual([
    'rezics:firstPart',
    'rezics:lastPart',
    'schema:position',
  ]);
  expect(relation.fields[0]!.slotKey).toBeUndefined();
  expect(read.release.types[storyArcType]!.properties).toEqual(
    expect.arrayContaining(['wdt:P179', 'wdt:P361', 'wdt:P155']),
  );

  const draft = initialTerms(storyArcType, [
    { language: 'en', label: 'A real arc', description: 'A named narrative range', aliases: '' },
    { language: 'ja', label: '旅の編', description: '', aliases: '旅路編' },
  ]);
  expect(draft.errors).toEqual([]);
  const key = crypto.randomUUID();
  const result = await fixture.transport.creation.submit({ item: draft.item, key });
  expect(result).toMatchObject({
    ok: true,
    id: storyArcCreatedId,
    reader: { state: 'ready', href: expect.stringContaining(`/subjects/${storyArcCreatedId}/a-real-arc`) },
  });
  expect(fixture.creation.calls.find((call) => call.method === 'POST')).toMatchObject({
    path: '/v1/subjects',
    key,
    body: draft.item,
  });
  expect(fixture.creation.calls.at(-1)!.path).toBe(`/v1/subjects/${storyArcCreatedId}`);
  expect(draft.item).not.toHaveProperty('source');
  expect(draft.item).not.toHaveProperty('statements');
  expect(fixture.work.publicRead.subject.statements[storyArcProperty]).toHaveLength(2);

  const slot = { property: storyArcProperty, target: storyArcProfileId };
  const statement = relationDraft(fixture.original);
  statement.qualifiers.find((part) => part.property.id === 'schema:position')!.value = { type: 'value', content: '3' };
  const proposed = await fixture.work.transport.propose({
    id: fixture.work.id,
    slot,
    statement,
    key: crypto.randomUUID(),
  });
  if (!proposed.ok) throw new Error('Expected ordinary candidate proposal');
  expect(fixture.work.publicRead.subject.statements[storyArcProperty]![0]!.id).toBe(fixture.original.id);
  const write = fixture.work.calls.find((call) => call.method === 'POST');
  expect(write?.path).toBe(`/v1/subjects/${fixture.work.id}/candidates`);
  const nativePart = ({ property, value }: (typeof statement.qualifiers)[number]) => ({
    property: { id: property.id },
    value,
  });
  expect(write?.body).toMatchObject({
    statement: {
      value: { type: 'value', content: storyArcProfileId },
      qualifiers: statement.qualifiers.map(nativePart),
      references: statement.references.map(({ parts }) => ({ parts: parts.map(nativePart) })),
    },
  });
  const accepted = await fixture.work.transport.confirm({
    id: fixture.work.id,
    slot,
    candidate: proposed.candidate,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
  });
  expect(accepted).toMatchObject({ ok: true, kind: 'accepted' });
  const comparison = await fixture.work.transport.read(slot);
  if (!comparison.ok) throw new Error('Expected current slot comparison');
  const selected = await fixture.work.transport.confirm({
    id: fixture.work.id,
    slot,
    candidate: proposed.candidate,
    operation: 'adopt',
    head: comparison.page!.adoption!.head,
    rank: 'preferred',
    key: crypto.randomUUID(),
  });
  expect(selected).toMatchObject({ ok: true, kind: 'selected' });
  expect(fixture.work.publicRead.subject.statements[storyArcProperty]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: proposed.candidate, rank: 'preferred' }),
      expect.objectContaining({ value: { type: 'value', content: storyArcSiblingId } }),
    ]),
  );
});

test('arc corrections keep multilingual current facts and independent partial results until native review', async () => {
  const fixture = storyArcProfileFixture();
  const read = await fixture.transport.load({ id: storyArcProfileId });
  if (!read.ok) throw new Error('Expected arc');
  const facts = storyArcFacts(read);
  if (!facts.ok) throw new Error('Expected facts');
  const baseline = structuredClone(fixture.arc);
  const keywords = stageFact(facts, 'schema:keywords', facts.public.subject.statements['schema:keywords']![0]!.id)!;
  expect(sealFacts(storyArcProfileId, read.release, [keywords])[0]!.command).toBeUndefined();
  keywords.statement.value = { type: 'value', content: 'a corrected theme' };
  const url = stageFact(facts, 'schema:url', null)!;
  url.statement.value = { type: 'value', content: 'https://example.org/arc' };
  const sealed = sealFacts(storyArcProfileId, read.release, [keywords, url]);
  const outcomes: unknown[] = [];
  await sendFacts(
    sealed,
    (command) =>
      command.statement.property.id === 'schema:url'
        ? Promise.resolve({ ok: false, reason: 'denied' })
        : fixture.props.facts(storyArcProfileId).propose(command),
    (_property, result) => outcomes.push(result),
  );
  expect(outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ok: true, kind: 'proposed-awaiting-review' }),
      { ok: false, reason: 'denied' },
    ]),
  );
  expect(fixture.arc).toEqual(baseline);
  expect(fixture.candidates[0]!.statement.references).toEqual(
    baseline.subject.statements['schema:keywords']![0]!.references.map((reference) => ({
      ...reference,
      hash: 'citation',
    })),
  );
  expect(stageFact(facts, 'schema:name', null)).toBeNull();
  expect(stageFact(facts, 'schema:numberOfPages', null)).toBeNull();
  const entry = storyArcEntry({
    id: storyArcProfileId,
    label: 'The journey arc',
    work: fixture.work.id,
    locale: 'en',
    realm: 'a realm',
  });
  expect(entry.href).toContain(
    `/subjects/${storyArcProfileId}/the-journey-arc/story-arc?work=${fixture.work.id}&realm=a+realm`,
  );
  expect(new URL(contributionHref(entry, true), 'https://site.invalid').searchParams.get('return_to')).toBe(entry.href);
  const collected = collectEditorialEntries(
    createElement(StoryArcProfileEntry, { id: storyArcProfileId, label: 'The journey arc', locale: 'en' }),
  );
  expect(collected.retained).toEqual([]);
  expect(contributionMenu(collected.entries, 'en', false)).toHaveLength(1);
});

test('uncertain creation reuses its key and an unselected adoption stays pending in the actual reader', async () => {
  const fixture = storyArcProfileFixture('uncertain');
  const { item } = initialTerms(storyArcType, [{ language: 'en', label: 'Arc', description: '', aliases: '' }]);
  const command = { item, key: crypto.randomUUID() };
  expect(await fixture.transport.creation.submit(command)).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await fixture.transport.creation.submit(command)).toMatchObject({ ok: true, id: storyArcCreatedId });
  expect(fixture.creation.calls.filter((call) => call.method === 'POST').map((call) => call.key)).toEqual([
    command.key,
    command.key,
  ]);
  const pending = storyArcProfileFixture('pending');
  const slot = { property: storyArcProperty, target: storyArcProfileId };
  await pending.work.transport.confirm({
    id: pending.work.id,
    slot,
    candidate: pending.work.candidate.id,
    operation: 'accept',
    head: null,
    key: crypto.randomUUID(),
  });
  const comparison = await pending.work.transport.read(slot);
  if (!comparison.ok) throw new Error('Expected current slot');
  expect(
    await pending.work.transport.confirm({
      id: pending.work.id,
      slot,
      candidate: pending.work.candidate.id,
      operation: 'adopt',
      head: comparison.page!.adoption!.head,
      key: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: true, kind: 'pending' });
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['wrong-type', 'invalid'],
    ['stale', 'unavailable'],
    ['unavailable', 'unavailable'],
  ] as const)
    expect(await storyArcProfileFixture(scenario).transport.load({ id: storyArcProfileId })).toEqual({
      ok: false,
      reason,
    });
  expect(await storyArcProfileFixture('concealed').transport.creation.read(storyArcCreatedId)).toEqual({
    state: 'concealed',
  });
});

type ViewerSession = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';

async function mountStoryArcCreate(options: {
  eligibility: () => Promise<CreateAuthority>;
  session?: ViewerSession;
  subject?: string;
  work?: boolean;
  submit?: (command: CreateSubjectCommand) => Promise<CreateResult>;
  read?: (id: string) => Promise<CreatedReader>;
}) {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.invalid/en/catalogue/story-arc' });
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
  const { StoryArcProfile } = await import('../src/features/catalogue/story-arc-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const fixture = storyArcProfileFixture();
  const commands: CreateSubjectCommand[] = [];
  const reads: string[] = [];
  const transport: StoryArcTransport = {
    ...fixture.transport,
    creation: {
      ...fixture.transport.creation,
      eligibility: options.eligibility,
      submit: async (command) => {
        commands.push(structuredClone(command));
        return options.submit ? options.submit(command) : fixture.transport.creation.submit(command);
      },
      read: async (id) => {
        reads.push(id);
        return options.read ? options.read(id) : fixture.transport.creation.read(id);
      },
    },
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const user = userEvent.setup({ document: window.document, delay: null });
  let session: ViewerSession = options.session ?? 'signed-in';
  let subject = options.subject ?? 'alice';
  const render = async (next: { session?: ViewerSession; subject?: string } = {}) => {
    if (next.session !== undefined) session = next.session;
    if (next.subject !== undefined) subject = next.subject;
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            CandidateReaderBoundary,
            {
              address: `story-arc-eligibility-${subject || 'guest'}`,
              observed:
                session === 'signed-in'
                  ? { state: 'signed-in' as const, subject, csrfToken: `csrf-${subject}` }
                  : { state: 'signed-out' as const, csrfToken: null },
            },
            createElement(StoryArcProfile, {
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
      const retry = canvas().queryByRole('button', { name: m.catalogue_create_retry() });
      if (retry) return act(async () => user.click(retry));
      await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
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

test('refused, unknown and guest Story Arc eligibility keep admitted work descriptors and block a new create', async () => {
  const guest = await mountStoryArcCreate({
    eligibility: async () => allowedCreateAuthority,
    session: 'signed-out',
    work: true,
  });
  try {
    await guest.waitFor(() => expect(guest.host.textContent).toContain(guest.m.identity_intake_authority_guest()));
    expect(guest.host.textContent).toContain('The actual parent series');
    expect(guest.canvas().getByRole('textbox', { name: guest.m.catalogue_create_label() })).toBeDefined();
    expect(
      (guest.canvas().getByRole('button', { name: guest.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(guest.commands).toHaveLength(0);
  } finally {
    await guest.close();
  }

  let observation: CreateAuthority = { state: 'refused', reason: 'permission' };
  const page = await mountStoryArcCreate({ eligibility: async () => observation, work: true });
  try {
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert').textContent).toContain(
        page.m.identity_intake_authority_refused_permission(),
      ),
    );
    expect(page.host.textContent).toContain('The actual parent series');
    expect(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() })).toBeDefined();
    await page.act(async () =>
      page.user.type(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Kept draft'),
    );
    expect(
      (page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
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
      (page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('fresh Story Arc create rechecks eligibility; viewer replacement drops a late allow; uncertain retry keeps the exact command', async () => {
  let observation: CreateAuthority = allowedCreateAuthority;
  let lost = true;
  let createdReads = 0;
  const page = await mountStoryArcCreate({
    eligibility: async () => observation,
    submit: async (command) => {
      if (lost) {
        lost = false;
        return { ok: false, reason: 'unavailable' };
      }
      return {
        ok: true,
        id: storyArcCreatedId,
        reader: { state: 'unavailable' },
      } satisfies Extract<CreateResult, { ok: true }>;
    },
    read: async (id) => {
      createdReads += 1;
      expect(id).toBe(storyArcCreatedId);
      return {
        state: 'ready',
        href: `/en/subjects/${id}/recovered`,
        identity: { id, type: storyArcType, label: 'Eligible arc' },
      } satisfies CreatedReader;
    },
  });
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_allowed()));
    await page.act(async () =>
      page.user.type(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Eligible arc'),
    );
    await page.submit();
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.story_arc_create_review_title()));
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
      expect(page.canvas().getByRole('button', { name: page.m.catalogue_create_retry() })).toBeDefined(),
    );
    expect(page.commands).toHaveLength(1);
    observation = { state: 'refused', reason: 'permission' };
    await page.submit();
    await page.waitFor(() => expect(page.host.textContent).toContain(storyArcCreatedId));
    expect(page.commands).toHaveLength(2);
    expect(page.commands[1]!.key).toBe(page.commands[0]!.key);
    expect(page.commands[1]!.item).toEqual(page.commands[0]!.item);
    expect(page.host.textContent).toContain(page.m.catalogue_create_reader_unavailable());
    await page.act(async () =>
      page.user.click(page.canvas().getByRole('button', { name: page.m.catalogue_create_retry() })),
    );
    await page.waitFor(() =>
      expect(page.canvas().getByRole('link', { name: page.m.catalogue_create_open() }).getAttribute('href')).toBe(
        `/en/subjects/${storyArcCreatedId}/recovered`,
      ),
    );
    expect(page.commands).toHaveLength(2);
    expect(createdReads).toBe(1);
  } finally {
    await page.close();
  }
});

test('viewer replacement drops a late allowed Story Arc observation', async () => {
  let pending: ((value: CreateAuthority) => void) | undefined;
  let calls = 0;
  const page = await mountStoryArcCreate({
    eligibility: () => {
      calls += 1;
      if (calls === 1) return new Promise<CreateAuthority>((resolve) => (pending = resolve));
      return Promise.resolve({ state: 'refused', reason: 'permission' });
    },
    work: true,
  });
  try {
    await page.waitFor(() => expect(page.host.textContent).toContain(page.m.identity_intake_authority_reading()));
    expect(page.host.textContent).toContain('The actual parent series');
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
      (page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(page.commands).toHaveLength(0);
  } finally {
    await page.close();
  }
});
