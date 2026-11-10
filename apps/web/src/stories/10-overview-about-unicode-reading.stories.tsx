import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { fromMarkdown } from '@rezics/document';
import type { SubjectRead } from '@rezics/client';
import { PageData, dataComponents } from '../features/pages/data';
import { CompositionRender } from '../features/pages/render';
import { pageDefinitions } from '../features/pages/layout';
import { sessionQuery } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import recordedSubject from '../kernel/recorded/subject.json';

const composition = {
  root: { props: {} },
  content: [{ type: 'Summary', props: { id: 'about' } }],
} satisfies CompositionDocument;
const prelude = 'A reader compares maps. '.repeat(17);
const prefix = `${prelude}${'星'.repeat(419 - prelude.length)}`;
const ending = '最後まで読める文書。 The complete ending remains available.';

/** Finite document variants on a recorded Subject DTO; these stories do not establish native disclosure. */
function suppliedAbout(paragraphs: boolean, spoiler: boolean) {
  const body = structuredClone(recordedSubject) as unknown as SubjectRead;
  const statement = structuredClone(body.subject.statements['schema:abstract']![0]!);
  const snapshot = structuredClone(
    fromMarkdown(
      `${paragraphs ? '第一段 é 👩🏽‍🚀' : `${prefix}é 👩🏽‍🚀`}\n\n第二段 שלום\n\n${ending}\n\n[Complete notes](https://example.test/notes) and >!a concealed ending!<.`,
      'text',
    ),
  );
  if (!paragraphs) {
    snapshot.doc.content![0]!.content = [
      { type: 'text', text: `${prefix}e` },
      { type: 'text', text: '\u0301 👩🏽‍🚀', marks: [{ type: 'bold' }] },
    ];
  }
  statement.value = { type: 'value', content: { language: 'ja', document: snapshot } };
  statement.qualifiers = spoiler
    ? [
        {
          property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
          value: { type: 'value', content: { amount: '+1', unit: '1' } },
        },
      ]
    : [];
  body.subject.statements = { 'schema:abstract': [statement] };
  body.subject.descriptions = {};
  return body;
}

function AboutReading({ paragraphs = false, spoiler = false }: { paragraphs?: boolean; spoiler?: boolean }) {
  const locale = getLocale();
  const [body] = useState(() => suppliedAbout(paragraphs, spoiler));
  const [client] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    return client;
  });
  useEffect(() => () => client.clear(), [client]);
  const plan = planReads(platformRegistry, composition, { subject: body.subject.id });
  const reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body }]));
  return (
    <QueryClientProvider client={client}>
      <main lang={locale} className="mx-auto max-w-3xl p-4">
        <h1 className="mb-6 text-2xl font-semibold">{m.subject_overview()}</h1>
        <PageData
          locale={locale}
          subject={body.subject.id}
          readingView="overview"
          document={composition}
          reads={reads}
          reader={{ spoilerLevel: 0, suitability: 'blur' }}
          messages={{
            unknown: m.subject_value_unknown(),
            none: m.subject_value_none(),
            unlabelled: m.subject_value_unlabelled(),
            sources: m.subject_sources(),
            aliases: '',
            search: '',
            spoilerShow: m.subject_spoiler_show(),
            documentSpoiler: m.thread_reveal_spoiler(),
          }}
        >
          <CompositionRender document={composition} definitions={pageDefinitions} components={dataComponents} />
        </PageData>
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Subjects/About Unicode reading',
  id: 'pages-subjects-about-unicode-reading',
  component: AboutReading,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AboutReading>;
export default meta;
type Story = StoryObj<typeof meta>;

async function readComplete(canvasElement: HTMLElement, paragraphs = false) {
  const canvas = within(canvasElement);
  const disclosure = canvasElement.querySelector<HTMLDetailsElement>('details[data-slot="summary-disclosure"]')!;
  const summary = disclosure.querySelector('summary')!;
  const excerpt = summary.querySelector('span')!;
  const full = disclosure.querySelector<HTMLElement>('[data-slot="document-body"]')!;
  await expect(disclosure).not.toHaveAttribute('open');
  await expect(excerpt).toHaveTextContent(paragraphs ? '第一段 é 👩🏽‍🚀 第二段 שלום…' : `${prefix}…`, {
    normalizeWhitespace: false,
  });
  await expect(full).not.toBeVisible();
  await expect(excerpt).toHaveAttribute('lang', 'ja');
  if (getLocale() === 'ja') await expect(full.parentElement).not.toHaveAttribute('lang');
  else await expect(full.parentElement).toHaveAttribute('lang', 'ja');
  await expect(summary).not.toHaveTextContent('a concealed ending');
  summary.focus();
  await userEvent.keyboard('{Enter}');
  await expect(disclosure).toHaveAttribute('open');
  await expect(full).toBeVisible();
  await expect(excerpt).not.toBeVisible();
  await expect(full).toHaveTextContent(ending);
  await expect(within(full).getByRole('link', { name: 'Complete notes' })).toHaveAttribute(
    'href',
    'https://example.test/notes',
  );
  await userEvent.click(within(full).getByRole('button', { name: m.thread_reveal_spoiler() }));
  await expect(full).toHaveTextContent('a concealed ending');
  summary.focus();
  await userEvent.keyboard(' ');
  await expect(disclosure).not.toHaveAttribute('open');
  await expect(full).not.toBeVisible();
  await expect(summary).toHaveTextContent(m.subject_summary_expand());
  // Reopening preserves the renderer and its already revealed inline spoiler.
  await userEvent.click(summary);
  await expect(disclosure.querySelector('[data-slot="document-body"]')).toBe(full);
  await expect(canvas.getByText(ending, { exact: false })).toBeVisible();
}

export const UnicodeDocument: Story = {
  play: async ({ canvasElement }) => readComplete(canvasElement),
};

export const TwoParagraphExcerpt: Story = {
  args: { paragraphs: true },
  play: async ({ canvasElement }) => readComplete(canvasElement, true),
};

export const SpoilerDocument: Story = {
  args: { spoiler: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector('details')).toBeNull();
    const gate = canvas.getByRole('button', { name: m.subject_spoiler_show() });
    gate.focus();
    await userEvent.keyboard('{Enter}');
    await expect(gate).toHaveAttribute('aria-expanded', 'true');
    await readComplete(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.subject_spoiler_hide() }));
    await expect(gate).toHaveAttribute('aria-expanded', 'false');
  },
};
