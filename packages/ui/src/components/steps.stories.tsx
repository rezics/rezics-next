import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { withTheme } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Steps,
  StepsCompletedContent,
  StepsContent,
  StepsDescription,
  StepsIndicator,
  StepsItem,
  StepsList,
  StepsNext,
  StepsPrevious,
  StepsSeparator,
  StepsTitle,
  StepsTrigger,
} from './steps.tsx';

const realmSteps = [
  {
    title: 'Name',
    description: 'Title and topic',
    body: 'Call the Realm “Hard SF” and describe it: science fiction that takes physics seriously.',
  },
  {
    title: 'Rules',
    description: 'What members agree to',
    body: 'Start from the REZICS community rules, then add spoiler tagging and translator credits.',
  },
  {
    title: 'Moderators',
    description: 'Who reviews reports',
    body: 'Invite @ye_wenjie and @luoji_2007. They review reports and appeals together.',
  },
  {
    title: 'Publish',
    description: 'Open to readers',
    body: 'Publish to let readers find, join and post in Hard SF.',
  },
];

const meta = {
  title: 'Rezics UI/Steps',
  component: Steps,
  tags: ['autodocs'],
  decorators: [withTheme],
  args: { count: realmSteps.length, defaultStep: 0, onStepChange: fn() },
  parameters: {
    docs: {
      description: {
        component:
          'Shows progress through a short, ordered task and lets readers move between its steps: creating a Realm, importing shelves from another site, submitting a new Work with its first edition. Keep it to three to five steps with short titles; completed steps show a check. Use a single form when the order does not matter.',
      },
    },
  },
} satisfies Meta<typeof Steps>;
export default meta;
type Story = StoryObj<typeof meta>;

const CreateRealm = (args: React.ComponentProps<typeof Steps>) => (
  <Steps {...args}>
    <StepsList>
      {realmSteps.map((step, index) => (
        <StepsItem index={index} key={step.title}>
          <StepsTrigger>
            <StepsIndicator>{index + 1}</StepsIndicator>
            <span className="flex flex-col items-start gap-1 text-start">
              <StepsTitle>{step.title}</StepsTitle>
              <StepsDescription className="max-sm:hidden">{step.description}</StepsDescription>
            </span>
          </StepsTrigger>
          <StepsSeparator />
        </StepsItem>
      ))}
    </StepsList>
    {realmSteps.map((step, index) => (
      <StepsContent className="text-sm" index={index} key={step.title}>
        {step.body}
      </StepsContent>
    ))}
    <StepsCompletedContent className="text-sm">
      Hard SF is live. Share it from the Realm page.
    </StepsCompletedContent>
    <div className="flex gap-2">
      <StepsPrevious asChild>
        <Button variant="outline">Back</Button>
      </StepsPrevious>
      <StepsNext asChild>
        <Button>Continue</Button>
      </StepsNext>
    </div>
  </Steps>
);

export const Default: Story = {
  render: (args) => <CreateRealm {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Back' })).toBeDisabled();
    await expect(canvas.getByText(/Call the Realm/)).toBeVisible();
  },
};

export const Advance: Story = {
  render: (args) => <CreateRealm {...args} />,
  async play({ args, canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    await expect(args.onStepChange).toHaveBeenCalledWith({ step: 1 });
    await expect(canvas.getByText(/Start from the REZICS community rules/)).toBeVisible();
  },
};

export const JumpToStep: Story = {
  render: (args) => <CreateRealm {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: /Moderators/ }));
    await expect(canvas.getByRole('tab', { name: /Moderators/ })).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByText(/Invite @ye_wenjie/)).toBeVisible();
  },
};

export const InProgress: Story = {
  args: { defaultStep: 2 },
  render: (args) => <CreateRealm {...args} />,
};

export const Completed: Story = {
  args: { defaultStep: realmSteps.length },
  render: (args) => <CreateRealm {...args} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/Hard SF is live/)).toBeVisible();
    await expect(within(canvasElement).getByText('4')).not.toBeVisible();
  },
};

export const Vertical: Story = {
  args: { defaultStep: 1, orientation: 'vertical' },
  render: (args) => <CreateRealm {...args} />,
};

export const Chinese: Story = {
  args: { count: 3, defaultStep: 1 },
  render: (args) => (
    <Steps {...args}>
      <StepsList>
        {['上传书单', '匹配版本', '确认导入'].map((title, index) => (
          <StepsItem index={index} key={title}>
            <StepsTrigger>
              <StepsIndicator>{index + 1}</StepsIndicator>
              <StepsTitle>{title}</StepsTitle>
            </StepsTrigger>
            <StepsSeparator />
          </StepsItem>
        ))}
      </StepsList>
      <StepsContent className="text-sm" index={1}>
        219 部作品中 212 部已匹配，例如《三体》匹配到重庆出版社 2008 年版。
      </StepsContent>
    </Steps>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('tab', { name: /匹配版本/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const Dark: Story = {
  ...InProgress,
  parameters: { theme: 'dark' },
};
