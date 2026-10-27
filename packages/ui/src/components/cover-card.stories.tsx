import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import { DropdownMenuItem } from '../shadcn/dropdown-menu.tsx';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { sharedRatio } from './cover.tsx';
import { CoverCard, CoverGrid, CoverRow } from './cover-card.tsx';
import { ProgressRow } from './progress-row.tsx';

const subjects = [
  { id: 'book', title: 'A very long book title that continues over more than two lines', types: ['schema:Book'] },
  { id: 'album', title: '夜空中最亮的星與漫長旅途的故事', types: ['schema:MusicAlbum'] },
  { id: 'other', title: 'A short title', types: ['schema:Book'] },
  { id: 'four', title: '四季', types: ['schema:MusicAlbum'] },
];
const ratio = sharedRatio(subjects);
const cards = () =>
  subjects.map((subject, index) => (
    <CoverCard
      key={subject.id}
      href={`/${subject.id}`}
      title={subject.title}
      titleLang={index % 2 ? 'zh' : 'en'}
      cover={{ subject, cover: null, src: () => '' }}
      secondary={index < 2 ? 'A creator' : undefined}
      state={index === 0 ? <ProgressRow value={0.42} label="42%" /> : index === 1 ? 'Reading' : undefined}
      menu={index === 0 ? <DropdownMenuItem>Remove</DropdownMenuItem> : undefined}
    />
  ));
const meta = {
  title: 'Rezics UI/Cover Card',
  component: CoverCard,
  decorators: [withSurface],
  args: { href: '/book', title: subjects[0]!.title, cover: { subject: subjects[0]!, cover: null, src: () => '' } },
} satisfies Meta<typeof CoverCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Grid: Story = {
  render: () => <CoverGrid ratio={ratio}>{cards()}</CoverGrid>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const container = canvasElement.querySelector<HTMLElement>('.\\@container')!;
    container.style.width = '390px';
    const articles = [...canvasElement.querySelectorAll('article')];
    await expect(articles[0]!.getBoundingClientRect().top).toBe(articles[1]!.getBoundingClientRect().top);
    await expect(articles[2]!.getBoundingClientRect().top).toBeGreaterThan(articles[0]!.getBoundingClientRect().top);
    container.style.width = '1280px';
    await expect(articles[2]!.getBoundingClientRect().top).toBe(articles[0]!.getBoundingClientRect().top);
    container.style.width = '';
    const frames = articles.map((article) => article.querySelector('[data-slot=cover]')!.getBoundingClientRect());
    await expect(frames.every((frame) => Math.abs(frame.height - frames[0]!.height) < 1)).toBe(true);
    const button = canvas.getByRole('button', { name: /More actions for/ });
    await userEvent.click(button);
    await expect(
      within(await settled(await screen.findByRole('menu'))).getByRole('menuitem', { name: 'Remove' }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await dismissed('menu');
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect(
      within(await settled(await screen.findByRole('menu'))).getByRole('menuitem', { name: 'Remove' }),
    ).toBeVisible();
  },
};
export const Row: Story = {
  parameters: { padded: false },
  render: () => (
    <CoverRow ratio={ratio} label="Continue">
      {cards()}
    </CoverRow>
  ),
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Continue' });
    await expect(region).toHaveAttribute('tabindex', '0');
    region.style.width = '390px';
    const cards = region.querySelectorAll('article');
    const third = cards[2]!.getBoundingClientRect();
    await expect(region.getBoundingClientRect().right - third.left).toBeGreaterThan(third.width / 2);
    region.style.width = '';
  },
};
