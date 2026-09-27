import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Prose } from './prose.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Display/Prose',
  component: Prose,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'Typography for long-form, member-written text rendered from Markdown: reviews, Realm rules, Work synopses and moderation notes. It styles headings, lists, quotes, tables, code and marks inside it and caps the line length at 65 characters. Add `not-prose` to any embedded component that must keep its own styles. Do not use it for interface text.',
      },
    },
  },
} satisfies Meta<typeof Prose>;
export default meta;
type Story = StoryObj<typeof meta>;

const Review = () => (
  <>
    <h1>A wall that did not look important</h1>
    <p>
      <em>The Dispossessed</em> opens with a wall around a spaceport, and the whole novel is about
      which side of it you are on. Le Guin alternates chapters between Shevek on{' '}
      <a href="#anarres">Anarres</a> and Shevek on Urras, and the two timelines meet on the last
      page.
    </p>
    <h2>What works</h2>
    <ul>
      <li>The physics is a character, not a lecture.</li>
      <li>
        Anarres is a utopia with <mark>real costs</mark>: drought, conformity, the "social
        conscience" that becomes a weapon.
      </li>
      <li>The ending refuses to tell you who won.</li>
    </ul>
    <blockquote>
      <p>
        You cannot buy the revolution. You cannot make the revolution. You can only be the
        revolution.
      </p>
    </blockquote>
    <h3>Rating breakdown</h3>
    <table>
      <thead>
        <tr>
          <th>Aspect</th>
          <th align="right">Score</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Ideas</td>
          <td align="right">5</td>
        </tr>
        <tr>
          <td>Characters</td>
          <td align="right">4</td>
        </tr>
      </tbody>
    </table>
    <p>
      Edition read: Harper Voyager, ISBN <code>978-0-06-051275-4</code>. Press <kbd>Esc</kbd> to
      close the reader.
    </p>
  </>
);

export const Default: Story = {
  render: (args) => (
    <Prose {...args}>
      <Review />
    </Prose>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Anarres' })).toHaveAttribute('href', '#anarres');
  },
};

export const RealmRules: Story = {
  render: () => (
    <Prose>
      <h2>Hard Science Fiction: rules</h2>
      <ol>
        <li>Mark spoilers for anything past the first chapter.</li>
        <li>
          Review the Work, not the reviewer. Reports go to the <a href="#mods">moderators</a>.
        </li>
        <li>Self-promotion only in the weekly thread.</li>
      </ol>
      <details>
        <summary>What counts as hard science fiction?</summary>
        <p>Stories where the science is load-bearing: change the physics and the plot breaks.</p>
      </details>
    </Prose>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN and mixed',
  render: () => (
    <Prose lang="zh-CN">
      <h2>《三体》书评：黑暗森林之前</h2>
      <p>
        {/* One string: JSX line breaks would insert spaces between CJK characters. */}
        {
          '刘慈欣在《三体》中把「红岸工程」写成了一个关于信任的故事。叶文洁按下发射键的那一刻，人类第一次向宇宙暴露了自己。Ken Liu 的英译本 The Three-Body Problem 保留了这种冷峻，并在 2015 年获得 '
        }
        <mark>Hugo Award</mark>。
      </p>
      <blockquote>
        <p>不要回答！不要回答！不要回答！</p>
      </blockquote>
      <ul>
        <li>科学设定：三体问题、智子、古筝行动</li>
        <li>人物：汪淼、史强、叶文洁</li>
      </ul>
    </Prose>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <Prose>
      <Review />
    </Prose>
  ),
};
