import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';

export async function openReadingOverviewTools(canvasElement: HTMLElement) {
  const scope = canvasElement.closest<HTMLElement>('details[data-slot="reading-overview-tools"]') ?? canvasElement;
  const summary = await within(scope).findByText(m.subject_details(), {
    selector: 'details[data-slot="reading-overview-tools"] > summary',
  });
  const details = summary.closest('details')!;
  if (!details.open) await userEvent.click(summary);
  await waitFor(() => expect(details).toHaveAttribute('open'));
}
