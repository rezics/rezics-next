import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { contextFixture } from '../src/features/contexts/fixtures';
import { parseSettingsSnapshot, type SettingsRead } from '../src/features/contexts/settings';
import type { Command, MutationResult } from '../src/features/contexts/model';
import { editorialContextFixture } from '../src/kernel/fake/editorial-context';
import type { EditorialTransport } from '../src/features/catalogue/editorial-context';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://context.invalid/en/my/contexts/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLSelectElement: window.HTMLSelectElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { userEvent } = await import('storybook/test');
const { ContextCreateView } = await import('../src/features/contexts/view');
const { EditorialContextWorkspace } = await import('../src/features/catalogue/editorial-context-view');
const { m } = await import('../src/paraglide/messages.js');
const o = { locale: 'en' as const };
const noop = async () => {};
const digest = 'sha256:preview-release';
const snapshot = parseSettingsSnapshot(digest, {
  contexts: {
    'inherit-readers': { labels: { en: 'Inherit readers' }, defaults: { 'schema:url': 'inherit' } },
    'suppress-readers': { labels: { en: 'Suppress readers' }, defaults: { 'schema:url': 'suppress' } },
  },
  properties: { 'schema:url': { labels: { en: 'URL' } } },
})!;

afterAll(async () => {
  await window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(node: ReactNode) {
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 40 && !predicate(); turn++) await flush();
  expect(predicate()).toBe(true);
}
function button(host: ParentNode, label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

test('denied and empty inventories stay honest while no-setting creation remains the default', async () => {
  const denied = await mount(
    <ContextCreateView
      locale="en"
      actions={contextFixture('create').initialCreation()}
      submit={async () => ({ kind: 'denied' })}
      reload={noop}
      settings={{ kind: 'denied' }}
    />,
  );
  try {
    expect(denied.host.textContent).toContain(m.ctxw_policy_denied({}, o));
    expect(denied.host.querySelector('[data-context-settings-picker] input[type="radio"]')).toBeNull();
    expect(denied.host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  } finally {
    await denied.dispose();
  }
  const empty = await mount(
    <ContextCreateView
      locale="en"
      actions={contextFixture('create').initialCreation()}
      submit={async () => ({ kind: 'denied' })}
      reload={noop}
      settings={{ kind: 'ready', snapshot: parseSettingsSnapshot(digest, { contexts: {} })! }}
    />,
  );
  try {
    expect(empty.host.textContent).toContain(m.ctxw_policy_empty({}, o));
    expect(empty.host.textContent).not.toContain(m.ctxw_policy_denied({}, o));
  } finally {
    await empty.dispose();
  }
});

test('both surfaces review multilingual labels, post the selected settings ID and report a meaning change', async () => {
  const fixture = contextFixture('create');
  const commands: Command[] = [];
  let inventory: SettingsRead = { kind: 'ready', snapshot };
  const panel = await mount(
    <ContextCreateView
      locale="en"
      actions={fixture.initialCreation()}
      submit={async (command) => {
        commands.push(command);
        return fixture.api.submit(command);
      }}
      reload={noop}
      settings={inventory}
      loadSettings={async () => inventory}
    />,
  );
  try {
    await until(() => !!panel.host.querySelector(`input[value="suppress-readers"]`));
    const name = panel.host.querySelector('input[id$="-text"]') as HTMLInputElement;
    await act(async () => userEvent.type(name, 'Desk'));
    await act(async () => userEvent.click(button(panel.host, m.ctxw_add_language({}, o))));
    const rows = [...panel.host.querySelectorAll('[data-context-label-row]')];
    expect(rows).toHaveLength(2);
    const second = rows[1]!.querySelector('select') as HTMLSelectElement;
    await act(async () => userEvent.selectOptions(second, 'ja'));
    await act(async () => userEvent.type(rows[1]!.querySelector('input') as HTMLInputElement, '机'));
    await act(async () => userEvent.click(panel.host.querySelector('input[value="suppress-readers"]') as HTMLInputElement));
    expect(panel.host.textContent).toContain(m.ctxw_review_creation({}, o));
    expect(panel.host.textContent).toContain('Desk');
    expect(panel.host.textContent).toContain('机');
    expect(panel.host.textContent).toContain('Suppress readers');
    inventory = {
      kind: 'ready',
      snapshot: parseSettingsSnapshot('sha256:next-release', {
        contexts: {
          'inherit-readers': { labels: { en: 'Inherit readers' }, defaults: { 'schema:url': 'inherit' } },
          'suppress-readers': { labels: { en: 'Suppress readers' }, defaults: { 'schema:url': 'inherit' } },
        },
        properties: { 'schema:url': { labels: { en: 'URL' } } },
      })!,
    };
    await act(async () => userEvent.click(button(panel.host, m.ctxw_create({}, o))));
    await until(() => (panel.host.textContent ?? '').includes(m.ctxw_policy_changed({}, o)));
    expect(commands).toHaveLength(0);
    await act(async () => userEvent.click(button(panel.host, m.ctxw_create({}, o))));
    await until(() => commands.length === 1);
    expect(commands[0]).toMatchObject({
      operation: 'create',
      labels: { en: 'Desk', ja: '机' },
      settings: 'suppress-readers',
    });
    expect(fixture.calls.find((call) => call.method === 'POST' && call.path === '/v1/contexts')!.body).toEqual({
      labels: { en: 'Desk', ja: '机' },
      settings: 'suppress-readers',
    });
    expect(panel.host.textContent).toContain(m.ctxw_confirmed({}, o));
    expect(panel.host.textContent).toContain('suppress-readers');
  } finally {
    await panel.dispose();
  }

  const editorial = editorialContextFixture('create');
  const sent: Parameters<EditorialTransport['submit']>[0][] = [];
  const catalogue = await mount(
    <EditorialContextWorkspace
      locale="en"
      transport={{
        read: editorial.transport.read,
        submit: async (command) => {
          sent.push(command);
          return editorial.transport.submit(command);
        },
        settings: {
          choices: async () => ({ kind: 'ready', snapshot }),
          captured: async () => ({ kind: 'ready', snapshot }),
        },
      }}
    />,
  );
  try {
    await until(() => !!catalogue.host.querySelector('input[value="inherit-readers"]'));
    await act(async () => userEvent.type(catalogue.host.querySelector('input[id$="-text"]') as HTMLInputElement, 'Shelf'));
    await act(async () => userEvent.click(catalogue.host.querySelector('input[value="inherit-readers"]') as HTMLInputElement));
    await act(async () => userEvent.click(button(catalogue.host, m.editorial_create({}, o))));
    await until(() => sent.length === 1);
    expect(sent[0]).toMatchObject({ operation: 'create', labels: { en: 'Shelf' }, settings: 'inherit-readers' });
    expect(editorial.calls[0]!.body).toEqual({ labels: { en: 'Shelf' }, settings: 'inherit-readers' });
  } finally {
    await catalogue.dispose();
  }
});

test('acknowledged create shows the returned policy when it differs from the reviewed preview', async () => {
  const panel = await mount(
    <ContextCreateView
      locale="en"
      actions={contextFixture('create').initialCreation()}
      submit={async (command): Promise<MutationResult> => ({
        kind: 'confirmed',
        operation: 'create',
        id: '018f1234-5678-7000-8000-000000000021',
        created: {
          id: '018f1234-5678-7000-8000-000000000021',
          kind: 'community',
          labels: command.operation === 'create' ? command.labels : {},
          settings: { id: 'inherit-readers', release: 'sha256:other-release' },
          defaults: { 'schema:url': 'inherit' },
        },
        current: { kind: 'unavailable' },
      })}
      reload={noop}
      settings={{ kind: 'ready', snapshot }}
      loadSettings={async () => ({ kind: 'unavailable' })}
    />,
  );
  try {
    await until(() => !!panel.host.querySelector('input[value="suppress-readers"]'));
    await act(async () => userEvent.type(panel.host.querySelector('input[id$="-text"]') as HTMLInputElement, 'Race'));
    await act(async () => userEvent.click(panel.host.querySelector('input[value="suppress-readers"]') as HTMLInputElement));
    await act(async () => userEvent.click(button(panel.host, m.ctxw_create({}, o))));
    await until(() => (panel.host.textContent ?? '').includes(m.ctxw_captured_mismatch({}, o)));
    expect(panel.host.textContent).toContain('inherit-readers');
    expect(panel.host.textContent).toContain('sha256:other-release');
  } finally {
    await panel.dispose();
  }
});
