import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import { browseMessages } from '../discover/browse-messages.ts';
import { zoneContentText } from '../language/untagged.ts';
import { copyOf } from '../wiki/messages.ts';
import { PositionControl } from '../wiki/position-control.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { focusForTyping } from '../../../../packages/ui/src/test/focus.ts';

const chapter = 'Chapter 51: 遠方 — The last lantern';
const occurrence = '00000000-0000-4000-8000-000000000051';
const requests = fn();

/** Exercise the remote chooser inside its sheet, preserving the search input
 * through selection and navigation. */
function Chooser({ locale = 'en' }: { locale?: UiLocale }) {
  const [destination, setDestination] = useState('all');
  const copy = copyOf(locale);
  return (
    <StoryRouteContext value={{ pathname: `/${locale}/wiki`, onPush: setDestination }}>
      <PositionControl
        copy={copy}
        navigate={setDestination}
        locale={locale}
        at={
          destination === 'all'
            ? { kind: 'all' }
            : {
                kind: 'position',
                label: zoneContentText(chapter, 'en'),
                note: copy.chosen,
              }
        }
        options={[]}
        progress={{ href: '/wiki', current: false, resolved: null }}
        everything={{ href: '/wiki?position=all', current: destination === 'all' }}
        more
        load={async ({ q, cursor }) => {
          requests({ q, cursor });
          return q
            ? {
                items: [
                  {
                    value: occurrence,
                    label: chapter,
                    text: zoneContentText(chapter, 'en'),
                    href: `/wiki?position=${occurrence}`,
                    current: false,
                  },
                ],
                nextCursor: null,
                complete: true,
              }
            : {
                items: [
                  {
                    value: 'first',
                    label: 'Chapter 1',
                    text: zoneContentText('Chapter 1', 'en'),
                    href: '/wiki?position=first',
                    current: false,
                  },
                ],
                nextCursor: 'later',
                complete: false,
              };
        }}
      />
      <output aria-label="Selected address" className="block break-all">
        {destination}
      </output>
    </StoryRouteContext>
  );
}

const meta = {
  title: 'Zones/Wiki searched position',
  component: Chooser,
  beforeEach: () => {
    requests.mockClear();
  },
} satisfies Meta<typeof Chooser>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LaterChapter: Story = {
  async play({ canvasElement, args, id, parameters }) {
    const locale = args.locale ?? 'en';
    const capture = async (step: string) => {
      if (import.meta.env.VITE_G1059_VISUAL !== '1') return;
      const { page } = await import('vitest/browser');
      await document.fonts.ready;
      await page.screenshot({ path: `../../../../.temp/g-1059/${id}-${step}.png` });
    };
    if (import.meta.env.VITE_G1059_VISUAL === '1') {
      const { page } = await import('vitest/browser');
      await page.viewport(id.endsWith('phone') ? 390 : 1280, 844);
    }
    const canvas = within(canvasElement),
      page = within(document.body);
    await userEvent.click(
      canvas.getByRole('region', { name: copyOf(locale).region }).querySelector('button')!,
    );
    const input = await page.findByRole('combobox', {
      name: browseMessages[locale].searchChapters,
    });
    await waitFor(() => expect(input).toBeEnabled());
    await focusForTyping(input);
    await userEvent.type(input, chapter);
    const result = await page.findByRole('option', { name: chapter });
    await capture('found');
    if (parameters.selection === 'keyboard') await userEvent.keyboard('{ArrowDown}{Enter}');
    else await userEvent.click(result);
    await waitFor(() =>
      expect(canvas.getByLabelText('Selected address')).toHaveTextContent(
        `/${locale}/wiki?position=${occurrence}`,
      ),
    );
    await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
    await expect(
      canvas.getByRole('region', { name: copyOf(locale).region }).querySelector('button'),
    ).toHaveTextContent(chapter);
    // A selection-triggered input clear must not launch another server action
    // at the old position after the reader has chosen the chapter.
    await expect(requests).toHaveBeenLastCalledWith({ q: chapter, cursor: null });
    await capture('selected');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const LaterChapterPhone: Story = {
  ...LaterChapter,
  globals: { viewport: { value: 'phone' } },
};

export const LaterChapterChinese: Story = {
  ...LaterChapter,
  args: { locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  parameters: { selection: 'keyboard' },
};

export const LaterChapterChinesePhone: Story = {
  ...LaterChapterChinese,
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
};
