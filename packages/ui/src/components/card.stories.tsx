import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './button.tsx';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card.tsx';

const meta = {
  title: 'Rezics UI/Card',
  component: Card,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-md p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card>
      <CardHeader>
        <CardTitle>The Three-Body Problem</CardTitle>
        <CardDescription>Hard Science Fiction · 287 member ratings</CardDescription>
        <CardAction>
          <Button size="sm" variant="outline">
            Save
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-sm">A discussion of first contact and its effects on life on Earth.</p>
      </CardContent>
      <CardFooter>
        <Button size="sm">Open Work</Button>
      </CardFooter>
    </Card>
  ),
};

export const LongTitle: Story = {
  render: () => (
    <Card>
      <CardHeader
        title="《三体》与跨文化阅读：Notes from a community conversation across languages and editions"
        description="A discussion in the Hard Science Fiction Realm"
      />
      <CardContent>Long titles wrap without hiding the card action or description.</CardContent>
    </Card>
  ),
};
