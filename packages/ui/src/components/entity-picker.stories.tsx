import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';
import { Button } from './button.tsx';
import { EntityPicker, type EntityPickerSelection } from './entity-picker.tsx';
import type { EntityPickerItem, EntityPickerLoad } from './entity-picker-state.ts';

const inventory = Array.from({ length: 10_000 }, (_, index) => ({
  value: String(index),
  label: index === 0 ? '银河英雄传说' : `Work ${index + 1}`,
  description: `Catalogue item ${index + 1}`,
}));

function Demo({ multiple = true, delay = 0, failing = false, locale = 'en' as 'en' | 'zh-Hans' }) {
  const [value, setValue] = useState<EntityPickerSelection[]>([]);
  const load = useMemo<EntityPickerLoad<EntityPickerItem>>(() => {
    const attempts = new Set<string>();
    return async ({ q, cursor }) => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const key = `${q}:${cursor}`;
      if (failing && !attempts.has(key)) {
        attempts.add(key);
        throw new Error('Unavailable');
      }
      const matching = inventory.filter((item) =>
        item.label.toLocaleLowerCase().includes(q.toLocaleLowerCase()),
      );
      const offset = Number(cursor ?? 0);
      const items = matching.slice(offset, offset + 40);
      const complete = offset + items.length >= matching.length;
      return { items, nextCursor: complete ? null : String(offset + items.length), complete };
    };
  }, [delay, failing]);
  return (
    <div className="min-h-[32rem] p-4">
      <div className="max-w-sm">
        <EntityPicker
          label={locale === 'en' ? 'Works' : '作品'}
          load={load}
          value={value}
          onValueChange={setValue}
          multiple={multiple}
          allowExclude={multiple}
          locale={locale}
          suggestions={
            <p className="px-3 py-2 text-muted-foreground text-xs">
              {locale === 'en' ? 'Search the catalogue' : '搜索作品目录'}
            </p>
          }
        />
      </div>
    </div>
  );
}
const meta = {
  title: 'Rezics UI/Entity picker',
  component: Demo,
  tags: ['autodocs'],
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

const inlineRequests = fn();
function InlineLoaderFixture() {
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<EntityPickerSelection[]>([]);
  return (
    <div className="grid max-w-sm gap-3 p-4">
      <Button type="button" onClick={() => setRevision((previous) => previous + 1)}>
        Re-render loader
      </Button>
      <output aria-label="Loader revision">{revision}</output>
      <EntityPicker
        label="Works"
        value={value}
        onValueChange={setValue}
        load={async ({ q, cursor }) => {
          inlineRequests({ q, cursor }, revision);
          const index = Number(cursor ?? 0);
          return {
            items: [{ value: `${q}:${index}`, label: `${q} page ${index}, loader ${revision}` }],
            nextCursor: index === 2 ? null : String(index + 1),
            complete: index === 2,
          };
        }}
      />
    </div>
  );
}

export const InlineLoaderRerender: Story = {
  render: () => <InlineLoaderFixture />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole('combobox');
    await userEvent.click(input);
    await page.findByText('At least 1');
    await userEvent.type(input, '星');
    await page.findByRole('option', { name: '星 page 0, loader 0' });
    await userEvent.click(page.getByRole('button', { name: 'Show more' }));
    await page.findByText('At least 2');
    const requestsBeforeRerender = inlineRequests.mock.calls.length;
    // Re-render without moving focus or closing the popup, so this isolates loader identity.
    await fireEvent.click(canvas.getByRole('button', { name: 'Re-render loader' }));
    await expect(canvas.getByLabelText('Loader revision')).toHaveTextContent('1');
    await expect(inlineRequests).toHaveBeenCalledTimes(requestsBeforeRerender);
    await waitFor(() => expect(page.getByText('At least 2')).toBeVisible());
    await expect(input).toHaveValue('星');
    await expect(page.getByRole('option', { name: '星 page 1, loader 0' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(page.getByText('3 results')).toBeVisible());
    await expect(inlineRequests).toHaveBeenLastCalledWith({ q: '星', cursor: '2' }, 1);
    await expect(page.getByRole('option', { name: '星 page 0, loader 0' })).toBeVisible();
    await expect(page.getByRole('option', { name: '星 page 2, loader 1' })).toBeVisible();
  },
};

export const TenThousand: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('combobox'));
    await waitFor(() => expect(page.getByText('At least 40')).toBeVisible());
    const popup = canvasElement.ownerDocument.querySelector<HTMLElement>(
      '[data-slot="combobox-list"]',
    )!;
    popup.scrollTop = popup.scrollHeight;
    await fireEvent.scroll(popup);
    await waitFor(() => expect(page.getByText('At least 80')).toBeVisible());
    await userEvent.click(page.getByRole('option', { name: /Work 75 / }));
    await expect(canvas.getByRole('button', { name: 'Remove Work 75' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Exclude Work 75' }));
    await expect(canvas.getByRole('button', { name: 'Include Work 75' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.type(canvas.getByRole('combobox'), '银河');
    await waitFor(() => expect(page.getAllByRole('option')).toHaveLength(1));
    await userEvent.keyboard('{ArrowDown}{Enter}{Escape}');
    await expect(canvas.getByRole('button', { name: 'Remove 银河英雄传说' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Remove Work 75' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Work 75' }));
    await expect(canvas.queryByRole('button', { name: 'Remove Work 75' })).not.toBeInTheDocument();
  },
};
export const Single: Story = {
  args: { multiple: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(await page.findByRole('option', { name: /Work 2 / }));
    await expect(canvas.getByRole('button', { name: 'Remove Work 2' })).toBeVisible();
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(await page.findByRole('option', { name: /Work 3 / }));
    await expect(canvas.queryByRole('button', { name: 'Remove Work 2' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Remove Work 3' })).toBeVisible();
    const input = canvas.getByRole('combobox');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(input).not.toHaveAttribute('aria-activedescendant'));
  },
};
export const Slow: Story = {
  args: { delay: 700 },
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await waitFor(() => expect(page.getByText('Loading…')).toBeVisible());
    await waitFor(() => expect(page.getByText('At least 40')).toBeVisible());
  },
};
export const Failing: Story = {
  args: { failing: true },
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await expect(await page.findByRole('alert')).toHaveTextContent('Couldn’t load choices.');
    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(page.getByText('At least 40')).toBeVisible());
  },
};
export const CjkComposition: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const input = canvas.getByRole('combobox');
    await userEvent.click(input);
    await page.findByText('至少 40 项');
    await fireEvent.compositionStart(input);
    await fireEvent.input(input, { target: { value: '银河' }, isComposing: true });
    await fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(canvas.queryByRole('button', { name: /移除/ })).not.toBeInTheDocument();
    await fireEvent.compositionEnd(input, { data: '银河' });
    await waitFor(() => expect(page.getAllByRole('option')).toHaveLength(1));
    await waitFor(() => expect(page.getByText('1 项结果')).toBeVisible());
    await userEvent.keyboard('{ArrowDown}{Enter}{Escape}');
    await expect(canvas.getByRole('button', { name: '移除银河英雄传说' })).toBeVisible();
  },
};
export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await within(canvasElement.ownerDocument.body).findByText('At least 40');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

function UpdatingFixture() {
  const [value, setValue] = useState<EntityPickerSelection[]>([]);
  const load = useMemo<EntityPickerLoad<EntityPickerItem>>(() => {
    let attempts = 0;
    return async () => ++attempts === 1
      ? { items: [], nextCursor: null, complete: false, updating: true }
      : { items: [inventory[0]!], nextCursor: null, complete: true };
  }, []);
  return <div className="max-w-sm p-4"><EntityPicker label="Chapters" load={load}
    value={value} onValueChange={setValue} multiple={false} /></div>;
}
export const SearchUpdating: Story = {
  render: () => <UpdatingFixture />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement), page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('combobox'));
    await expect(await page.findByText('Search is still updating.')).toBeVisible();
    await expect(page.getByText('At least 0')).toBeVisible();
    await expect(page.queryByText('No matches.')).not.toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    await expect(await page.findByText('1 results')).toBeVisible();
    await expect(page.getByRole('option', { name: /银河英雄传说/ })).toBeVisible();
  },
};
