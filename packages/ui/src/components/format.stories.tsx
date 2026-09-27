import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { FormatByte, FormatNumber, FormatRelativeTime } from './format.tsx';
import { LocaleProvider } from './locale.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div className={cn(parameters.dark && 'dark', 'bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

// Fixed so snapshots and assertions do not drift with the clock.
const now = Date.now();
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000);

const meta = {
  title: 'Rezics UI/Display/Format',
  component: FormatNumber,
  tags: ['autodocs'],
  decorators: [surface],
  args: { value: 12480 },
  parameters: {
    docs: {
      description: {
        component:
          'Locale-aware text for numbers, byte sizes and relative times, using `Intl` with the locale from `LocaleProvider`: member counts and vote scores (`FormatNumber` with `notation="compact"`), cover upload sizes (`FormatByte`) and "3 hours ago" on posts (`FormatRelativeTime`). Wrap the app in `LocaleProvider` with the reader\'s interface language so zh-CN readers see 1.2万 rather than 12K. Never format these by hand.',
      },
    },
  },
} satisfies Meta<typeof FormatNumber>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Number: Story = {
  render: (args) => (
    <p className="text-sm">
      <FormatNumber {...args} /> members
    </p>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/12,480/)).toBeVisible();
  },
};

export const Numbers: Story = {
  render: () => (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Members</dt>
      <dd>
        <FormatNumber notation="compact" value={12480} />
      </dd>
      <dt className="text-muted-foreground">Average rating</dt>
      <dd>
        <FormatNumber maximumFractionDigits={2} minimumFractionDigits={2} value={4.2567} />
      </dd>
      <dt className="text-muted-foreground">Five-star share</dt>
      <dd>
        <FormatNumber style="percent" value={0.521} />
      </dd>
      <dt className="text-muted-foreground">Vote score</dt>
      <dd>
        <FormatNumber signDisplay="exceptZero" value={-3} />
      </dd>
    </dl>
  ),
};

export const Bytes: Story = {
  render: () => (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        Cover image: <FormatByte value={482_133} />
      </li>
      <li>
        EPUB: <FormatByte value={3_914_220} />
      </li>
      <li>
        Upload limit: <FormatByte unitDisplay="long" value={10_000_000} />
      </li>
    </ul>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/482/)).toBeVisible();
  },
};

export const RelativeTime: Story = {
  render: () => (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        Posted <FormatRelativeTime value={hoursAgo(0.05)} />
      </li>
      <li>
        Edited <FormatRelativeTime value={hoursAgo(3)} />
      </li>
      <li>
        Joined <FormatRelativeTime value={hoursAgo(24 * 400)} />
      </li>
    </ul>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/3 hours ago/)).toBeVisible();
  },
};

export const Chinese: Story = {
  name: 'zh-CN locale',
  render: () => (
    <LocaleProvider locale="zh-CN">
      <ul className="flex flex-col gap-1 text-sm" lang="zh-CN">
        <li>
          《三体》讨论区成员：
          <FormatNumber notation="compact" value={12480} />
        </li>
        <li>
          平均评分：
          <FormatNumber maximumFractionDigits={1} value={8.84} />
        </li>
        <li>
          封面大小：
          <FormatByte value={482_133} />
        </li>
        <li>
          最后编辑：
          <FormatRelativeTime value={hoursAgo(3)} />
        </li>
      </ul>
    </LocaleProvider>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/1\.2万/)).toBeVisible();
    await expect(canvas.getByText(/3小时前/)).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { dark: true },
  render: Numbers.render,
};
