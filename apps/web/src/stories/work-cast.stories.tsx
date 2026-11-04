import type { Meta, StoryObj } from '@storybook/react-vite';
import { defaultReader } from '../subject/reader';
import type { Item, RowValue } from '../features/pages/overview';
import { PlainLink } from '../features/pages/shared';
import { WorkCastWindow } from '../features/catalogue/work-cast/view';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const work = id(1);
const performer = id(2);

function performance(statement: string, character: string, name: string, gated = false): Item {
  const target = id(Number(character));
  const label = character === '4' ? 'The quiet traveller from the northern islands' : `Character ${character}`;
  return {
    id: performer,
    label: { text: 'A. Performer', lang: undefined },
    summary: {
      id: performer,
      type: 'schema:Person',
      types: ['schema:Person'],
      label: { value: 'A. Performer', language: 'en' },
      cover: null,
    },
    notes: [],
    qualified: [
      {
        property: 'wdt:P453',
        text: `Character: ${label}`,
        subject: {
          id: target,
          label,
          summary: {
            id: target,
            type: 'wd:Q95074',
            types: ['wd:Q95074'],
            label: { value: label, language: 'en' },
            cover: null,
          },
        },
      },
      { property: 'wdt:P3831', text: 'Role: Voice performer' },
      { property: 'wdt:P1932', text: `Credited as: ${name}` },
    ],
    statement,
    gated,
  };
}

const items = [
  performance(id(11), '3', 'A. Player'),
  performance(id(12), '3', 'A. Player'),
  performance(id(13), '4', 'A. Player'),
  {
    ...performance(id(14), '5', 'Withheld performer', true),
    qualified: [{ property: 'wdt:P453', text: 'Character: Unlabelled' }],
  },
];

const value = {
  locale: 'en',
  subject: work,
  context: undefined,
  link: PlainLink,
  reader: defaultReader,
  labels: {
    spoilerShow: 'Reveal spoiler',
    cover: { withheld: 'Cover withheld', reveal: 'Reveal cover', credit: 'Cover credit', via: 'Cover via' },
  },
  unlabelled: 'Unlabelled',
  spoilerShow: 'Reveal spoiler',
} as unknown as RowValue & { subject: string };

const meta: Meta<typeof WorkCastWindow> = {
  title: 'Pages/Subjects/Work cast',
  component: WorkCastWindow,
  args: { items, value, label: 'Voice credits' },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const CharacterFirst: Story = {};
