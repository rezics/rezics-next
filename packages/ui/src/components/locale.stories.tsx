import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { LocaleProvider, useLocale } from './locale.tsx';

const meta = {
  title: 'UI/Locale',
  component: LocaleProvider,
  tags: ['autodocs'],
  args: { locale: 'en-US' },
  parameters: {
    docs: {
      description: {
        component:
          'Use LocaleProvider at a REZICS surface boundary when formatting dates, numbers or collection labels for a selected language such as zh-CN.',
      },
    },
  },
  decorators: [
    (Story) => (
      <main
        className={'aura-canvas flex min-h-screen items-center justify-center bg-background p-6'}
      >
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof LocaleProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

const LocaleSummary = ({ dark = false }: { dark?: boolean }) => {
  const { locale } = useLocale();
  return (
    <div
      className={
        dark
          ? 'rounded-2xl bg-background p-6 text-foreground'
          : 'rounded-2xl border border-border/60 bg-card p-6'
      }
    >
      <p className="text-sm text-muted-foreground">Current catalogue locale</p>
      <p className="mt-1 font-mono font-semibold text-foreground">{locale}</p>
      <p className="mt-3 text-lg text-foreground" lang={locale}>
        《三体》 · Reading notes and editions
      </p>
    </div>
  );
};

export const English: Story = {
  render: () => (
    <LocaleProvider locale="en-US">
      <LocaleSummary />
    </LocaleProvider>
  ),
};

export const SimplifiedChinese: Story = {
  render: () => (
    <LocaleProvider locale="zh-CN">
      <LocaleSummary />
    </LocaleProvider>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('zh-CN')).toBeVisible();
    await expect(canvas.getByText('《三体》 · Reading notes and editions')).toHaveAttribute(
      'lang',
      'zh-CN',
    );
  },
};

export const DarkMode: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <LocaleProvider locale="zh-CN">
      <LocaleSummary dark />
    </LocaleProvider>
  ),
};
