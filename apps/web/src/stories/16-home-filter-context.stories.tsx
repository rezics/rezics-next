import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HomeFeedConsumer } from '../features/pages/home-feed';
import type { FeedInput, HomeFeedResult } from '../features/pages/home-feed-read';
import type { QuestionPointResult } from '../features/pages/home-feed-questions';
import {
  homeFeedStoryPage,
  homeKindStoryPage,
  homeQuestionStoryPage,
  homeStorySpace,
} from '../kernel/fake/home-feed-stories';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

type State = 'ready' | 'preparing' | 'denied' | 'lost' | 'delayed';
function PreparedContext({ long = false, initial = 'ready' }: { long?: boolean; initial?: State }) {
  const locale = getLocale();
  const [client] = useState(() => new QueryClient());
  const [account, setAccount] = useState('A');
  const [state, setState] = useState<State>(initial);
  const currentState = useRef(state);
  currentState.current = state;
  const [reads, setReads] = useState(0);
  const [input, setInput] = useState<FeedInput>({ stream: 'home' });
  const pending = useRef<Array<() => void>>([]);
  const question = {
    ...homeQuestionStoryPage().ratingQuestions[0]!,
    ...(long
      ? {
          label:
            'Prepared question — the meaning of a lasting impression, across a long and carefully considered reading experience',
        }
      : {}),
  };
  const space = {
    ...homeStorySpace,
    ...(long
      ? {
          title: 'Prepared Reading Room — a place for long conversations about books, characters and remembered worlds',
        }
      : {}),
  };
  const page = { ...homeFeedStoryPage(locale, false, 'empty'), next: 'prepared-feed-next' };
  const result: HomeFeedResult = { state: 'ready', page };
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <aside className="space-y-2 rounded-xl border p-3" aria-label="Prepared filter fixture">
          <p>Prepared Home selections. Illustrative metadata and feed responses, not native acceptance.</p>
          <div className="flex flex-wrap gap-2">
            <label className="grid gap-1">
              Prepared source state
              <select
                className="min-h-11 rounded border bg-background"
                value={state}
                onChange={(event) => setState(event.target.value as State)}
              >
                {(['ready', 'preparing', 'denied', 'lost', 'delayed'] as const).map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button className="min-h-11 rounded border px-3" onClick={() => setAccount(account === 'A' ? 'B' : 'A')}>
              Prepared account {account}: replace
            </button>
            <button
              className="min-h-11 rounded border px-3"
              onClick={() => {
                setState('ready');
                for (const release of pending.current.splice(0)) release();
              }}
            >
              Release prepared selection
            </button>
          </div>
          <output aria-label="Prepared feed reads">{reads}</output>
          <output aria-label="Prepared current request" className="block break-all text-xs">
            {JSON.stringify(input)}
          </output>
        </aside>
        <HomeFeedConsumer
          key={account}
          initial={result}
          locale={locale}
          signedIn
          origin="https://rezics.example"
          read={async (next) => {
            setReads((value) => value + 1);
            setInput(next);
            return { state: 'ready', page };
          }}
          readKinds={async (cursor) =>
            currentState.current === 'preparing'
              ? { status: 'preparing' }
              : currentState.current === 'denied'
                ? { status: 'denied' }
                : { status: 'ready', kinds: homeKindStoryPage(cursor) }
          }
          readSpace={async () =>
            currentState.current === 'denied' ? { status: 'denied' } : { status: 'ready', space }
          }
          readQuestions={async (cursor) =>
            currentState.current === 'denied'
              ? { status: 'denied', code: 'prepared' }
              : {
                  status: 'ready',
                  page: cursor
                    ? homeQuestionStoryPage(cursor)
                    : { ...homeQuestionStoryPage(), ratingQuestions: [question] },
                }
          }
          readQuestion={async (): Promise<QuestionPointResult> => {
            if (currentState.current === 'delayed') await new Promise<void>((resolve) => pending.current.push(resolve));
            return currentState.current === 'lost'
              ? { status: 'lost', code: 'prepared_missing' }
              : currentState.current === 'denied'
                ? { status: 'denied', code: 'prepared_denied' }
                : { status: 'ready', question };
          }}
        />
      </div>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Pages/Discovery/Home filter context',
  component: PreparedContext,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Prepared immediate Home context, retained metadata, explicit pages and session retirement. Reuses the installed selection owner and its public FeedResults, card and action ports.',
      },
    },
  },
} satisfies Meta<typeof PreparedContext>;
export default meta;
type Story = StoryObj<typeof meta>;

async function journey({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByLabelText('Prepared feed reads')).not.toHaveTextContent(/^0$/));
  const before = canvas.getByLabelText('Prepared feed reads').textContent;
  const trigger = canvas.getByRole('button', { name: m.search_filters() });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  const dialog = within(await canvas.findByRole('dialog', { name: m.home_filter_title() }));
  await expect(canvas.getByLabelText('Prepared feed reads')).toHaveTextContent(before!);
  await userEvent.click(dialog.getByRole('button', { name: m.home_kinds_load() }));
  await userEvent.selectOptions(dialog.getByLabelText(m.home_kind_label()), homeKindStoryPage().values[0]!.id);
  await userEvent.type(dialog.getByLabelText(m.home_space_label()), homeStorySpace.address);
  await userEvent.click(dialog.getByRole('button', { name: m.home_space_lookup() }));
  await userEvent.click(await dialog.findByRole('button', { name: m.home_space_select() }));
  await userEvent.click(dialog.getByRole('button', { name: m.home_questions_load() }));
  await userEvent.selectOptions(
    dialog.getByLabelText(m.home_question_label()),
    homeQuestionStoryPage().ratingQuestions[0]!.id,
  );
  const footer = within(canvasElement.querySelector('[data-home-filter-surface]')!.lastElementChild as HTMLElement);
  await expect(footer.getByRole('list', { name: m.refinement_selected() })).toBeVisible();
  await userEvent.click(footer.getByRole('button', { name: m.refinement_remove({ value: homeStorySpace.title }) }));
  await expect(canvas.getByLabelText('Prepared current request')).not.toHaveTextContent('spaceId');
  await userEvent.keyboard('{Escape}');
  await expect(trigger).toHaveFocus();
  await userEvent.click(canvas.getByRole('button', { name: m.home_feed_following() }));
  await userEvent.click(canvas.getByRole('button', { name: m.library_next_page() }));
  await userEvent.click(trigger);
  const clear = within(canvas.getByRole('dialog')).getByRole('button', { name: m.refinement_clear() });
  const reads = Number(canvas.getByLabelText('Prepared feed reads').textContent);
  await userEvent.click(clear);
  await waitFor(() => expect(canvas.getByLabelText('Prepared feed reads')).toHaveTextContent(String(reads + 1)));
  await expect(canvas.getByLabelText('Prepared current request')).toHaveTextContent('{"stream":"following"}');
  await expect(within(canvas.getByRole('dialog')).queryByRole('list', { name: m.refinement_selected() })).toBeNull();
  await userEvent.keyboard('{Escape}');
}
export const DesktopJourney: Story = { globals: { viewport: { value: 'desktop', isRotated: false } }, play: journey };
export const PhoneJourney: Story = { globals: { viewport: { value: 'phone', isRotated: false } }, play: journey };
export const DarkPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false }, theme: 'dark' },
  play: journey,
};
export const DarkDesktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false }, theme: 'dark' },
  play: journey,
};
export const LongStrings: Story = {
  args: { long: true },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    const dialog = within(canvas.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: m.home_questions_load() }));
    await userEvent.selectOptions(
      dialog.getByLabelText(m.home_question_label()),
      homeQuestionStoryPage().ratingQuestions[0]!.id,
    );
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const opener = canvas.getByRole('button', { name: m.search_filters() });
    opener.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = canvas.getByRole('dialog');
    await expect(dialog.contains(document.activeElement)).toBe(true);
    for (let index = 0; index < 12; index++) {
      await userEvent.tab();
      await expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard('{Escape}');
    await expect(opener).toHaveFocus();
  },
};
export const UnavailableRetainedChoice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    let dialog = within(canvas.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: m.home_questions_load() }));
    await userEvent.selectOptions(
      dialog.getByLabelText(m.home_question_label()),
      homeQuestionStoryPage().ratingQuestions[0]!.id,
    );
    await userEvent.keyboard('{Escape}');
    await userEvent.selectOptions(canvas.getByLabelText('Prepared source state'), 'lost');
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    dialog = within(canvas.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: m.home_question_refresh() }));
    await expect(dialog.getAllByText(m.home_questions_lost()).length).toBeGreaterThan(0);
  },
};
export const OpenSheetAccountReplacement: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    const dialog = within(canvas.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: m.home_questions_load() }));
    await userEvent.selectOptions(
      dialog.getByLabelText(m.home_question_label()),
      homeQuestionStoryPage().ratingQuestions[0]!.id,
    );
    // An external account observation can replace a visit while the modal contains keyboard focus.
    canvas.getByRole('button', { name: 'Prepared account A: replace', hidden: true }).click();
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
  },
};
