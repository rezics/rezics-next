import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import { CollectionRuleEditor } from '../src/library/collection-rule-editor';
import { unavailableRuleChoices, type RulePage } from '../src/library/collection-rule-read';
import type { RuleWrite } from '../src/library/collection-rule-actions';
import { m } from '../src/paraglide/messages.js';

type Props = ComponentProps<typeof CollectionRuleEditor>;
const key = '10000000-0000-4000-8000-000000000001';
const paragraphs = 'Opening line\n\nBlank-separated paragraph';
const page: Extract<RulePage, { state: 'new' }> = {
  state: 'new',
  viewerId: 'alice',
  intent: key,
  choices: unavailableRuleChoices(),
};

async function mount(save: Props['save'] = async () => ({ ok: false, reason: 'invalid' })) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/rules/new' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const testing = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testing));
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let props: Props = {
    page,
    viewerId: 'alice',
    collectionId: null,
    csrfToken: 'csrf-alice',
    admitted: ['collection.create'],
    save,
    reload: async () => page,
  };
  async function render(patch: Partial<Props> = {}) {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(
        <StrictMode>
          <CollectionRuleEditor {...props} />
        </StrictMode>,
      ),
    );
  }
  await render();
  return {
    host,
    window,
    user: userEvent.setup({ document: window.document as unknown as Document, delay: null }),
    render,
    labelled(name: string) {
      const field = [...host.querySelectorAll('label')].find((node) => node.textContent === name);
      expect(field?.htmlFor).toBeTruthy();
      return window.document.getElementById(field!.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
    },
    async fill(name: string, value: string) {
      const control = this.labelled(name);
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')!.set!.call(control, value);
        control.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
      });
      return control;
    },
    async submit() {
      const form = host.querySelector('form');
      expect(form).not.toBeNull();
      await act(async () => {
        form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
      });
    },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

test('new dynamic Collection description keeps Enter and pasted paragraph breaks in a labelled multiline control', async () => {
  const ui = await mount();
  try {
    const control = ui.labelled(m.library_collection_description());
    expect(control.tagName).toBe('TEXTAREA');
    expect(control.getAttribute('aria-describedby')).toBeTruthy();
    await act(async () => {
      await ui.user.click(control);
      await ui.user.paste(paragraphs);
    });
    expect(control.value).toBe(paragraphs);
    await act(async () => {
      await ui.user.clear(control);
      await ui.user.type(control, 'First{Enter}{Enter}Third');
    });
    expect(control.value).toBe('First\n\nThird');
  } finally {
    await ui.close();
  }
});

test('creating with a valid multiline description sends the exact paragraphs, bound and linked help', async () => {
  const calls: RuleWrite[] = [];
  const ui = await mount(async (value) => {
    calls.push(value);
    return { ok: true, id: 'created' };
  });
  try {
    const control = ui.labelled(m.library_collection_description());
    expect(control.hasAttribute('maxlength')).toBe(false);
    expect(ui.window.document.getElementById(control.getAttribute('aria-describedby')!)!.textContent).toBe(
      m.library_collection_text_input_description_help(),
    );
    await ui.fill(m.library_collection_title(), 'Private reading');
    await ui.fill(m.library_collection_description(), paragraphs);
    await ui.submit();
    expect(calls[0]!.description).toBe(paragraphs);
    expect(calls[0]!.title).toBe('Private reading');
  } finally {
    await ui.close();
  }
});

test('Stay after recoverable create refusal keeps the multiline draft; confirmed creation clears dirty baseline', async () => {
  const calls: RuleWrite[] = [];
  const ui = await mount(async (value) => {
    calls.push(value);
    return calls.length === 1 ? { ok: false, reason: 'invalid' } : { ok: true, id: 'created' };
  });
  try {
    await ui.fill(m.library_collection_title(), 'Private reading');
    await ui.fill(m.library_collection_description(), paragraphs);
    await ui.submit();
    expect(calls[0]!.description).toBe(paragraphs);
    await ui.render();
    expect(ui.labelled(m.library_collection_description()).value).toBe(paragraphs);
    await ui.submit();
    expect(calls[1]!.description).toBe(paragraphs);
    expect(ui.host.textContent).toContain(m.library_rule_saved());
    expect(ui.labelled(m.library_collection_description()).closest('fieldset')?.disabled).toBe(true);
  } finally {
    await ui.close();
  }
});

test('new rule corrects native text before capture and accepts raw scalar boundaries', async () => {
  const calls: RuleWrite[] = [];
  const ui = await mount(async (value) => {
    calls.push(value);
    return { ok: false, reason: 'invalid' };
  });
  try {
    await ui.fill(m.library_collection_title(), '😀'.repeat(201));
    await ui.submit();
    expect(calls).toHaveLength(0);
    expect(ui.labelled(m.library_collection_title()).getAttribute('aria-invalid')).toBe('true');
    const title = ' ' + '😀'.repeat(199),
      description = '\n' + '😀'.repeat(1999);
    await ui.fill(m.library_collection_title(), title);
    await ui.fill(m.library_collection_description(), description);
    await ui.submit();
    expect(calls[0]).toMatchObject({ title, description });
  } finally {
    await ui.close();
  }
});
