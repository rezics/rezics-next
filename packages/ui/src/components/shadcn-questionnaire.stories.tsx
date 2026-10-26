import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@rezics/ui/shadcn/questionnaire';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Questionnaire',
  component: Questionnaire,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 480 } } },
} satisfies Meta<typeof Questionnaire>;
export default meta;
type Story = StoryObj<typeof meta>;

const items = [
  { name: 'shelf', required: true, choices: [{ value: 'want' }, { value: 'reading' }, { value: 'cjk' }] },
  { name: 'genres', choices: [{ value: 'scifi' }, { value: 'fantasy' }] },
  { name: 'note', required: true },
] as const;

const Onboarding = ({ onSubmit }: { onSubmit?: (data: FormData) => void }) => (
  <Questionnaire
    className="max-w-md"
    items={items}
    aria-label="Reading profile"
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit?.(new FormData(event.currentTarget));
    }}
  >
    <QuestionnaireProgress />
    <QuestionnaireItem name="shelf" required>
      <QuestionnaireTitle>Where does this Work go?</QuestionnaireTitle>
      <QuestionnaireDescription>Pick the shelf you use most.</QuestionnaireDescription>
      <QuestionnaireChoices>
        <QuestionnaireChoice value="want">Want to read</QuestionnaireChoice>
        <QuestionnaireChoice value="reading">
          Currently reading
          <QuestionnaireChoiceDescription>You can move it later.</QuestionnaireChoiceDescription>
        </QuestionnaireChoice>
        <QuestionnaireChoice value="cjk">想读：三体与更多的长标题作品名称，用来检查换行</QuestionnaireChoice>
      </QuestionnaireChoices>
      <QuestionnaireError>Choose a shelf to continue.</QuestionnaireError>
    </QuestionnaireItem>
    <QuestionnaireItem name="genres" multiple>
      <QuestionnaireTitle>Which genres do you like?</QuestionnaireTitle>
      <QuestionnaireChoices>
        <QuestionnaireChoice value="scifi">Science fiction</QuestionnaireChoice>
        <QuestionnaireChoice value="fantasy">Fantasy</QuestionnaireChoice>
      </QuestionnaireChoices>
    </QuestionnaireItem>
    <QuestionnaireItem name="note" required>
      <QuestionnaireTitle>Anything else?</QuestionnaireTitle>
      <QuestionnaireInput aria-label="Note" placeholder="黑暗森林 / Dark Forest" />
      <QuestionnaireError>Write a short note.</QuestionnaireError>
    </QuestionnaireItem>
    <QuestionnaireActions>
      <QuestionnairePrevious />
      <QuestionnaireSkip />
      <QuestionnaireNext />
      <QuestionnaireSubmit />
    </QuestionnaireActions>
  </Questionnaire>
);

export const Default: Story = {
  render: () => <Onboarding />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Question 1 of 3')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('radio', { name: 'Currently reading You can move it later.' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(canvas.getByText('Question 2 of 3')).toBeInTheDocument());
  },
};

export const LongCJKChoice: Story = {
  render: () => <Onboarding />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const choice = canvas.getByRole('radio', { name: /想读：三体/ });
    await userEvent.click(choice);
    await expect(choice).toBeChecked();
  },
};

export const RequiredError: Story = {
  render: () => <Onboarding />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(await canvas.findByText('Choose a shelf to continue.')).toBeInTheDocument();
    await expect(canvas.getByText('Question 1 of 3')).toBeInTheDocument();
  },
};

export const Walkthrough: Story = {
  render: () => <Onboarding />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: 'Want to read' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await canvas.findByText('Question 2 of 3');
    await userEvent.click(canvas.getByRole('button', { name: 'Skip' }));
    await canvas.findByText('Question 3 of 3');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Note' }), '黑暗森林');
    await expect(canvas.getByRole('button', { name: 'Submit' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Previous' }));
    await canvas.findByText('Question 2 of 3');
  },
};
