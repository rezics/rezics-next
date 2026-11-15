import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CalendarDayField, calendarDayDate } from '../library/calendar-day-field';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';
import { Button } from '@rezics/ui/shadcn/button';

const meta = {
  title: 'Library/Calendar day field',
  id: 'patterns-library-calendar-day-field',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Decision: each open Calendar field owns one roving available local day; arrows move by day or week, Home and End use the locale week, PageUp, PageDown and month buttons move within bounds, Escape returns focus to the field, and disabling ends the visit.',
      },
    },
    viewport: {
      defaultViewport: 'phone390',
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function CalendarFields() {
  const [optional, setOptional] = useState('2024-01-31');
  const [bounded, setBounded] = useState('2024-02-29');
  const [disabled, setDisabled] = useState(false);
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-copies']}>
      <section className="mx-auto grid w-full max-w-md gap-5 p-4">
        <CalendarDayField
          id="calendar-optional"
          label={m.library_copy_acquired()}
          value={optional}
          onChange={setOptional}
        />
        <CalendarDayField
          id="calendar-bounded"
          label={m.library_loans_started()}
          value={bounded}
          min="2024-02-29"
          max="2024-03-01"
          required
          onChange={setBounded}
        />
        <CalendarDayField
          id="calendar-disabled"
          label={m.library_copy_disposed()}
          value="2024-03-01"
          disabled={disabled}
          onChange={() => undefined}
        />
        <Button type="button" className="w-fit" aria-pressed={disabled} variant="outline" size="sm" onClick={() => setDisabled((current) => !current)}
        >
          {disabled ? 'Enable date field' : 'Disable date field'}
        </Button>
      </section>
    </PatternStory>
  );
}

function dayName(value: string): string {
  const date = calendarDayDate(value);
  if (!date) throw new Error(`Invalid story calendar day: ${value}`);
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full' }).format(date);
}

function displayDay(value: string): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${value}T12:00:00Z`),
  );
}

export const PhoneKeyboardJourney: Story = {
  name: 'Phone: localized selection, bounds and close',
  render: () => <CalendarFields />,
  async play({ canvasElement }) {
    const page = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const optional = page.getByRole('button', { name: m.library_copy_acquired() });
    await userEvent.click(optional);
    await body.findByRole('grid');
    await userEvent.keyboard('{PageDown}');
    expect(body.getByRole('button', { name: dayName('2024-02-29') })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(optional).toHaveTextContent(displayDay('2024-02-29')));
    await userEvent.click(optional);
    await userEvent.keyboard(' ');
    await waitFor(() => expect(optional).toHaveTextContent('\u2014'));
    expect(body.queryByRole('dialog', { name: m.library_copy_acquired() })).not.toBeInTheDocument();

    const bounded = page.getByRole('button', { name: m.library_loans_started() });
    await userEvent.click(bounded);
    await body.findByRole('grid');
    await userEvent.keyboard('{PageDown}');
    expect(body.getByRole('button', { name: dayName('2024-03-01') })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(bounded).toHaveTextContent(displayDay('2024-03-01')));
    await userEvent.click(bounded);
    await userEvent.keyboard(' ');
    await waitFor(() => expect(bounded).toHaveTextContent(displayDay('2024-03-01')));

    const disabledField = page.getByRole('button', { name: m.library_copy_disposed() });
    await userEvent.click(disabledField);
    await body.findByRole('dialog', { name: m.library_copy_disposed() });
    await userEvent.click(page.getByRole('button', { name: 'Disable date field' }));
    await waitFor(() => expect(disabledField).toBeDisabled());
    await waitFor(() =>
      expect(body.queryByRole('dialog', { name: m.library_copy_disposed() })).not.toBeInTheDocument(),
    );
  },
};
