import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { localeNames, uiLocales, type UiLocale } from '../../i18n/define.ts';
import { attributed, ccBySa, creditedOnly, instrumentOnly, unassessed } from './fixtures.ts';
import { messages } from './messages.ts';
import { RightsMark, RightsRunRows, type DisplayObligations } from './rights-mark.tsx';

function Pad({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-4 py-6">{children}</div>;
}

const row = (id: string, text: string, rights: DisplayObligations) => ({ id, rights, children: text });
const sameRun = [
  row('born', 'Born in 2008', attributed),
  row('also', 'Also known as the Black Swordsman', attributed),
  row('member', 'Member of the Knights', attributed),
];

const noOverflow = async () => {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

const meta = { title: 'Rights mark/Mark', component: RightsMark } satisfies Meta<typeof RightsMark>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AttributionAndShareAlike: Story = {
  args: { rights: attributed, locale: 'en' },
  render: args => <Pad><RightsMark {...args} /></Pad>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'https://example.test/records/1' }))
      .toHaveAttribute('href', 'https://example.test/records/1');
    await expect(canvas.getByRole('link', { name: 'CC BY-SA 3.0' })).toHaveAttribute('href', ccBySa);
    await expect(canvas.getByText(/Adaptations stay under the same terms/)).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
  },
};

export const AttributionAndShareAlikePhone: Story = {
  ...AttributionAndShareAlike,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await AttributionAndShareAlike.play!(context);
    await noOverflow();
  },
};

export const InstrumentOnly: Story = {
  args: { rights: instrumentOnly, locale: 'en' },
  render: args => <Pad><RightsMark {...args} /></Pad>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'CC BY-SA 3.0' })).toBeVisible();
    await expect(canvas.queryByText(/Adaptations stay/)).toBeNull();
    await expect(canvas.queryByText(/Recorded source/)).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
  },
};

export const InstrumentOnlyPhone: Story = {
  ...InstrumentOnly,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await InstrumentOnly.play!(context);
    await noOverflow();
  },
};

export const Unassessed: Story = {
  args: { rights: unassessed, locale: 'en' },
  render: args => <Pad>
    <p>A surveyor maps a delta that redraws itself with every tide.</p>
    <RightsMark {...args} />
  </Pad>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/surveyor maps a delta/)).toBeVisible();
    await expect(canvasElement.querySelector('[data-rights-mark]')).toBeNull();
    await expect(within(canvasElement).queryByRole('link')).toBeNull();
  },
};

export const IdenticalRightsRun: Story = {
  args: { rights: attributed },
  render: () => <Pad><RightsRunRows rows={sameRun} locale="en" /></Pad>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Born in 2008')).toBeVisible();
    await expect(canvas.getByText('Also known as the Black Swordsman')).toBeVisible();
    await expect(canvas.getByText('Member of the Knights')).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('[data-rights-run]')).toHaveLength(1);
  },
};

export const IdenticalRightsRunPhone: Story = {
  ...IdenticalRightsRun,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await IdenticalRightsRun.play!(context);
    await noOverflow();
  },
};

function LocaleList({ locale }: { locale?: UiLocale }) {
  const shown = locale ? [locale] : uiLocales;
  return <Pad>
    <div className="grid gap-5">
      {shown.map(item => <div key={item} className="grid min-w-0 gap-1">
        <p className="font-medium text-sm">{localeNames[item]}</p>
        <RightsMark rights={attributed} locale={item} />
      </div>)}
    </div>
  </Pad>;
}

export const Locales: Story = {
  args: { rights: attributed },
  render: () => <LocaleList />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const locale of uiLocales) await expect(canvas.getAllByText(messages[locale].shareAlike).length)
      .toBeGreaterThan(0);
  },
};

export const LocalesPhone: Story = {
  ...Locales,
  globals: { viewport: { value: 'phone' } },
  play: async context => {
    await Locales.play!(context);
    await noOverflow();
  },
};

/** Two runs, so a change of rights starts a new mark instead of repeating one on every row. */
export const SplitRightsRun: Story = {
  args: { rights: attributed },
  render: () => <Pad><RightsRunRows locale="en" rows={[
    ...sameRun,
    row('title', 'Original title', creditedOnly),
    row('year', 'First published in 2012', creditedOnly),
  ]} /></Pad>,
  async play({ canvasElement }) {
    await expect(canvasElement.querySelectorAll('[data-rights-run]')).toHaveLength(2);
    await expect(canvasElement.querySelectorAll('[data-rights-mark]')).toHaveLength(2);
    await expect(within(canvasElement).getByRole('link', { name: 'CC BY 4.0' })).toBeVisible();
  },
};
