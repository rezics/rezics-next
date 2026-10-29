import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent } from 'storybook/test';
import { useEffect, useState } from 'react';
import { BottomSheet } from './bottom-sheet.tsx';
import { Button } from '../shadcn/button.tsx';

type Kind = 'short' | 'tall' | 'back';
function Example({ kind, locale = 'en' }: { kind: Kind; locale?: 'en' | 'ja' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = previous;
    };
  }, [locale]);
  return (
    <div lang={locale} className="p-4">
      <Button onClick={() => setOpen(true)}>{locale === 'ja' ? 'シートを開く' : 'Open sheet'}</Button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title={locale === 'ja' ? 'フィルター' : 'Filters'}
        before={
          kind === 'back' ? (
            <Button variant="ghost" className="min-h-11">
              {locale === 'ja' ? '戻る' : 'Back'}
            </Button>
          ) : undefined
        }
      >
        {kind === 'tall' ? (
          <div className="space-y-4">
            {Array.from({ length: 24 }, (_, index) => (
              <p key={index}>
                {locale === 'ja' ? '長いシートの内容' : 'Scrollable sheet content'} {index + 1}
              </p>
            ))}
          </div>
        ) : (
          <p>{locale === 'ja' ? '短いシートの内容' : 'Short sheet content'}</p>
        )}
      </BottomSheet>
    </div>
  );
}

const meta = { title: 'Rezics UI/Bottom sheet', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { viewport: { defaultViewport: 'phone' } };

function story(kind: Kind, locale: 'en' | 'ja', theme: 'light' | 'dark'): Story {
  return {
    args: { kind, locale },
    parameters: phone,
    globals: { theme },
    play: async () => {
      await userEvent.click(
        await screen.findByRole('button', { name: locale === 'ja' ? 'シートを開く' : 'Open sheet' }),
      );
      await expect(
        await screen.findByRole('dialog', { name: locale === 'ja' ? 'フィルター' : 'Filters' }),
      ).toBeVisible();
      await expect(screen.getByRole('button', { name: locale === 'ja' ? '完了' : 'Done' })).toBeVisible();
    },
  };
}

export const ShortEnglish = story('short', 'en', 'light');
export const ShortEnglishDark = story('short', 'en', 'dark');
export const ShortJapanese = story('short', 'ja', 'light');
export const ShortJapaneseDark = story('short', 'ja', 'dark');
export const TallEnglish = story('tall', 'en', 'light');
export const TallEnglishDark = story('tall', 'en', 'dark');
export const TallJapanese = story('tall', 'ja', 'light');
export const TallJapaneseDark = story('tall', 'ja', 'dark');
export const BackEnglish = story('back', 'en', 'light');
export const BackEnglishDark = story('back', 'en', 'dark');
export const BackJapanese = story('back', 'ja', 'light');
export const BackJapaneseDark = story('back', 'ja', 'dark');
