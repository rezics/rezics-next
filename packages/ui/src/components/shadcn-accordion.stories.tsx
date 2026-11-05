import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@rezics/ui/shadcn/accordion';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Accordion',
  component: Accordion,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Accordion>;
export default meta;
type Story = StoryObj<typeof meta>;

const Rules = ({ items = rules, ...props }: { items?: typeof rules } & React.ComponentProps<typeof Accordion>) => (
  <Accordion className="max-w-md" {...props}>
    {items.map((rule) => (
      <AccordionItem key={rule.value} value={rule.value} disabled={rule.disabled}>
        <AccordionTrigger>{rule.title}</AccordionTrigger>
        <AccordionContent>{rule.body}</AccordionContent>
      </AccordionItem>
    ))}
  </Accordion>
);

const rules = [
  { value: 'spoilers', title: 'Mark spoilers', body: 'Hide plot turns behind a spoiler tag.', disabled: false },
  {
    value: 'ratings',
    title: 'Rate what you read',
    body: 'Ratings count once an edition is marked read.',
    disabled: false,
  },
  { value: 'appeals', title: 'Appeals', body: 'A different moderator reviews your appeal.', disabled: false },
];

export const Default: Story = {
  render: () => <Rules />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Mark spoilers' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    await expect(await canvas.findByText('Hide plot turns behind a spoiler tag.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Rate what you read' }));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  },
};

export const OpenAndMultiple: Story = {
  render: () => <Rules defaultValue={['spoilers', 'appeals']} multiple />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Mark spoilers' })).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByRole('button', { name: 'Appeals' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(canvas.getByRole('button', { name: 'Rate what you read' }));
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Rate what you read' })).toHaveAttribute('aria-expanded', 'true'),
    );
    await expect(canvas.getByRole('button', { name: 'Mark spoilers' })).toHaveAttribute('aria-expanded', 'true');
  },
};

export const Disabled: Story = {
  render: () => <Rules items={rules.map((rule) => ({ ...rule, disabled: rule.value === 'ratings' }))} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Rate what you read' });
    await expect(trigger).toBeDisabled();
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <Rules
      defaultValue={['long']}
      items={[
        {
          value: 'long',
          title: 'A very long rule title that keeps going until it has to wrap onto a second line inside the trigger',
          body: 'Ken Liu’s 2014 English translation of The Three-Body Problem is quoted here with the edition, translator and page named, so readers can find the passage again.',
          disabled: false,
        },
        {
          value: 'cjk',
          title: '標記劇透：請在內文中隱藏情節轉折並註明章節與卷數',
          body: '請使用劇透標籤隱藏情節轉折，並標明出處的章節或卷數。日本語の説明も同じように折り返されます。',
          disabled: false,
        },
      ]}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /^A very long rule title/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await userEvent.click(canvas.getByRole('button', { name: /^標記劇透/ }));
    await expect(await canvas.findByText(/請使用劇透標籤/)).toBeVisible();
  },
};
