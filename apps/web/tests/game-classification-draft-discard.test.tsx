import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { FactResult } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));
test('Game discards only the confirmed unsent classification and retires confirmations with drafts and authority', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/game' });
  const globals = {
    ...Object.fromEntries(
      'document navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLButtonElement Node Element Document DocumentFragment MutationObserver'
        .split(' ')
        .map((key) => [key, Reflect.get(window, key)]),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { GameClassifications } = await import('../src/features/catalogue/game-profile-fields');
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { gameProfileFixture, gameId } = await import('../src/kernel/fake/catalogue-game-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = gameProfileFixture('ready', 'en', true),
    read = await fixture.transport.load();
  if (!read.ok || !read.public) throw new Error('Expected an existing Game');
  const selected = structuredClone(read.public.subject.statements);
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let visible = true,
    epoch = 'original',
    generation = 0,
    requests = 0;
  let propose: () => Promise<FactResult> = async () => ({ ok: false, reason: 'stale' });
  const props = {
    read,
    locale: 'en',
    search: async () => [],
    review: fixture.transport.classificationReview,
    transport: {
      read: fixture.transport.facts.read,
      propose: () => {
        requests++;
        return propose();
      },
    },
  };
  const render = () =>
    act(async () =>
      root.render(
        <CandidateReaderBoundary observed={{ state: 'signed-in', subject: gameId, csrfToken: epoch }} address={gameId}>
          <CatalogueCurrentReading visible={visible} ready={visible} revision={String(visible)}>
            <GameClassifications key={generation} {...props} />
          </CatalogueCurrentReading>
        </CandidateReaderBoundary>,
      ),
    );
  const section = (property = 'schema:inLanguage') =>
    host.querySelector<HTMLElement>(`[data-classification-property="${property}"]`)!;
  const buttons = (name: string, property?: string) => within(section(property)).getAllByRole('button', { name });
  const discard = (property?: string) => buttons(m.authored_discard(), property)[0]!;
  const cancel = () => buttons(m.candidate_cancel())[0]!;
  const hasConfirmation = () => within(section()).queryByRole('button', { name: m.candidate_cancel() });
  const click = (node: HTMLElement) => act(async () => user.click(node));
  const input = () => within(section()).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
  const edit = async () => {
    await click(buttons(m.facts_edit_field())[0]!);
    await act(async () => {
      await user.clear(input());
      await user.type(input(), 'fr');
    });
  };
  const submit = () => click(within(host).getByRole('button', { name: m.facts_submit() }));
  try {
    await render();
    await edit();
    await click(buttons(m.facts_edit_field(), 'schema:gamePlatform')[0]!);
    const sibling = section('schema:gamePlatform').querySelector('fieldset');
    const fields = [...host.querySelectorAll<HTMLInputElement>('input')],
      values = fields.map((field) => field.value);
    await click(discard());
    expect(window.document.activeElement).toBe(cancel());
    await click(cancel());
    expect(window.document.activeElement).toBe(discard());
    expect([...host.querySelectorAll('input')]).toEqual(fields);
    expect(fields.map((field) => field.value)).toEqual(values);
    await click(discard());
    const oldConfirmation = discard();
    await click(oldConfirmation);
    expect(section().querySelector('fieldset')).toBeNull();
    expect(window.document.activeElement).toBe(buttons(m.facts_edit_field())[0]);
    expect(section('schema:gamePlatform').querySelector('fieldset')).toBe(sibling);
    await click(buttons(m.facts_edit_field())[1]!);
    expect(input().value).toBe('en');
    await act(async () => oldConfirmation.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(input().value).toBe('en');
    expect(hasConfirmation()).toBeNull();
    await click(discard());
    visible = false;
    await render();
    expect(host.querySelector('section, input, button')).toBeNull();
    visible = true;
    await render();
    expect(input().value).toBe('en');
    expect(hasConfirmation()).toBeNull();
    await click(discard());
    epoch = 'new-viewer-session';
    await render();
    expect(section().querySelector('fieldset')).toBeNull();
    expect(read.public.subject.statements).toEqual(selected);
    expect(requests).toBe(0);
    read.public.subject.statements['schema:inLanguage'] = [];
    await render();
    await click(buttons(m.facts_add_value())[0]!);
    await click(discard());
    expect(section().querySelector('fieldset')).toBeNull();
    expect(window.document.activeElement).toBe(buttons(m.facts_add_value())[0]);
    read.public.subject.statements = structuredClone(selected);
    for (const reason of ['stale', 'uncertain'] as const) {
      generation++;
      await render();
      await edit();
      await click(discard());
      const confirmation = discard();
      let finish!: (result: FactResult) => void;
      propose = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      await submit();
      expect((discard() as HTMLButtonElement).disabled).toBe(true);
      await act(async () => confirmation.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      expect(input().value).toBe('fr');
      await act(async () => finish({ ok: false, reason }));
      expect((discard() as HTMLButtonElement).disabled).toBe(true);
      if (reason === 'stale') {
        await click(buttons(m.catalogue_create_review_new())[0]!);
        expect((discard() as HTMLButtonElement).disabled).toBe(false);
        expect(hasConfirmation()).toBeNull();
      }
    }
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
