import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, fn, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { browseMessages } from '../discover/browse-messages.ts';
import { zoneContentText } from '../language/untagged.ts';
import { copyOf } from '../wiki/messages.ts';
import { PositionControl } from '../wiki/position-control.tsx';
import { focusForTyping } from '../../../../packages/ui/src/test/focus.ts';
import { spaceHref } from '../address/path.ts';

const work = '00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const occurrence = '00000000-0000-4000-8000-000000000051';
const here = spaceHref('franchise-wiki', 'site', ['franchise', work]);
const chapter = 'Chapter 51: 遠方 — The last lantern';
const query = '遠方';
const requests: URL[] = [];
const pending = new Map<string, () => void>();
const consumed = new Set<string>();
const navigation = fn();

function answer(q: string) {
  const body = JSON.stringify({
    items: [
      {
        occurrence: `https://rezics.com/id/${q ? occurrence : work}`,
        labels: [{ value: q ? chapter : 'Chapter 1', language: 'en' }],
      },
    ],
    nextCursor: null,
    complete: true,
  });
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
          consumed.add(q);
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'application/json' } },
  );
}

/** Use the production JSON loader, holding the initial read across a newer
 * query, selection, sheet teardown and focus restoration. */
function Chooser({ locale = 'en', anonymous = false }: { locale?: UiLocale; anonymous?: boolean }) {
  const [destination, setDestination] = useState(`/${locale}${here}?position=all`);
  const position =
    new URL(destination, window.location.origin).searchParams.get('position') ?? undefined;
  const copy = copyOf(locale);
  const navigate = (href: string) => {
    navigation(href);
    setDestination(href);
  };
  return (
    <StoryRouteContext value={{ pathname: `/${locale}${here}`, onPush: navigate }}>
      <div
        onClickCapture={(event) => {
          // next/link is a plain anchor in stories; keep these deliberate later
          // choices in the route stand-in too.
          const anchor = (event.target as Element).closest('a');
          if (!anchor) return;
          event.preventDefault();
          navigate(anchor.getAttribute('href')!);
        }}
      >
        <PositionControl
          copy={copy}
          locale={locale}
          navigate={navigate}
          at={
            position === 'all'
              ? { kind: 'all' }
              : {
                  kind: 'position',
                  label: zoneContentText(chapter, 'en'),
                  note: copy.chosen,
                }
          }
          options={[]}
          more
          progress={{ href: here, current: !position, resolved: null }}
          everything={{ href: `${here}?position=all`, current: position === 'all' }}
          search={{
            work,
            position,
            actingSubject: anonymous ? undefined : actor,
            here,
            current: position === occurrence ? occurrence : null,
          }}
        />
        <output aria-label="Selected address" className="block break-all">
          {destination}
        </output>
      </div>
    </StoryRouteContext>
  );
}

const meta = {
  title: 'Zones/Wiki position with late reads',
  component: Chooser,
  beforeEach() {
    requests.length = 0;
    pending.clear();
    consumed.clear();
    navigation.mockClear();
    const fetch = window.fetch.bind(window);
    const mock = spyOn(window, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== `/api/main/v1/reading-positions/${work}`) return fetch(input, init);
      requests.push(url);
      const q = url.searchParams.get('q') ?? '';
      return new Promise<Response>((resolve) => pending.set(q, () => resolve(answer(q))));
    });
    return () => {
      pending.forEach((release) => release());
      mock.mockRestore();
    };
  },
} satisfies Meta<typeof Chooser>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CjkPhone: Story = {
  args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
  async play({ canvasElement, args, id, parameters }) {
    const locale = args.locale ?? 'en',
      copy = copyOf(locale);
    const canvas = within(canvasElement),
      page = within(document.body);
    const capture = async (step: string) => {
      if (import.meta.env.VITE_G1061_VISUAL !== '1') return;
      const { page: browser } = await import('vitest/browser');
      await document.fonts.ready;
      await browser.screenshot({ path: `../../../../.temp/g-1061/${id}-${step}.png` });
    };
    if (import.meta.env.VITE_G1061_VISUAL === '1') {
      const { page: browser } = await import('vitest/browser');
      await browser.viewport(id.includes('desktop') ? 1280 : 390, 844);
    }
    const trigger = canvas.getByRole('region', { name: copy.region }).querySelector('button')!;
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    const input = await page.findByRole('combobox', {
      name: browseMessages[locale].searchChapters,
    });
    await waitFor(() => expect(pending.has('')).toBe(true));
    await focusForTyping(input);
    await userEvent.click(input);
    await waitFor(() => expect(input).toHaveFocus());
    await fireEvent.compositionStart(input);
    await fireEvent.input(input, { target: { value: query }, isComposing: true });
    await fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(navigation).not.toHaveBeenCalled();
    await expect(requests).toHaveLength(1);
    await fireEvent.compositionEnd(input, { data: query });
    await waitFor(() => expect(pending.has(query)).toBe(true));
    await expect(page.queryByRole('option', { name: chapter })).toBeNull();
    pending.get(query)!();
    const result = await page.findByRole('option', { name: chapter });
    await capture('found');
    if (parameters.selection === 'keyboard') await userEvent.keyboard('{ArrowDown}{Enter}');
    else await userEvent.click(result);
    const destination = `/${locale}${here}?position=${occurrence}`;
    await waitFor(() =>
      expect(canvas.getByLabelText('Selected address')).toHaveTextContent(destination),
    );
    await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
    pending.get('')!();
    // Await the obsolete request's JSON parsing and external-store notification.
    await waitFor(() => expect(consumed.has('')).toBe(true));
    await waitFor(() => expect(navigation).toHaveBeenCalledTimes(1));
    await expect(navigation).toHaveBeenLastCalledWith(destination);
    await expect(canvas.getByLabelText('Selected address')).toHaveTextContent(destination);
    await expect(trigger).toHaveTextContent(chapter);
    await expect(requests.map((url) => url.searchParams.get('q'))).toEqual(['', query]);
    await expect(
      requests.every(
        (url) => url.searchParams.get('actingSubject') === (args.anonymous ? null : actor),
      ),
    ).toBe(true);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await capture('selected');
    // A later explicit choice is allowed to replace the chapter.
    await userEvent.click(trigger);
    const sheet = await page.findByRole('dialog', { name: copy.sheetTitle });
    await userEvent.click(
      within(sheet).getByRole('link', { name: new RegExp(copy.everythingOption) }),
    );
    await waitFor(() =>
      expect(canvas.getByLabelText('Selected address')).toHaveTextContent(
        `/${locale}${here}?position=all`,
      ),
    );
    await expect(navigation).toHaveBeenCalledTimes(2);
  },
};

export const CjkDesktop: Story = {
  ...CjkPhone,
  parameters: { selection: 'keyboard' },
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop' } },
};
export const EnglishPhone: Story = {
  ...CjkPhone,
  args: { locale: 'en' },
  globals: { locale: 'en', viewport: { value: 'phone' } },
};
export const PublicDesktop: Story = {
  ...CjkDesktop,
  args: { locale: 'en', anonymous: true },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
};

export const NativeNavigation: Story = {
  render: () => (
    <PositionControl
      copy={copyOf('en')}
      at={{ kind: 'all' }}
      options={[]}
      more={false}
      progress={{ href: '#g1061-progress', current: false, resolved: null }}
      everything={{ href: '#g1061-all', current: true }}
      load={async () => ({
        items: [
          {
            value: occurrence,
            label: chapter,
            text: zoneContentText(chapter, 'en'),
            current: false,
            href: `/en${window.location.search}#g1061-chapter`,
          },
        ],
        nextCursor: null,
        complete: true,
      })}
    />
  ),
  async play({ canvasElement }) {
    const previous = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const canvas = within(canvasElement),
      page = within(document.body);
    try {
      // Give the preview a localized address so the real navigation can change
      // its fragment without unloading Vitest's iframe.
      window.history.pushState(null, '', `/en${window.location.search}`);
      const trigger = canvas
        .getByRole('region', { name: copyOf('en').region })
        .querySelector('button')!;
      await waitFor(() => expect(trigger).toBeEnabled());
      await userEvent.click(trigger);
      const input = await page.findByRole('combobox');
      await waitFor(() => expect(input).toBeEnabled());
      await focusForTyping(input);
      await userEvent.click(input);
      await waitFor(() => expect(page.getByRole('option', { name: chapter })).toBeVisible());
      await userEvent.keyboard('{ArrowDown}{Enter}');
      // This preview does not override navigation: the default implementation
      // must call the browser, rather than the story's inert router shim.
      await waitFor(() => expect(window.location.hash).toBe('#g1061-chapter'));
      await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
      await expect(navigation).not.toHaveBeenCalled();
    } finally {
      window.history.pushState(null, '', previous);
    }
  },
};
