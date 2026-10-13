import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { ZoneBrowseQuery } from '../realm/types.ts';
import { recordedFetch, type RecordedSelection } from './recorded-fetch.ts';

// The answer-record guard validates this envelope; JSON imports infer optional
// header union members as undefined, which the recorded dictionaries never contain.
const record = books as AnswerRecord;
const sampleFor = (label: string) => {
  const sample = record.personas.visitor.find(value => value.label === label);
  if (!sample) throw new globalThis.Error(`Missing Books visitor sample: ${label}`);
  return sample;
};

function readBooks(fetcher: typeof fetch, label: string) {
  const url = new URL(sampleFor(label).path, 'https://recorded.invalid');
  const realm = url.pathname.split('/')[3]!;
  const query: ZoneBrowseQuery = {
    sort: url.searchParams.get('sort') as ZoneBrowseQuery['sort'],
    limit: Number(url.searchParams.get('limit')),
    type: url.searchParams.getAll('type'),
    q: url.searchParams.get('q') ?? undefined,
  };
  return browserMainApi(window.location.origin, { anonymous: true, fetcher })
    .v1.realms({ realm }).modules.browse.get({ query });
}

/** A transport proof: the component receives Eden's actual parsed answer. */
function RecordedBooks({ label, state }: RecordedSelection) {
  const [reply, setReply] = useState<Awaited<ReturnType<typeof readBooks>> | null>(null);
  useEffect(() => {
    setReply(null);
    const replay = recordedFetch(record, 'visitor', [{ label, state }], { pathPrefix: BFF_PREFIX });
    let mounted = true;
    void readBooks(replay.fetcher, label).then(answer => {
      // Eden turns transport failures into a 503 result. Preserve unmatched
      // request failures so a story cannot mistake them for recorded problems.
      if (!answer.response && answer.error) {
        if (mounted) throw answer.error.value;
        return;
      }
      if (mounted) setReply(answer);
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    });
    return () => { mounted = false; replay.dispose(); };
  }, [label, state]);

  return <main className="p-6 max-w-3xl space-y-4">
    <h1 className="text-xl font-semibold">Recorded Books answer</h1>
    {!reply ? <p role="status">Loading Books…</p> : reply.error ?
      <div role="alert">
        <p>API refused the request ({reply.error.status})</p>
        <pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(reply.error.value, null, 2)}</pre>
      </div> : reply.data ? <>
        <p role="status">{reply.data.items.length} books in this recorded page</p>
        {reply.data.items.length === 0 ? <p>No books matched the recorded query.</p> :
          <ul className="list-disc pl-6 space-y-1">
            {reply.data.items.map(item => <li key={item.id}>{item.title?.value ?? item.id}</li>)}
          </ul>}
      </> : <p role="alert">API returned no answer.</p>}
  </main>;
}

const meta = {
  title: 'Tooling/Recorded fetch', component: RecordedBooks,
  args: { label: 'browse-newest-0', state: 'populated' },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedBooks>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const answer = sampleFor('browse-newest-0').answer as { items: { title: { value: string } }[] };
    await expect(canvas.findByText(`${answer.items.length} books in this recorded page`)).resolves.toBeVisible();
    for (const item of answer.items) await expect(canvas.getByText(item.title.value)).toBeVisible();
  },
};

export const Empty: Story = {
  args: { label: 'search-no-match', state: 'empty' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.findByText('No books matched the recorded query.')).resolves.toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('0 books');
  },
};

export const Error: Story = {
  args: { label: 'unsupported-query-shape', state: 'error' },
  async play({ canvasElement }) {
    const alert = await within(canvasElement).findByRole('alert');
    const sample = sampleFor('unsupported-query-shape');
    await expect(alert).toHaveTextContent(`API refused the request (${sample.status})`);
    await expect(alert.querySelector('pre')?.textContent).toBe(JSON.stringify(sample.answer, null, 2));
  },
};

export const Loading: Story = {
  args: { state: 'loading' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('Loading Books…');
    await expect(canvas.queryByRole('list')).not.toBeInTheDocument();
  },
};
