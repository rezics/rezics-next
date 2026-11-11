import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { chooseSelect } from './select-interaction';

test('application choices keep submitted names, currency reset, required state and manual queue navigation', async () => {
  const { Window } = await import('happy-dom');
  const browser = new Window({ url: 'https://site.test/en/creator/offers/new' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Document: browser.Document,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CreatorPriceFields } = await import('../src/checkout/creator-offer-editor');
  const { configuredPriceExample } = await import('../src/kernel/fake/creator-offers');
  const { ManualModerationScope } = await import('../src/moderation/workbench-queue/manual-scope');
  const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  function Price({ disabled = false }: { disabled?: boolean }) {
    const [intent, onChange] = useState({ currency: '', text: '' });
    return (
      <form>
        <CreatorPriceFields
          rules={configuredPriceExample.configuredSaleCurrencies}
          intent={intent}
          onChange={onChange}
          locale="en"
          disabled={disabled}
        />
      </form>
    );
  }
  try {
    await act(async () => root.render(<Price />));
    const trigger = host.querySelector<HTMLButtonElement>('[role=combobox]')!;
    const form = host.querySelector('form')!;
    expect(host.querySelector(`label[for="${trigger.id}"]`)!.textContent).toBe(m.creator_currency());
    expect(form.checkValidity()).toBe(false);
    await chooseSelect(trigger, 'USD');
    const price = host.querySelector<HTMLInputElement>('input[name=price]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(price, '12.99');
      price.dispatchEvent(new browser.Event('input', { bubbles: true }));
    });
    expect(new browser.FormData(form as never).get('currency')).toBe('usd');
    expect(form.checkValidity()).toBe(true);
    await chooseSelect(trigger, 'EUR');
    expect(price.value).toBe('');
    expect(new browser.FormData(form as never).get('currency')).toBe('eur');
    await act(async () => root.render(<Price disabled />));
    expect(trigger.disabled).toBe(true);
    expect(new browser.FormData(form as never).has('currency')).toBe(false);

    const moves: string[] = [];
    await act(async () =>
      root.render(
        <ManualModerationScope
          search={workbenchSearch({})}
          onSearch={(search) => moves.push(`${search.board}:${search.queue}`)}
        />,
      ),
    );
    const board = host.querySelector<HTMLInputElement>('input[name=board]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(board, 'board-exact');
      board.dispatchEvent(new browser.Event('input', { bubbles: true }));
    });
    await chooseSelect(host.querySelector<HTMLElement>('[role=combobox]')!, m.moderation_workbench_queue_appeals());
    const navigation = host.querySelector('form')!;
    expect(new browser.FormData(navigation as never).get('queue')).toBe('appeals');
    await act(async () => {
      navigation.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(moves).toEqual(['board-exact:appeals']);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
