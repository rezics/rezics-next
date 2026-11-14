import type { DocumentSnapshot } from '@rezics/document';
import { fromPlainText } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { DocumentBody } from './document-body.tsx';
import { Prose } from './prose.tsx';

const meta = {
  title: 'Components/Prose',
  component: Prose,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The surface for member-written documents. Body text is set in the interface face with a readable measure; only a Work title, marked `work-title`, takes the serif face. Chinese, Japanese and Korean text gets more leading and a measure counted in characters.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="bg-background p-4 text-foreground sm:p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Prose>;
export default meta;
type Story = StoryObj<typeof meta>;

const lineHeightRatio = (element: HTMLElement) => {
  const style = getComputedStyle(element);
  return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
};

export const Article: Story = {
  render: () => (
    <Prose>
      <h2>
        Reading notes on <span className="work-title">The Dispossessed</span>
      </h2>
      <p>
        The novel opens with a wall around a spaceport, and the whole book is about which side of it you stand on. Le
        Guin alternates between two timelines, and they meet on the last page.
      </p>
      <ul>
        <li>The physics is a character, not a lecture.</li>
        <li>
          Anarres is a utopia with <a href="#anarres">real costs</a>.
        </li>
      </ul>
      <blockquote>
        <p>You cannot buy the revolution. You can only be the revolution.</p>
      </blockquote>
      <pre>
        <code>978-0-06-051275-4</code>
      </pre>
    </Prose>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const prose = canvasElement.querySelector<HTMLElement>('[data-slot="prose"]')!;
    // Interface face for body text and headings; the serif face is the Work title's alone.
    expect(getComputedStyle(prose).fontFamily).toContain('Manrope');
    expect(getComputedStyle(canvas.getByRole('heading', { level: 2 })).fontFamily).toContain('Manrope');
    expect(getComputedStyle(canvasElement.querySelector('.work-title')!).fontFamily).toMatch(/Source Serif|Iowan/);
    // About 65 characters per line.
    const reference = document.createElement('span');
    reference.style.cssText = 'position:absolute;visibility:hidden;font:inherit;width:65ch';
    prose.append(reference);
    expect(prose.getBoundingClientRect().width).toBeLessThanOrEqual(reference.getBoundingClientRect().width + 1);
    reference.remove();
    expect(lineHeightRatio(prose)).toBeCloseTo(1.75, 1);
  },
};

export const CjkText: Story = {
  render: () => (
    <div lang="zh-Hant">
      <Prose>
        <h2>
          <span className="work-title">三體</span>讀後記
        </h2>
        <p>
          黑暗森林法則是整部小說最核心的設定：宇宙就是一座黑暗森林，每個文明都是帶槍的獵人，像幽靈般潛行於林間，輕輕撥開擋路的樹枝，竭力不發出腳步聲，連呼吸都必須小心翼翼。
        </p>
      </Prose>
    </div>
  ),
  async play({ canvasElement }) {
    const prose = canvasElement.querySelector<HTMLElement>('[data-slot="prose"]')!;
    // CJK text needs more leading than Latin, and its measure is 36 em rather than 65 zeros.
    expect(lineHeightRatio(prose)).toBeCloseTo(1.9, 1);
    expect(prose.getBoundingClientRect().width).toBeLessThanOrEqual(
      parseFloat(getComputedStyle(prose).fontSize) * 36 + 1,
    );
    expect(getComputedStyle(canvasElement.querySelector('.work-title')!).fontFamily).toMatch(
      /Source Serif|Iowan|Noto Serif/,
    );
  },
};

export const LongWorkTitle: Story = {
  render: () => (
    <div className="w-72">
      <Prose>
        <h2>
          <span className="work-title">
            Supercalifragilisticexpialidocious_and_the_Unreasonably_Long_Subtitle_of_a_Light_Novel_Volume_Twelve
          </span>
        </h2>
        <p>A title with no break opportunities wraps inside its column instead of widening it.</p>
      </Prose>
    </div>
  ),
  async play({ canvasElement }) {
    const prose = canvasElement.querySelector<HTMLElement>('[data-slot="prose"]')!;
    expect(prose.scrollWidth).toBeLessThanOrEqual(prose.clientWidth);
  },
};

export const Empty: Story = {
  render: () => <DocumentBody document={fromPlainText('') as DocumentSnapshot} />,
  async play({ canvasElement }) {
    const body = canvasElement.querySelector<HTMLElement>('[data-slot="document-body"]')!;
    expect(body).toBeInTheDocument();
    expect(body.textContent).toBe('');
  },
};
