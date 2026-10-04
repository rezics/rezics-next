import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ZoneText } from '@rezics/zone-sdk';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { translate } from '../scoped-rating/format.ts';
import { messages } from '../scoped-rating/messages.ts';
import { ContinuitySwitch, type ContinuityOption } from './continuity-switch.tsx';
import { type ContinuityChoice, offContinuity } from './continuity.ts';
import { PositionControl } from './position-control.tsx';

// The continuity switch: off until someone asks, a host's default, and the same bar as the reading position.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const text = (value: string, lang = 'en'): ZoneText => ({ value, lang, dir: 'ltr' });
const canon = '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0d';
const legends = '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0e';
const options: ContinuityOption[] = [
  { id: canon, label: text('Canon'), kind: 'narrative' },
  { id: legends, label: text('Legends'), kind: 'narrative' },
  { id: '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0f', label: text('Pride and Prejudice (1995 serial)'), kind: 'work' },
];

function Switch({ locale, current, fallback, here, options: choices, withPosition }: {
  locale: UiLocale; current: ContinuityChoice; fallback: ContinuityChoice; here: string; options: ContinuityOption[];
  withPosition: boolean;
}) {
  const t = translate(messages[locale], locale);
  const sw = <ContinuitySwitch here={here} current={current} fallback={fallback} options={choices} locale={locale}
    messages={messages[locale]} />;
  if (!withPosition) return <div className="border-border/70 border-b bg-card/50 px-4 py-2 sm:px-6">{sw}</div>;
  return <PositionControl locale={locale}
    copy={{ region: 'Reading position', upTo: 'Up to:', upToEverything: 'Showing everything', showEverything: 'Show everything',
      sheetTitle: 'Read up to', sheetBody: 'Pages show only what the story has revealed.', progressOption: 'Your own progress',
      progressNote: 'Currently', progressNoneNote: 'You have not finished a chapter yet.', everythingOption: 'Show everything',
      everythingNote: 'Includes later records.', moreChapters: 'More chapters exist.', close: t.close }}
    at={{ kind: 'all' }} options={[]} progress={{ href: here, current: false, resolved: null }}
    everything={{ href: here, current: true }} more={false}>{sw}</PositionControl>;
}

const meta = {
  title: 'Wiki/Continuity switch',
  component: Switch,
  args: { locale: 'en', current: offContinuity, fallback: offContinuity, here: '/en/z/wiki/characters?position=all', options, withPosition: false },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: '/en/z/wiki/characters' } },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Off by default: the label says every continuity shows, and no clear link is drawn. */
export const Off: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: /Continuity: All continuities/ })).toBeEnabled());
    await expect(canvasElement.querySelector('[data-continuity-clear]')).toBeNull();
    await fits();
  },
};
export const OffPhone: Story = { ...Off, globals: phone };

/** Choosing a continuity navigates to this address with it written in, keeping the reading position. */
export const Choose: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: /Continuity: All continuities/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Read in a continuity' });
    await waitFor(() => expect(within(dialog).getByRole('link', { name: /All continuities/ })).toHaveAttribute('aria-current', 'true'));
    await waitFor(() => expect(within(dialog).getByText('Story continuities')).toBeVisible());
    await expect(within(dialog).getByText('Works')).toBeVisible();
    await expect(within(dialog).getByRole('link', { name: 'Legends' })).toHaveAttribute('href', `/en/z/wiki/characters?position=all&continuity=${legends}`);
    await expect(within(dialog).getByRole('link', { name: 'Pride and Prejudice (1995 serial)' })).toBeVisible();
  },
};
export const ChoosePhone: Story = { ...Choose, globals: phone };

/** Once chosen it is named in the bar, with a way back that keeps everything else in the address. */
export const On: Story = {
  args: { current: { kind: 'at', continuity: canon }, here: `/en/z/wiki/characters?position=all&continuity=${canon}` },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /Continuity: Canon/ })).toBeVisible();
    await expect(canvas.getByText('Showing Canon')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Show all continuities' })).toHaveAttribute('href', '/en/z/wiki/characters?position=all');
    await fits();
  },
};
export const OnPhone: Story = { ...On, globals: phone };
export const OnDarkPhone: Story = { ...On, globals: { ...phone, theme: 'dark' } };

/** A host that defaults its readers into Canon: the address carries nothing for Canon, and `off` turns it off. */
export const HostDefault: Story = {
  args: { current: { kind: 'at', continuity: canon }, fallback: { kind: 'at', continuity: canon } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Show all continuities' })).toHaveAttribute('href', '/en/z/wiki/characters?position=all&continuity=off');
    const trigger = canvas.getByRole('button', { name: /Continuity: Canon/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('link', { name: 'Canon' })).toHaveAttribute('href', '/en/z/wiki/characters?position=all'));
  },
};

/** Nothing to choose from: a franchise with no continuities lists only the way to show everything. */
export const NoContinuities: Story = {
  args: { options: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: /Continuity/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getAllByRole('link')).toHaveLength(1));
  },
};

/** The same bar as the reading position: both controls fit, on a phone too. */
export const BesideReadingPosition: Story = {
  args: { withPosition: true, current: { kind: 'at', continuity: canon }, here: `/en/z/wiki/characters?position=all&continuity=${canon}` },
  async play({ canvasElement }) {
    const bar = within(within(canvasElement).getByRole('region', { name: 'Reading position' }));
    await expect(bar.getByRole('button', { name: 'Showing everything' })).toBeVisible();
    await expect(bar.getByRole('button', { name: /Continuity: Canon/ })).toBeVisible();
    await fits();
  },
};
export const BesideReadingPositionPhone: Story = { ...BesideReadingPosition, globals: phone };

const localized = (locale: UiLocale): Story => ({
  args: { locale, current: { kind: 'at', continuity: canon }, here: `/${locale}/z/wiki/characters?continuity=${canon}` },
  async play({ canvasElement }) {
    const t = translate(messages[locale], locale);
    await expect(within(canvasElement).getByRole('link', { name: t.continuityClear })).toBeVisible();
    await expect(within(canvasElement).getByText(t.continuityNow({ name: 'Canon' }))).toBeVisible();
    await fits();
  },
});
export const TraditionalChinese: Story = localized('zh-Hant');
export const SimplifiedChinese: Story = localized('zh-Hans');
export const Japanese: Story = localized('ja');
export const Korean: Story = localized('ko');
export const German: Story = localized('de');
export const French: Story = localized('fr');
export const Spanish: Story = localized('es');
