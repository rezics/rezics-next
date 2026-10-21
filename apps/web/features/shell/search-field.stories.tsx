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
    <div className="grid max-w-xl gap-4 p-4" onSubmit={event => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const url = new URL(form.action);
      url.search = new URLSearchParams(Array.from(new FormData(form), ([name, value]) => [name, String(value)])).toString();
      setDestination(url.pathname + url.search);
    }}>
      <SearchField />
      <output aria-label="Destination" className="min-w-0 break-all">{destination}</output>
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
    const input = canvas.getByRole('searchbox', { name: '在这些条件内搜索' });
    await expect(input).toHaveValue('雨');
    await expect(input).toHaveAttribute('placeholder', '在这些条件内搜索');
    await userEvent.click(canvas.getByRole('button', { name: '搜索' }));
    await expect(canvas.getByLabelText('Destination')).toHaveTextContent('/zh-Hans/discover?tab=works&include=book&q=%E9%9B%A8');
    await userEvent.clear(input);
    await userEvent.click(canvas.getByRole('button', { name: '搜索' }));
    await expect(canvas.getByLabelText('Destination')).toHaveTextContent('/zh-Hans/discover?tab=works&include=book&q=');
  },
};
export const CjkPhone: Story = { ...Cjk, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const KeepsScopedConditions: Story = {
  parameters: { route: { pathname: '/en/discover', search: '?q=old&tab=works&lang=ja&include=https%3A%2F%2Fschema.org%2FBook&ci=00000000-0000-4000-8000-000000000001&cm=any&cursor=old-traversal' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement), input = canvas.getByRole('searchbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'new query');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    const destination = new URL(canvas.getByLabelText('Destination').textContent!, 'https://example.test');
    await expect(destination.searchParams.get('q')).toBe('new query');
    await expect(destination.searchParams.get('lang')).toBe('ja');
    await expect(destination.searchParams.get('tab')).toBe('works');
    await expect(destination.searchParams.get('include')).toBe('https://schema.org/Book');
    await expect(destination.searchParams.get('ci')).toBe('00000000-0000-4000-8000-000000000001');
    await expect(destination.searchParams.has('cursor')).toBe(false);
  },
};

export const UnicodeBoundaryKeepsConditions: Story = {
  ...KeepsScopedConditions,
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement), input = canvas.getByRole('searchbox');
    await userEvent.clear(input);
    await userEvent.type(input, '𠮷'.repeat(80));
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    const output = canvas.getByLabelText('Destination');
    const destination = new URL(output.textContent!, 'https://example.test');
    await expect(destination.searchParams.get('q')).toBe('𠮷'.repeat(80));
    for (const [key, value] of [['lang', 'ja'], ['tab', 'works'], ['include', 'https://schema.org/Book'],
      ['ci', '00000000-0000-4000-8000-000000000001'], ['cm', 'any']]) {
      await expect(destination.searchParams.get(key!)).toBe(value);
    }
    await expect(destination.searchParams.has('cursor')).toBe(false);
    await userEvent.type(input, '𠮷');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await expect(input).toBeInvalid();
    await expect(output.textContent).toBe(destination.pathname + destination.search);
    await userEvent.clear(input);
    await userEvent.type(input, '"雨"');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    const exact = new URL(output.textContent!, 'https://example.test');
    await expect(exact.searchParams.get('q')).toBe('"雨"');
    await expect(exact.searchParams.get('lang')).toBe('ja');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  },
};
