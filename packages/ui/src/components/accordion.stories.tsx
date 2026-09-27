import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { withTheme } from '../stories/support.tsx';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion.tsx';

const rules = [
  {
    value: 'spoilers',
    title: 'Mark spoilers',
    body: 'Hide plot turns behind a spoiler tag and name the chapter or volume they come from.',
  },
  {
    value: 'ratings',
    title: 'Rate what you read',
    body: 'Ratings count once you mark an edition as read. Re-rating after a re-read replaces the old score.',
  },
  {
    value: 'translators',
    title: 'Credit translators',
    body: 'Name the translator and edition when you quote a translation, for example Ken Liu’s 2014 English translation.',
  },
  {
    value: 'appeals',
    title: 'Appeals',
    body: 'If a moderator removes your post, you can appeal once from your inbox. A different moderator reviews it.',
  },
];

const meta = {
  title: 'Rezics UI/Accordion',
  component: Accordion,
  tags: ['autodocs'],
  decorators: [withTheme],
  args: { defaultValue: ['spoilers'], onValueChange: fn() },
  parameters: {
    docs: {
      description: {
        component:
          'A stack of headings that each reveal a short section, for reference content readers scan rather than read in order: a Realm’s rules, help and FAQ answers, the details of a Work’s editions. Only one section is open at a time unless `multiple` is set; arrow keys move between headings. Do not hide content most readers need; show it.',
      },
    },
  },
} satisfies Meta<typeof Accordion>;
export default meta;
type Story = StoryObj<typeof meta>;

const RealmRules = (args: React.ComponentProps<typeof Accordion> & { disabledItem?: string }) => {
  const { disabledItem, ...rest } = args;

  return (
    <Accordion className="max-w-xl" {...rest}>
      {rules.map((rule) => (
        <AccordionItem disabled={rule.value === disabledItem} key={rule.value} value={rule.value}>
          <AccordionTrigger>{rule.title}</AccordionTrigger>
          <AccordionContent className="text-muted-foreground">{rule.body}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
};

export const Default: Story = {
  render: (args) => <RealmRules {...args} />,
  async play({ args, canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Mark spoilers' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Rate what you read' }));
    await expect(canvas.getByRole('button', { name: 'Rate what you read' })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Mark spoilers' })).toHaveAttribute('aria-expanded', 'false'),
    );
    await expect(args.onValueChange).toHaveBeenCalledWith(expect.objectContaining({ value: ['ratings'] }));
  },
};

export const KeyboardNavigation: Story = {
  render: (args) => <RealmRules {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Mark spoilers' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Rate what you read' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('button', { name: 'Rate what you read' })).toHaveAttribute('aria-expanded', 'true');
  },
};

export const Multiple: Story = {
  args: { multiple: true, defaultValue: ['spoilers', 'appeals'] },
  render: (args) => <RealmRules {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Mark spoilers' })).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByRole('button', { name: 'Appeals' })).toHaveAttribute('aria-expanded', 'true');
  },
};

export const Collapsed: Story = {
  args: { defaultValue: [] },
  render: (args) => <RealmRules {...args} />,
};

export const Disabled: Story = {
  render: (args) => <RealmRules {...args} disabledItem="appeals" />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Appeals' })).toBeDisabled();
  },
};

export const Chinese: Story = {
  args: { defaultValue: ['q1'] },
  render: (args) => (
    <Accordion className="max-w-xl" {...args}>
      <AccordionItem value="q1">
        <AccordionTrigger>为什么《三体》有两个评分？</AccordionTrigger>
        <AccordionContent className="text-muted-foreground">
          上方是「科幻」Realm 成员的评分；出版方提供的汇总评分作为来源统计单独显示，因为它的评分语境未知。
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="q2">
        <AccordionTrigger>如何补充 Ken Liu 译本的信息？</AccordionTrigger>
        <AccordionContent className="text-muted-foreground">
          在作品页选择「版本」，提交修订，审核通过后对所有读者可见。
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
  async play({ canvasElement }) {
    await expect(
      within(canvasElement).getByRole('button', { name: '为什么《三体》有两个评分？' }),
    ).toHaveAttribute('aria-expanded', 'true');
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark' },
};
