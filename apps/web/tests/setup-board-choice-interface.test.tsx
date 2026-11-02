import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import { BoardChoiceError, type BoardChoiceSource } from '../src/community/setup-board-picker';

// Actual component observations, authored UNRUN. CSS geometry, keyboard navigation, focus outlines,
// localized wrapping and physical 44px targets are observed by the new canonical stories, also UNRUN.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { SetupBoardPicker } = await import('../src/community/setup-board-picker-control');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const originalLocale = getLocale();
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
type Props = ComponentProps<typeof SetupBoardPicker>;
const schemeId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const otherSchemeId = '0192f3a0-6c1e-7b2a-9d4e-000000000005';
const choices = [
  { id: '0192f3a0-6c1e-7b2a-9d4e-000000000004', label: 'Supplied introduction' },
  { id: '0192f3a0-6c1e-7b2a-9d4e-000000000006', label: 'Supplied reading topic' },
];
const cursor = 'opaque:/sparse+window?token=%2F==';
const source: BoardChoiceSource = {
  conceptQuery: 'loaded-page',
  schemes: async () => ({ schemes: choices, next: null }),
  concepts: async () => ({ concepts: choices, next: null }),
};
function props(extra: Partial<Props> = {}): Props {
  return { kind: 'concept', schemeId, source, value: null, disabled: false, onChange: mock(), ...extra };
}
async function tick(milliseconds = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}
async function paint(input: Props) {
  setLocale('en', { reload: false });
  root ??= createRoot(host);
  await act(async () => {
    root!.render(<SetupBoardPicker {...input} />);
  });
  await tick();
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
  });
  await tick();
}
async function edit(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await tick();
}
function button(text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === text,
  );
  expect(found).toBeDefined();
  return found!;
}
function radios() {
  return [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
}
function inline(text: string) {
  expect(host.textContent).toContain(text);
  expect(host.querySelector('details')).toBeNull();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  root = undefined;
  host.removeAttribute('dir');
  host.removeAttribute('style');
  await tick();
});
afterAll(() => {
  setLocale(originalLocale, { reload: false });
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Complete usable setup Board choice controls: actual scheme and concept choices retain exact supplied IDs', async () => {
  const onChange = mock();
  for (const kind of ['scheme', 'concept'] as const) {
    const input = props({ kind, onChange });
    await paint(input);
    await tick(280);
    expect(radios()).toHaveLength(2);
    expect(host.textContent).not.toContain(m.space_setup_board_choice_updating());
    for (const [index, radio] of radios().entries()) {
      const label = radio.closest('label')!;
      expect(label.htmlFor).toBe(radio.id);
      expect(label.textContent).toBe(choices[index]!.label);
      expect(host.textContent).not.toContain(choices[index]!.id);
    }
    await click(radios()[1]!);
    expect(onChange).toHaveBeenLastCalledWith(choices[1]);
    await paint({ ...input, value: choices[1]! });
    expect(radios()[1]!.getAttribute('aria-checked')).toBe('true');
    await click(button(m.space_setup_board_choice_clear()));
    expect(onChange).toHaveBeenLastCalledWith(null);
    inline(kind === 'scheme' ? m.space_setup_board_scheme_choices_hint() : m.space_setup_concept_hint());
  }
});

test('full supplied long and unbroken labels remain in selected and radio text, in LTR and RTL layouts', async () => {
  const label = `Supplied 閱讀 موضوعات ${'UnbrokenSuppliedLabel'.repeat(24)}`;
  const choice = { ...choices[0]!, label };
  const longSource: BoardChoiceSource = {
    ...source,
    concepts: async () => ({ concepts: [choice], next: null }),
  };
  for (const width of [390, 1280]) {
    for (const direction of ['ltr', 'rtl']) {
      host.dir = direction;
      host.style.width = `${width}px`;
      await paint(props({ source: longSource, value: choice }));
      await tick(280);
      expect(radios()[0]!.closest('label')!.textContent).toBe(label);
      expect(host.textContent!.split(label)).toHaveLength(3);
      inline(m.space_setup_concept_hint());
      inline(m.space_setup_board_choice_local_hint());
      expect(host.querySelector('[title], details, [data-slot="tooltip-content"]')).toBeNull();
    }
  }
});

test('successful empty is distinct from loaded-page local no-match, which does not read another page', async () => {
  await paint(props({ kind: 'scheme', source: { ...source, schemes: async () => ({ schemes: [], next: null }) } }));
  await tick(280);
  inline(m.space_setup_board_choice_no_matches());
  expect(host.textContent).not.toContain(m.space_setup_board_choice_unavailable());
  const concepts = mock(async () => ({ concepts: choices, next: null }));
  await paint(props({ source: { ...source, concepts } }));
  await tick(280);
  await edit('not on this loaded page');
  inline(m.space_setup_board_choice_local_empty());
  inline(m.space_setup_board_choice_local_hint());
  expect(radios()).toHaveLength(0);
  expect(concepts).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain(m.space_setup_board_choice_no_matches());
  await edit('reading');
  expect(radios()).toHaveLength(1);
  expect(radios()[0]!.closest('label')!.textContent).toBe(choices[1]!.label);
  await edit('');
  expect(radios()).toHaveLength(2);
  expect(concepts).toHaveBeenCalledTimes(1);
});

test('sparse empty keeps its exact opaque Next cursor and supplied updating status without automatic reads', async () => {
  const concepts = mock(async (input: Parameters<BoardChoiceSource['concepts']>[0]) => ({
    concepts: input.cursor === undefined ? [] : choices,
    next: input.cursor === undefined ? cursor : null,
    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: false } as const,
  }));
  await paint(props({ source: { ...source, concepts } }));
  await tick(280);
  inline(m.space_setup_board_choice_local_empty());
  inline(m.space_setup_board_choice_updating());
  expect(concepts).toHaveBeenCalledTimes(1);
  await edit('reading');
  expect(concepts).toHaveBeenCalledTimes(1);
  await click(button(m.space_setup_board_choice_next()));
  expect(concepts).toHaveBeenLastCalledWith({ query: 'reading', schemeId, cursor });
  expect(radios()).toHaveLength(1);
  inline(m.space_setup_board_choice_updating());
  expect(host.textContent).not.toContain(cursor);
});

test('loading and each refusal keep the selected value and hints inline rather than becoming successful empty', async () => {
  const pending = deferred<Awaited<ReturnType<BoardChoiceSource['concepts']>>>();
  await paint(props({ value: choices[0]!, source: { ...source, concepts: () => pending.promise } }));
  await tick(280);
  inline(m.space_setup_loading());
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  const cases = [
    ['denied', 403, m.space_setup_denied()],
    ['stale', 410, m.space_setup_board_choice_stale()],
    ['invalid', 400, m.space_setup_invalid()],
    ['unavailable', 503, m.space_setup_board_choice_unavailable()],
  ] as const;
  for (const [reason, status, text] of cases) {
    const concepts = mock(async () => {
      throw new BoardChoiceError(reason, status);
    });
    await paint(props({ value: choices[0]!, source: { ...source, concepts } }));
    await tick(280);
    inline(text);
    inline(choices[0]!.label);
    inline(m.space_setup_board_choice_local_hint());
    expect(host.textContent).not.toContain(m.space_setup_board_choice_local_empty());
    expect(host.textContent).not.toContain(m.space_setup_board_choice_no_matches());
    expect(concepts).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain(m.space_setup_board_choice_restart());
    await click(button(m.space_setup_retry()));
    expect(concepts).toHaveBeenCalledTimes(2);
  }
  pending.resolve({ concepts: [{ ...choices[0]!, label: 'Retired loading result' }], next: null });
  await tick();
  expect(host.textContent).not.toContain('Retired loading result');
});

for (const kind of ['scheme', 'concept'] as const)
  for (const reason of ['stale', 'invalid', 'unavailable'] as const)
    test(`${kind} ${reason} continuation recovers explicitly without readmitting the selected ID`, async () => {
      const read = mock(async (input: { query: string; cursor?: string }) => {
        if (input.cursor !== undefined)
          throw new BoardChoiceError(reason, reason === 'stale' ? 410 : reason === 'invalid' ? 400 : 503);
        return { schemes: choices, concepts: choices, next: cursor };
      });
      const input = props({ kind, value: choices[1]!, source: { ...source, schemes: read, concepts: read } });
      await paint(input);
      await tick(280);
      await edit('reading');
      await tick(280);
      const first = { query: 'reading', ...(kind === 'concept' ? { schemeId } : {}) };
      const before = read.mock.calls.length;
      await click(button(m.space_setup_board_choice_next()));
      inline(
        reason === 'stale'
          ? m.space_setup_board_choice_stale()
          : reason === 'invalid'
            ? m.space_setup_invalid()
            : m.space_setup_board_choice_unavailable(),
      );
      if (reason !== 'stale') {
        await click(button(m.space_setup_retry()));
        expect(read).toHaveBeenLastCalledWith({ ...first, cursor });
        expect(read).toHaveBeenCalledTimes(before + 2);
      }
      await click(button(reason === 'stale' ? m.space_setup_retry() : m.space_setup_board_choice_restart()));
      expect(read).toHaveBeenLastCalledWith(first);
      expect(read).toHaveBeenCalledTimes(before + (reason === 'stale' ? 2 : 3));
      expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('reading');
      expect(radios().find((radio) => radio.getAttribute('aria-checked') === 'true')).toBeDefined();
      expect(input.onChange).not.toHaveBeenCalled();
    });

test('disabled search, selected Clear, ready choices, Next and Retry cannot dispatch work', async () => {
  const concepts = mock(async () => ({ concepts: choices, next: cursor }));
  const onChange = mock();
  const input = props({ value: choices[0]!, onChange, source: { ...source, concepts } });
  await paint({ ...input, disabled: true });
  expect(concepts).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.disabled).toBe(true);
  expect(button(m.space_setup_board_choice_clear()).disabled).toBe(true);
  await paint(input);
  await tick(280);
  await paint({ ...input, disabled: true });
  expect(button(m.space_setup_board_choice_next()).disabled).toBe(true);
  for (const radio of radios()) expect(radio.matches(':disabled, [aria-disabled="true"], [data-disabled]')).toBe(true);
  await click(button(m.space_setup_board_choice_clear()));
  await click(button(m.space_setup_board_choice_next()));
  expect(onChange).not.toHaveBeenCalled();
  expect(concepts).toHaveBeenCalledTimes(1);
  const refused = mock(async () => {
    throw new BoardChoiceError('unavailable', 503);
  });
  const refusedInput = { ...input, source: { ...source, concepts: refused } };
  await paint(refusedInput);
  await tick(280);
  await paint({ ...refusedInput, disabled: true });
  expect(button(m.space_setup_retry()).disabled).toBe(true);
  await click(button(m.space_setup_retry()));
  expect(refused).toHaveBeenCalledTimes(1);
});

test('source replacement and ABA retirement discard late results and detached choice/Next controls', async () => {
  const pending = deferred<Awaited<ReturnType<BoardChoiceSource['schemes']>>>();
  let reads = 0;
  const schemes = mock(async () => (++reads === 1 ? pending.promise : { schemes: choices, next: cursor }));
  const first = { ...source, schemes };
  const replacement = {
    ...source,
    schemes: mock(async () => ({ schemes: [{ ...choices[0]!, label: 'Replacement' }], next: cursor })),
  };
  const onChange = mock();
  await paint(props({ kind: 'scheme', source: first, onChange }));
  await tick(280);
  await paint(props({ kind: 'scheme', source: replacement, onChange }));
  await tick(280);
  const retiredRadio = radios()[0]!;
  const retiredNext = button(m.space_setup_board_choice_next());
  await paint(props({ kind: 'scheme', source: first, onChange }));
  expect(radios()).toHaveLength(0);
  await click(retiredRadio);
  await click(retiredNext);
  expect(onChange).not.toHaveBeenCalled();
  expect(replacement.schemes).toHaveBeenCalledTimes(1);
  await tick(280);
  pending.resolve({ schemes: [{ ...choices[0]!, label: 'Retired first generation' }], next: null });
  await tick();
  expect(radios()[0]!.closest('label')!.textContent).toBe(choices[0]!.label);
  expect(host.textContent).not.toContain('Retired first generation');
});

test('changed scheme and query mask old results immediately and unmount retires pending reads', async () => {
  const old = deferred<Awaited<ReturnType<BoardChoiceSource['concepts']>>>();
  const current = deferred<Awaited<ReturnType<BoardChoiceSource['concepts']>>>();
  const concepts = mock((input: Parameters<BoardChoiceSource['concepts']>[0]) =>
    input.schemeId === schemeId ? old.promise : current.promise,
  );
  const input = props({ source: { ...source, concepts } });
  await paint(input);
  await tick(280);
  await paint({ ...input, schemeId: otherSchemeId });
  expect(radios()).toHaveLength(0);
  await tick(280);
  old.resolve({ concepts: [{ ...choices[0]!, label: 'Old scheme result' }], next: null });
  current.resolve({ concepts: choices, next: null });
  await tick();
  expect(host.textContent).not.toContain('Old scheme result');
  expect(concepts).toHaveBeenLastCalledWith({ schemeId: otherSchemeId, query: '' });
  await edit('absent');
  inline(m.space_setup_board_choice_local_empty());
  expect(concepts).toHaveBeenCalledTimes(2);
  type SchemePage = Awaited<ReturnType<BoardChoiceSource['schemes']>>;
  const previousQuery = deferred<SchemePage>();
  const currentQuery = deferred<SchemePage>();
  const retiredQuery = deferred<SchemePage>();
  const schemes = mock((input: Parameters<BoardChoiceSource['schemes']>[0]) =>
    input.query === ''
      ? previousQuery.promise
      : input.query === 'new supplied query'
        ? currentQuery.promise
        : retiredQuery.promise,
  );
  const schemeInput = props({ kind: 'scheme', source: { ...source, schemes } });
  await paint(schemeInput);
  await edit('');
  await tick(280);
  await edit('new supplied query');
  expect(radios()).toHaveLength(0);
  await tick(280);
  expect(schemes).toHaveBeenLastCalledWith({ query: 'new supplied query' });
  previousQuery.resolve({ schemes: [{ ...choices[0]!, label: 'Old query result' }], next: null });
  await tick();
  expect(radios()).toHaveLength(0);
  expect(host.textContent).not.toContain('Old query result');
  currentQuery.resolve({ schemes: choices, next: cursor });
  await tick();
  expect(radios()).toHaveLength(2);
  const retiredNext = button(m.space_setup_board_choice_next());
  await edit('retired query');
  await click(retiredNext);
  await tick(280);
  expect(schemes).toHaveBeenLastCalledWith({ query: 'retired query' });
  await act(async () => {
    root!.unmount();
  });
  root = undefined;
  retiredQuery.resolve({ schemes: choices, next: cursor });
  await tick();
  expect(host.textContent).toBe('');
  expect(schemes).toHaveBeenCalledTimes(3);
});
