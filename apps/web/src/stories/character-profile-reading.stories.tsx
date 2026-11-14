import type { Meta, StoryObj } from '@storybook/react-vite';
import { PeopleReadingPage } from './people-reading-page';

const meta = {
  title: 'Subjects/Character complete profile',
  id: 'pages-subjects-character-profile-reading',
  component: PeopleReadingPage,
  args: { family: 'character', state: 'complete' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Invented permitted biographies, portraits and native-format credits served through the complete application route. Sparse facts and an independently failed relation keep their own reading states. Use the shared viewport, theme and all eight locale controls. These examples are interface fixtures; native and browser acceptance is deferred to the verifier.',
      },
    },
  },
} satisfies Meta<typeof PeopleReadingPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Complete: Story = {};
export const SparseFacts: Story = { args: { state: 'sparse' } };
export const IndependentRelationFailure: Story = { args: { state: 'relation-failure' } };
