import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { SearchField } from './search-field.tsx';
import { ShellProvider } from './shell-provider.tsx';

function SearchEntry({ locale }: { locale: UiLocale }) {
  const [destination, setDestination] = useState('');
  return <ShellProvider locale={locale} messages={locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages}
    initialTheme="light" initialCollapsed={false}>
    <div className="grid max-w-xl gap-4 p-4" onSubmitCapture={event => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const url = new URL(form.action);
      url.search = new URLSearchParams(Array.from(new FormData(form), ([name, value]) => [name, String(value)])).toString();
      setDestination(url.pathname + url.search);
    }}>
      <SearchField />
      <output aria-label="Destination">{destination}</output>
    </div>
  </ShellProvider>;
}
const meta = {
  title: 'Shell/Discover search', component: SearchEntry,
  args: { locale: 'en' }, parameters: { route: { pathname: '/en' } },
} satisfies Meta<typeof SearchEntry>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Latin: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('searchbox', { name: 'Search everything' });
    await expect(input).toHaveAttribute('placeholder', 'Search everything…');
    await userEvent.keyboard('/');
    await expect(input).toHaveFocus();
    await userEvent.type(input, 'rain & night');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await expect(canvas.getByLabelText('Destination')).toHaveTextContent('/en/discover?q=rain+%26+night');
  },
};
export const Cjk: Story = {
  args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/discover', search: '?q=雨&tab=works&include=book' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('searchbox', { name: '搜索所有内容' });
    await expect(input).toHaveValue('雨');
    await expect(input).toHaveAttribute('placeholder', '搜索所有内容…');
    await userEvent.click(canvas.getByRole('button', { name: '搜索' }));
    // The header starts a new All search even when Discover currently has a type Condition.
    await expect(canvas.getByLabelText('Destination')).toHaveTextContent('/zh-Hans/discover?q=%E9%9B%A8');
    await userEvent.clear(input);
    await userEvent.click(canvas.getByRole('button', { name: '搜索' }));
    await expect(canvas.getByLabelText('Destination')).toHaveTextContent('/zh-Hans/discover?q=');
  },
};
export const CjkPhone: Story = { ...Cjk, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };
