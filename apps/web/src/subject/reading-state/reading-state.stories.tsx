import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SubjectReadingState } from './index';
import { PatternStory } from '../../stories/page';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

const meta = { title: 'Patterns/Subjects/Public reading', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function UnavailableText() {
  const [retried, setRetried] = useState(false);
  const locale = getLocale();
  return (
    <PatternStory>
      <section className="mx-auto w-full max-w-3xl space-y-4 p-4" aria-label={m.subject_about()}>
        <h2 className="font-sans text-2xl">{m.subject_about()}</h2>
        <SubjectReadingState
          locale={locale}
          onRetry={(event) => {
            event.preventDefault();
            setRetried(true);
          }}
        />
        <output aria-live="polite">{retried ? m.subject_section_failed() : ''}</output>
      </section>
    </PatternStory>
  );
}

export const Unavailable: Story = {
  render: () => <UnavailableText />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('link', { name: m.subject_section_retry() });
    expect(retry).toHaveAttribute('href', '');
    retry.focus();
    expect(retry).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(canvas.getByRole('status')).toHaveTextContent(m.subject_section_failed());
  },
};

export const RetryStillUnavailable: Story = {
  ...Unavailable,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('link', { name: m.subject_section_retry() });
    await userEvent.click(retry);
    await userEvent.click(retry);
    expect(canvas.getByRole('status')).toHaveTextContent(m.subject_section_failed());
    expect(retry).toBeVisible();
  },
};
