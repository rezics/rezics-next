import type { ZonePreset } from '@rezics/zone-sdk';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import { contrast, parseHex } from './color.ts';
import { fictionModules, fictionZone } from './fixtures.ts';
import { presetTokens } from './presentation.ts';

/** One Zone page under a preset, with the package off: what every community Zone can look like from tokens alone. */
function Preset({ preset, locale }: { preset: ZonePreset; locale: UiLocale }) {
  const zone = { ...fictionZone(locale, presetTokens[preset]), slug: null };
  return <RealmPageStory zone={zone} modules={fictionModules(locale).slice(0, 8)} locale={locale}
    members={locale === 'zh-Hans' ? '12,408 位成员' : '12,408 members'} />;
}

const meta = {
  title: 'Zones/Themes',
  component: Preset,
  args: { preset: 'clean', locale: 'en' },
  parameters: { route: { pathname: '/en/r/classics' } },
  render: (args, { globals }) => <Preset {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof Preset>;
export default meta;
type Story = StoryObj<typeof meta>;

const rgb = (value: string) => {
  const [r = 0, g = 0, b = 0] = value.match(/[\d.]+/g)!.map(Number);
  return parseHex(`#${[r, g, b].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`);
};

/**
 * The accent the browser actually computed for text (the "More" links and the
 * active tab) reads at 4.5:1 or better on the Zone's page and panels.
 */
async function accentReads({ canvasElement }: { canvasElement: HTMLElement }) {
  const scope = canvasElement.querySelector<HTMLElement>('.zone-scope')!;
  const probe = document.createElement('span');
  probe.style.color = 'var(--primary)';
  probe.style.backgroundColor = 'var(--zone-page)';
  scope.append(probe);
  const panel = document.createElement('span');
  panel.style.backgroundColor = 'var(--card)';
  scope.append(panel);
  const text = rgb(getComputedStyle(probe).color);
  await expect(contrast(text, rgb(getComputedStyle(probe).backgroundColor))).toBeGreaterThanOrEqual(4.5);
  await expect(contrast(text, rgb(getComputedStyle(panel).backgroundColor))).toBeGreaterThanOrEqual(4.5);
  probe.remove();
  panel.remove();
}

export const Clean: Story = { play: accentReads };
export const CleanDark: Story = { globals: { theme: 'dark' }, play: accentReads };
export const Editorial: Story = { args: { preset: 'editorial' }, play: accentReads };
export const EditorialDark: Story = { args: { preset: 'editorial' }, globals: { theme: 'dark' }, play: accentReads };
export const Vibrant: Story = { args: { preset: 'vibrant' }, play: accentReads };
export const VibrantDark: Story = { args: { preset: 'vibrant' }, globals: { theme: 'dark' }, play: accentReads };
export const Serial: Story = { args: { preset: 'serial' }, play: accentReads };
export const SerialDark: Story = { args: { preset: 'serial' }, globals: { theme: 'dark' }, play: accentReads };
export const SerialChinese: Story = { args: { preset: 'serial' }, globals: { locale: 'zh-Hans' }, play: accentReads };
