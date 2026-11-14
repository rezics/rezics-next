import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SubjectRead } from '@rezics/client';
import { MusicContextProfile } from '../features/pages/music-context-profile';
import { catalogueEntries } from '../features/catalogue/catalogue-entry';
import type { MusicContextRead } from '../features/catalogue/music-context-profile';
import { releaseReturnHref } from '../features/catalogue/release-fidelity/navigation';
import { getLocale } from '../paraglide/runtime.js';
import { candidateContext } from '../subject/candidates';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const anchor = '00000000-0000-4000-8000-00000000c101';
const venue = '00000000-0000-4000-8000-00000000c102';
const event = '00000000-0000-4000-8000-00000000c103';
const selectedContext = '00000000-0000-4000-8000-000000000002';
const selectedRealm = '00000000-0000-4000-8000-000000000003';

function subject(context = candidateContext): SubjectRead {
  return {
    subject: {
      id: anchor,
      type: 'schema:Place',
      revision: 3,
      release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context,
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

function successful(
  state: 'populated' | 'empty' | 'removed',
  context = candidateContext,
): Extract<MusicContextRead, { ok: true }> {
  return {
    ok: true,
    public: subject(context),
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
              targetKind: 'place',
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

function ReadingStory({
  state,
}: {
  state:
    | 'populated'
    | 'empty'
    | 'failed'
    | 'removed'
    | 'selected'
    | 'selected-release-return'
    | 'selected-quotations-return'
    | 'realm'
    | 'unavailable-return'
    | 'graph-node'
    | 'graph-edge';
}) {
  const locale = getLocale();
  const hasContext =
    state === 'selected' ||
    state === 'selected-release-return' ||
    state === 'selected-quotations-return' ||
    state === 'unavailable-return';
  const initial: MusicContextRead | undefined =
    state === 'realm'
      ? undefined
      : state === 'failed'
        ? { ok: false, reason: 'unavailable' }
        : successful(
            state === 'removed' ? 'removed' : state === 'empty' ? 'empty' : 'populated',
            hasContext ? selectedContext : candidateContext,
          );
  const hasRealm = state === 'realm';
  const graph = catalogueEntries.graph({ id: venue, label: 'Harbor Hall', locale }).href;
  const returnTo =
    state === 'graph-node' || state === 'graph-edge'
      ? `${graph}?${new URLSearchParams({
          property: 'schema:location',
          direction: 'out',
          depth: '2',
          ...(state === 'graph-node'
            ? { node: anchor }
            : { edge: event, from: venue, to: anchor, edgeProperty: 'schema:location' }),
        })}`
      : state === 'selected-release-return'
        ? releaseReturnHref('Harbor Stage', locale, {
            id: anchor,
            context: selectedContext,
            digest: subject(selectedContext).subject.release,
            revision: 3,
            stream: 'forward:schema:location',
            cursor: 'selected-release-window-2',
            focus: 'related',
          })
        : state === 'selected-quotations-return'
          ? `/${locale}/subjects/${anchor}/harbor-stage/quotations?${new URLSearchParams({
              context: selectedContext,
              quote: event,
              quotationReturn: 'selected-quotation-2',
            })}`
          : state === 'unavailable-return'
            ? `/en/subjects/${anchor}/harbor-stage`
            : undefined;
  return (
    <PatternStory path={`/subjects/${anchor}/harbor-stage/music-context`}>
      <AppShell>
        <MusicContextProfile
          id={anchor}
          locale={locale}
          {...(hasContext ? { context: selectedContext } : {})}
          {...(hasRealm ? { realm: selectedRealm } : {})}
          returnTo={returnTo}
          initial={initial}
          initialStream={state === 'removed' ? 'schema:removed' : 'schema:location'}
          transport={{
            read: async () => successful('populated', hasContext ? selectedContext : candidateContext),
          }}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Music Context Reading',
  id: 'pages-subjects-music-context-reading',
  component: ReadingStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual music-context reader with exact selected-Context Release and Quotations returns, unsupported Realm and unavailable exact-return states. Companion returns preserve the admitted destination address. Check every story in all eight locale toolbar settings and both themes; use keyboard navigation at the phone and desktop viewport sizes. These fixtures are illustrative, not native or browser acceptance.',
      },
    },
  },
  args: { state: 'populated' },
} satisfies Meta<typeof ReadingStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Empty: Story = { args: { state: 'empty' } };
export const Failed: Story = { args: { state: 'failed' } };
export const RemovedStream: Story = { args: { state: 'removed' } };
export const SelectedContext: Story = { args: { state: 'selected' } };
export const SelectedContextReleaseReturn: Story = { args: { state: 'selected-release-return' } };
export const SelectedContextQuotationsReturn: Story = { args: { state: 'selected-quotations-return' } };
export const UnsupportedRealm: Story = { args: { state: 'realm' } };
export const UnavailableReturn: Story = { args: { state: 'unavailable-return' } };

export const GraphSelectedNode: Story = { args: { state: 'graph-node' } };
export const GraphExactEdge: Story = { args: { state: 'graph-edge' } };
