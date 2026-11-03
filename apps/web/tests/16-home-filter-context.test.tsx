import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { HomeFeedConsumer } from '../src/features/pages/home-feed';
import { HomeFeedKindControl } from '../src/features/pages/home-feed-kind-control';
import { HomeFeedQuestionControl } from '../src/features/pages/home-feed-question-control';
import { createHomeKindChoices } from '../src/features/pages/home-feed-kinds';
import { createHomeQuestionChoices, type QuestionPointResult } from '../src/features/pages/home-feed-questions';
import {
  homeFeedHistoryState,
  homeFeedNavigationDescriptor,
  type FeedInput,
  type HomeFeedResult,
} from '../src/features/pages/home-feed-read';
import {
  homeFeedStoryPage,
  homeKindStoryPage,
  homeQuestionStoryPage,
  homeStorySpace,
} from '../src/kernel/fake/home-feed-stories';
import { m } from '../src/paraglide/messages.js';
import { locales, type Locale } from '../src/paraglide/runtime.js';
import { renderToStaticMarkup } from 'react-dom/server';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const question = homeQuestionStoryPage().ratingQuestions[0]!;
const kind = homeKindStoryPage().values[0]!;
const result: HomeFeedResult = {
  state: 'ready',
  page: { ...homeFeedStoryPage('en', false, 'empty'), next: 'prepared-next' },
};
async function surface(locale: Locale, phone = false, size = 1) {
  const browser = new Window({ url: `https://rezics.example/${locale}/`, width: phone ? 390 : 1280 });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    Element: browser.Element,
    Node: browser.Node,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const host = browser.document.createElement('div') as unknown as HTMLElement;
  browser.document.body.append(host);
  const root = createRoot(host);
  const calls: FeedInput[] = [];
  const signals: AbortSignal[] = [];
  let metadata = 0;
  let fail = false;
  let held: ((result: QuestionPointResult) => void) | undefined;
  let hold = false;
  const props = {
    initial: result,
    locale,
    signedIn: true,
    origin: 'https://rezics.example',
    read: async (input: FeedInput, signal: AbortSignal) => {
      calls.push(input);
      signals.push(signal);
      return result;
    },
    readKinds: async () => {
      metadata++;
      return {
        status: 'ready' as const,
        kinds: { values: Array.from({ length: size }, (_, i) => ({ ...kind, id: `schema:Prepared${i}` })), next: null },
      };
    },
    readSpace: async () => {
      metadata++;
      return fail ? { status: 'denied' as const } : { status: 'ready' as const, space: homeStorySpace };
    },
    readQuestions: async (cursor: string | undefined) => {
      metadata++;
      return {
        status: 'ready' as const,
        page: cursor
          ? homeQuestionStoryPage(cursor)
          : {
              ratingQuestions: Array.from({ length: Math.min(size, 20) }, (_, i) => ({
                ...question,
                id: `00000000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
              })),
              next: 'prepared-question-next',
            },
      };
    },
    readQuestion: async (): Promise<QuestionPointResult> => {
      metadata++;
      if (hold)
        return new Promise((resolve) => {
          held = resolve;
        });
      return fail ? { status: 'lost', code: 'not_found' } : { status: 'ready', question };
    },
  };
  let account = 'A';
  const render = () => act(async () => root.render(<HomeFeedConsumer key={account} {...props} />));
  const options = { locale };
  const button = (name: string, within: ParentNode = host) => {
    const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === name || node.getAttribute('aria-label') === name,
    );
    if (!found) throw new Error(`Missing button: ${name}`);
    return found;
  };
  const panel = () => host.querySelector<HTMLElement>('[data-home-filter-surface]')!;
  const click = async (name: string, within?: ParentNode) => act(async () => button(name, within).click());
  const select = async (label: string, value: string) =>
    act(async () => {
      const section = panel().querySelector(`[aria-label="${label}"]`)!;
      const node = section.querySelector('select')!;
      node.value = value;
      node.dispatchEvent(new browser.Event('change', { bubbles: true }));
    });
  await render();
  return {
    browser,
    host,
    calls,
    signals,
    panel,
    button,
    click,
    select,
    options,
    metadata: () => metadata,
    async open() {
      const opener = host.querySelector<HTMLButtonElement>('button[aria-controls]')!;
      opener.focus();
      await act(async () => opener.click());
      return opener;
    },
    async chooseAll() {
      await click(m.home_kinds_load({}, options));
      await select(m.home_kind_label({}, options), 'schema:Prepared0');
      await act(async () => {
        const input = panel().querySelector('input')!;
        const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, homeStorySpace.address);
        input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      });
      // Submit the admitted address; React owns the input, lookup and subsequent explicit selection.
      await act(async () =>
        panel()
          .querySelector('form')!
          .dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })),
      );
      await click(m.home_space_select({}, options));
      await click(m.home_questions_load({}, options));
      await select(m.home_question_label({}, options), question.id);
    },
    async restore(input: FeedInput) {
      browser.history.replaceState(
        homeFeedHistoryState({}, homeFeedNavigationDescriptor(input, browser.location, locale)),
        '',
        browser.location.href,
      );
      await act(async () => browser.dispatchEvent(new browser.PopStateEvent('popstate')));
    },
    fail() {
      fail = true;
    },
    hold() {
      hold = true;
    },
    release() {
      held?.({ status: 'ready', question });
    },
    async account(value: string) {
      account = value;
      await render();
    },
    async close() {
      await act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('phone and desktop retain immediate meaning, keyboard focus and independent removal in eight locales', async () => {
  for (const locale of locales)
    for (const phone of [false, true]) {
      const view = await surface(locale, phone);
      const o = view.options;
      try {
        const before = [view.calls.length, view.metadata()];
        const opener = await view.open();
        expect([view.calls.length, view.metadata()]).toEqual(before);
        expect(view.panel().getAttribute('data-home-filter-surface')).toBe(phone ? 'sheet' : 'panel');
        expect(view.panel().contains(view.browser.document.activeElement as unknown as Node)).toBe(true);
        expect(view.panel().getAttribute('aria-modal')).toBe(phone ? 'true' : null);
        await view.chooseAll();
        expect(view.calls.at(-1)).toEqual({
          stream: 'home',
          kind: 'schema:Prepared0',
          spaceId: homeStorySpace.spaceId,
          ratingQuestionId: question.id,
        });
        const footer = view.panel().lastElementChild!;
        expect(footer.textContent).toContain(homeStorySpace.title);
        expect(footer.textContent).toContain(m.home_question_work({}, o));
        expect(footer.textContent).toContain(m.home_question_help({}, o));
        const selectedRead = view.calls.length;
        await view.click(m.home_questions_next({}, o)); // Selected choice survives replacement of its directory page.
        expect(view.calls.length).toBe(selectedRead);
        expect(view.panel().querySelectorAll('select')[1]!.value).toBe(question.id);
        const remove = footer.querySelector<HTMLButtonElement>('[data-home-filter-remove=space]')!;
        remove.focus();
        await act(async () => remove.click());
        expect(view.calls.length).toBe(selectedRead + 1);
        expect(view.calls.at(-1)).toEqual({ stream: 'home', kind: 'schema:Prepared0', ratingQuestionId: question.id });
        expect(view.browser.document.activeElement?.getAttribute('data-home-filter-remove')).toBe('question');
        const first = view.panel().querySelector<HTMLButtonElement>('button')!;
        first.focus();
        await act(async () =>
          first.dispatchEvent(new view.browser.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })),
        );
        expect(view.panel().contains(view.browser.document.activeElement as unknown as Node)).toBe(true);
        await act(async () =>
          view.panel().dispatchEvent(new view.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
        );
        expect(view.panel().hidden).toBe(true);
        expect(view.browser.document.activeElement).toBe(opener);
        expect(view.host.querySelector('[inert]')).toBeNull();
        expect(view.host.querySelector('a[href]')?.getAttribute('href')).toContain(`/${locale}/`);
      } finally {
        await view.close();
      }
    }
});

test('clear-all retires pending metadata and replaces once; history, cursor and account visits keep the original owner', async () => {
  const view = await surface('en', true);
  try {
    await view.open();
    await view.chooseAll();
    const admitted = { ...view.calls.at(-1)! };
    await view.click(m.library_next_page());
    expect(view.calls.at(-1)).toEqual({ ...admitted, cursor: 'prepared-next' });
    await view.click(m.home_feed_following());
    const following = { ...view.calls.at(-1)! };
    expect(following.cursor).toBeUndefined();
    view.hold();
    await view.click(m.home_question_refresh());
    const count = view.calls.length;
    await view.click(m.refinement_clear(), view.panel());
    expect(view.calls.length).toBe(count + 1);
    expect(view.calls.at(-1)).toEqual({ stream: 'following' });
    await act(async () => view.release());
    expect(view.calls.length).toBe(count + 1);
    expect(view.panel().querySelectorAll('[data-home-filter-remove]')).toHaveLength(0);
    // Back/Forward use exact descriptors and revalidate metadata, never a cached private page.
    await view.restore({ stream: 'home', kind: admitted.kind!, cursor: 'prepared-next' });
    expect(view.calls.at(-1)).toEqual({ stream: 'home', kind: admitted.kind!, cursor: 'prepared-next' });
    await view.restore({ stream: 'following' });
    expect(view.calls.at(-1)).toEqual({ stream: 'following' });
    await view.account('B');
    expect(view.panel().hidden).toBe(true);
    await view.open();
    await view.account('A-return');
    expect(view.panel().hidden).toBe(true);
    expect(view.signals.slice(0, -1).every((signal) => signal.aborted)).toBe(true);
  } finally {
    await view.close();
  }
});

test('failed restored choices remain explained and removable without an unfiltered feed read', async () => {
  const view = await surface('en');
  try {
    await view.open();
    await view.chooseAll();
    view.fail();
    await view.click(m.home_space_refresh());
    expect(view.panel().textContent).toContain(m.home_feed_denied());
    const count = view.calls.length;
    await view.click(m.home_question_refresh());
    expect(view.calls.length).toBe(count);
    expect(view.panel().textContent).toContain(m.home_questions_lost());
    await view.click(m.refinement_remove({ value: question.label }), view.panel());
    expect(view.calls.length).toBe(count); // The still-denied Space suppresses replacement.
    await view.click(m.refinement_clear(), view.panel());
    expect(view.calls.length).toBe(count + 1);
    await view.restore({ stream: 'home', ratingQuestionId: question.id });
    expect(view.calls.length).toBe(count + 1);
    expect(view.panel().textContent).toContain(m.home_filter_metadata_unavailable());
    expect(view.button(m.home_question_refresh(), view.panel())).toBeDefined();
    await view.click(m.refinement_clear(), view.panel());
    expect(view.calls.length).toBe(count + 2);
  } finally {
    await view.close();
  }
});

test('1/10/100 bounded choices project linearly and open/close/clear add no metadata reads', async () => {
  for (const size of [1, 10, 100]) {
    const view = await surface('en', false, size);
    try {
      const opener = await view.open();
      await view.chooseAll();
      const counts = view.panel().querySelectorAll('select');
      expect(counts[0]!.options.length).toBe(size + 1);
      expect(counts[1]!.options.length).toBe(Math.min(size, 20) + 1);
      const before = [view.calls.length, view.metadata()];
      await act(async () => opener.click());
      await view.open();
      expect([view.calls.length, view.metadata()]).toEqual(before);
      await view.click(m.refinement_clear(), view.panel());
      expect([view.calls.length, view.metadata()]).toEqual([before[0]! + 1, before[1]!]);
    } finally {
      await view.close();
    }
  }
});

test('kind preparation/refusal and question loading/loss retain the selected native option and retry', () => {
  for (const locale of locales) {
    const o = { locale };
    const choices = createHomeKindChoices(async () => ({ status: 'unavailable' }));
    for (const status of ['loading', 'preparing', 'denied', 'unavailable'] as const) {
      const html = renderToStaticMarkup(
        <HomeFeedKindControl
          choices={choices}
          locale={locale}
          snapshot={{ status, selected: { id: 'schema:Retained', text: 'Prepared retained type' } }}
          onSelect={() => {}}
        />,
      );
      expect(html).toContain('Prepared retained type');
      expect(html).toContain('schema:Retained');
      expect(html).toContain(
        status === 'loading'
          ? m.home_kinds_loading({}, o)
          : status === 'preparing'
            ? m.discovery_preparing({}, o)
            : status === 'denied'
              ? m.discovery_denied({}, o)
              : m.home_kinds_unavailable({}, o),
      );
    }
    const questions = createHomeQuestionChoices(
      async () => ({ status: 'unavailable', code: 'prepared' }),
      async () => ({ status: 'lost', code: 'prepared' }),
      () => {},
    );
    const html = renderToStaticMarkup(
      <HomeFeedQuestionControl
        choices={questions}
        locale={locale}
        snapshot={{ status: 'denied', selected: question, selection: 'lost' }}
      />,
    );
    expect(html).toContain(question.label);
    expect(html).toContain(m.home_questions_lost({}, o));
    expect(html).toContain(m.home_questions_retry({}, o));
  }
});
