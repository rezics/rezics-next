import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SubjectRead } from '@rezics/client';
import { MusicContextProfile } from '../features/pages/music-context-profile';
import type { MusicContextRead } from '../features/catalogue/music-context-profile';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const anchor = '00000000-0000-4000-8000-00000000c101';
const venue = '00000000-0000-4000-8000-00000000c102';
const event = '00000000-0000-4000-8000-00000000c103';

function subject(): SubjectRead {
  return {
    subject: {
      id: anchor,
      type: 'schema:Place',
      revision: 3,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: 'Harbor Stage' },
      descriptions: {},
      aliases: {},
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {},
    summary: null,
  };
}

function successful(state: 'populated' | 'empty' | 'removed'): Extract<MusicContextRead, { ok: true }> {
  return {
    ok: true,
    public: subject(),
    kind: 'place',
    facts: [
      {
        property: 'schema:startDate',
        label: 'Opening date',
        text: '2001-05 · month · Julian',
        time: {
          state: 'supported',
          text: '2001-05 · month · Julian',
          date: '+2001-05',
          precision: 10,
          calendar: 'julian',
        },
      },
    ],
    streams: [
      { id: 'schema:location', label: 'Located at' },
      { id: 'wdt:P8000', label: 'Other related events' },
    ],
    links:
      state === 'populated'
        ? [
            {
              id: venue,
              label: 'Harbor Hall',
              property: 'schema:location',
              position: 1,
              occurrence: '00000000-0000-4000-8000-00000000c111',
              role: { property: 'schema:role', label: 'Role', text: 'main hall' },
            },
            {
              id: '',
              label: '',
              property: 'schema:location',
              position: 2,
              occurrence: '00000000-0000-4000-8000-00000000c112',
              unreadable: true,
            },
            {
              id: event,
              label: 'Summer concert',
              property: 'schema:location',
              position: 3,
              occurrence: '00000000-0000-4000-8000-00000000c113',
            },
          ]
        : [],
    next: state === 'populated' ? 'opaque-next-page' : null,
    ...(state === 'removed' ? { streamUnavailable: true } : { stream: 'schema:location' }),
  };
}

function ReadingStory({ state }: { state: 'populated' | 'empty' | 'failed' | 'removed' }) {
  const locale = getLocale();
  const initial: MusicContextRead =
    state === 'failed' ? { ok: false, reason: 'unavailable' } : successful(state === 'removed' ? 'removed' : state);
  return (
    <PatternStory path={`/subjects/${anchor}/harbor-stage/music-context`}>
      <AppShell>
        <MusicContextProfile
          id={anchor}
          locale={locale}
          initial={initial}
          initialStream={state === 'removed' ? 'schema:removed' : 'schema:location'}
          transport={{
            read: async () => successful('populated'),
          }}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Music Context Reading',
  component: ReadingStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual admitted music-context reader with a finite relation selector, recorded facts, unreadable endpoints, an empty page, a recoverable failure and a removed stream address.',
      },
    },
  },
  globals: { locale: 'en' },
  args: { state: 'populated' },
} satisfies Meta<typeof ReadingStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Empty: Story = { args: { state: 'empty' } };
export const Failed: Story = { args: { state: 'failed' } };
export const RemovedStream: Story = { args: { state: 'removed' } };
