import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));
test('Game classification keyboard opening and discard preserve independent drafts and native retry identity', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/game' });
  const globals = {
    ...Object.fromEntries(
      'document navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLButtonElement Node Element Document DocumentFragment MutationObserver ResizeObserver'
        .split(' ')
        .map((key) => [key, Reflect.get(window, key)]),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
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
  const extraPlatform = structuredClone(read.public.subject.statements['schema:gamePlatform']![0]!);
  extraPlatform.id = '00000000-0000-4000-8000-00000000f106';
  extraPlatform.value = { type: 'value', content: '00000000-0000-4000-8000-00000000f105' };
  extraPlatform.qualifiers = [
    { property: { id: 'schema:inLanguage', data_type: 'string' }, value: { type: 'value', content: 'en' } },
  ];
  read.public.subject.statements['schema:gamePlatform']!.push(extraPlatform);
  read.public.related['00000000-0000-4000-8000-00000000f105'] = {
    type: 'skos:Concept',
    labels: { en: 'Other platform' },
  };
  const selected = structuredClone(read.public.subject.statements);
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let visible = true,
    epoch = 'original',
    generation = 0,
    requests = 0;
  let propose: (command: FactCommand) => Promise<FactResult> = async () => ({ ok: false, reason: 'stale' });
  const nativeCommands: FactCommand[] = [];
  let duringProposal: (() => void) | undefined;
  const props = {
    read,
    locale: 'en',
    search: async () => [],
    review: fixture.transport.classificationReview,
    transport: {
      read: fixture.transport.facts.read,
      propose: (command: FactCommand) => {
        requests++;
        nativeCommands.push(structuredClone(command));
        duringProposal?.();
        return propose(command);
      },
    },
  };
  const render = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: gameId, csrfToken: epoch }}
            address={gameId}
          >
            <CatalogueCurrentReading visible={visible} ready={visible} revision={String(visible)}>
              <GameClassifications key={generation} {...props} />
            </CatalogueCurrentReading>
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  const section = (property = 'schema:gamePlatform') =>
    host.querySelector<HTMLElement>(`[data-classification-property="${property}"]`)!;
  const buttons = (name: string, property?: string) => within(section(property)).getAllByRole('button', { name });
  const discard = (property?: string) => buttons(m.authored_discard(), property)[0]!;
  const cancel = () => buttons(m.candidate_cancel())[0]!;
  const hasConfirmation = () => within(section()).queryByRole('button', { name: m.candidate_cancel() });
  const click = (node: HTMLElement) => act(async () => user.click(node));
  const input = () => within(section()).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
  const picker = (property?: string) => section(property).querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const retainChange = (field: HTMLInputElement) => {
    const key = Object.getOwnPropertyNames(field).find((name) => name.startsWith('__reactProps$'));
    const handler = key ? (Reflect.get(field, key) as { onChange?: (event: unknown) => void }).onChange : undefined;
    if (!handler) throw new Error('Missing mounted Game classification part callback');
    return (value: string) => handler({ target: { value } });
  };
  const edit = async () => {
    await click(buttons(m.facts_edit_field())[0]!);
    await act(async () => {
      await user.clear(input());
      await user.type(input(), 'fr');
    });
  };
  const submit = async () => {
    const review = within(host).queryByRole('button', { name: m.facts_review() });
    if (review && !(review as HTMLButtonElement).disabled) await click(review);
    await click(within(host).getByRole('button', { name: m.facts_submit() }));
  };
  try {
    await render();
    await click(buttons(m.facts_add_value(), 'schema:genre')[0]!);
    const privateSibling = section('schema:genre').querySelector('fieldset')!;
    expect(window.document.activeElement).not.toBe(privateSibling);
    const siblingInputs = [...privateSibling.querySelectorAll('input')];
    const siblingValues = siblingInputs.map((field) => field.value);
    const openByKeyboard = async (opener: HTMLElement) => {
      opener.focus();
      await act(async () => user.keyboard('{Enter}'));
      expect(window.document.activeElement).toBe(
        within(section()).getByRole('group', { name: /Private proposal draft/ }),
      );
      expect(section('schema:genre').querySelector('fieldset')).toBe(privateSibling);
      expect(siblingInputs.map((field) => field.value)).toEqual(siblingValues);
      expect(requests).toBe(0);
      expect(read.public.subject.statements).toEqual(selected);
    };
    await openByKeyboard(buttons(m.facts_edit_field())[1]!);
    expect(input().value).toBe('en');
    input().focus();
    await render();
    expect(window.document.activeElement).toBe(input());
    await click(discard());
    await click(discard());
    await openByKeyboard(buttons(m.facts_add_value())[0]!);
    expect(picker().value).toBe('');
    await click(discard());
    const opener = buttons(m.facts_edit_field())[0]!;
    opener.focus();
    await act(async () => {
      opener.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
      discard('schema:genre').focus();
    });
    expect(section().querySelector('fieldset')).not.toBeNull();
    expect(window.document.activeElement).toBe(discard('schema:genre'));
    await render();
    expect(window.document.activeElement).toBe(discard('schema:genre'));
    expect(requests).toBe(0);
    generation++;
    await render();
    await edit();
    await act(async () => user.clear(input()));
    await click(buttons(m.facts_add_value(), 'schema:genre')[0]!);
    const sibling = section('schema:genre').querySelector('fieldset');
    const fields = [...host.querySelectorAll<HTMLInputElement>('input')],
      values = fields.map((field) => field.value);
    await click(discard());
    expect(window.document.activeElement).toBe(cancel());
    await click(cancel());
    expect(window.document.activeElement).toBe(discard());
    expect([...host.querySelectorAll('input')]).toEqual(fields);
    expect(fields.map((field) => field.value)).toEqual(values);
    await click(discard());
    await click(discard());
    expect(section().querySelector('fieldset')).toBeNull();
    expect(window.document.activeElement).toBe(buttons(m.facts_edit_field())[0]);
    expect(section('schema:genre').querySelector('fieldset')).toBe(sibling);
    await click(buttons(m.facts_edit_field())[1]!);
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
    await click(buttons(m.facts_add_value())[0]!);
    await click(discard());
    expect(section().querySelector('fieldset')).toBeNull();
    expect(window.document.activeElement).toBe(buttons(m.facts_add_value())[0]);
    for (const reason of ['stale', 'uncertain'] as const) {
      generation++;
      await render();
      if (reason === 'uncertain') {
        await edit();
        const discardedPart = retainChange(input());
        await click(discard());
        await click(discard());
        await click(buttons(m.facts_edit_field())[0]!);
        expect(input().value).toBe('ja');
        discardedPart('discarded callback');
        expect(input().value).toBe('ja');
      }
      await edit();
      await click(discard());
      const confirmation = discard();
      const delivery = Promise.withResolvers<FactResult>();
      if (reason === 'uncertain') duringProposal = retainChange(input()).bind(null, 'late sealed edit');
      propose = () => delivery.promise;
      await submit();
      duringProposal = undefined;
      if (reason === 'uncertain') expect(input().value).toBe('fr');
      expect((discard() as HTMLButtonElement).disabled).toBe(true);
      await act(async () => confirmation.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
      expect(input().value).toBe('fr');
      await act(async () => delivery.resolve({ ok: false, reason }));
      expect((discard() as HTMLButtonElement).disabled).toBe(true);
      if (reason === 'uncertain') {
        expect(nativeCommands.at(-1)?.statement.qualifiers![0]!.value).toEqual({ type: 'value', content: 'fr' });
        const siblingOpener = buttons(m.facts_add_value(), 'schema:genre')[0]!;
        siblingOpener.focus();
        await act(async () => user.keyboard('{Enter}'));
        expect(window.document.activeElement).toBe(section('schema:genre').querySelector('fieldset'));
        expect(input().closest('fieldset')!.disabled).toBe(true);
        propose = async () => ({ ok: false, reason: 'uncertain' });
        await submit();
        expect(nativeCommands.at(-1)).toEqual(nativeCommands.at(-2));
      }
      if (reason === 'stale') {
        await click(buttons(m.catalogue_create_review_new())[0]!);
        expect((discard() as HTMLButtonElement).disabled).toBe(false);
        expect(hasConfirmation()).toBeNull();
      }
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
