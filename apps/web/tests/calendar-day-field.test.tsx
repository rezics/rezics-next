import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CalendarDayField, calendarDayDate, calendarDayText } from '../src/library/calendar-day-field';
import { getLocale } from '../src/paraglide/runtime.js';

function dayName(value: string): string {
  const date = calendarDayDate(value);
  if (!date) throw new Error(`Invalid test calendar day: ${value}`);
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full' }).format(date);
}

function monthName(value: string): string {
  const date = calendarDayDate(value);
  if (!date) throw new Error(`Invalid test calendar day: ${value}`);
  return new Intl.DateTimeFormat(getLocale(), { month: 'long', year: 'numeric' }).format(date);
}

function shift(value: string, amount: number): string {
  const date = calendarDayDate(value);
  if (!date) throw new Error(`Invalid test calendar day: ${value}`);
  date.setDate(date.getDate() + amount);
  return calendarDayText(date);
}

function localeWeekStart(): number {
  const first = (new Intl.Locale(getLocale()) as Intl.Locale & { weekInfo?: { firstDay?: number } }).weekInfo?.firstDay;
  return first === 7 ? 0 : typeof first === 'number' ? first : 0;
}

function dayButton(grid: HTMLElement, value: string): HTMLButtonElement {
  return within(grid).getByRole('button', { name: dayName(value) });
}

async function openField(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: label }));
  const dialog = await screen.findByRole('dialog', { name: label });
  return { dialog, grid: within(dialog).getByRole('grid') };
}

describe('CalendarDayField', () => {
  it('moves one focused day across months, leap day and the locale week', async () => {
    const user = userEvent.setup();
    render(<CalendarDayField id="date" label="Date" value="2024-01-31" onChange={vi.fn()} />);
    const { dialog, grid } = await openField(user, 'Date');

    await user.keyboard('{PageDown}');
    expect(dayButton(grid, '2024-02-29')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(dayButton(grid, '2024-03-01')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(dayButton(grid, '2024-02-29')).toHaveFocus();

    const leapDay = calendarDayDate('2024-02-29')!;
    const offset = (leapDay.getDay() - localeWeekStart() + 7) % 7;
    const start = shift('2024-02-29', -offset);
    const end = shift(start, 6);
    await user.keyboard('{Home}');
    expect(dayButton(grid, start)).toHaveFocus();
    await user.keyboard('{End}');
    expect(dayButton(grid, end)).toHaveFocus();
    await user.keyboard('{PageUp}');
    expect(dialog.querySelector<HTMLElement>('[aria-live="polite"]')!).toHaveTextContent(
      new Intl.DateTimeFormat(getLocale(), { month: 'long', year: 'numeric' }).format(calendarDayDate('2024-02-01')!),
    );
    expect([...grid.querySelectorAll('button')].filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });

  it('starts within bounds, skips blocked days and selects the inclusive last day once', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CalendarDayField
        id="bounded"
        label="Bounded date"
        value="2024-01-31"
        min="2024-02-28"
        max="2024-03-01"
        onChange={onChange}
      />,
    );
    const { dialog, grid } = await openField(user, 'Bounded date');
    expect(dayButton(grid, '2024-02-28')).toHaveFocus();
    expect(dayButton(grid, '2024-02-27')).toBeDisabled();
    await user.keyboard('{ArrowLeft}');
    expect(dayButton(grid, '2024-02-28')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(dayButton(grid, '2024-02-29')).toHaveFocus();
    await user.keyboard('{PageDown}');
    expect(dayButton(grid, '2024-03-01')).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: monthName('2024-04-01') })).toBeDisabled();
    await user.keyboard('{ArrowRight}');
    expect(dayButton(grid, '2024-03-01')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.queryByRole('dialog', { name: 'Bounded date' })).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2024-03-01');
  });

  it('clears an optional selected day and keeps a required selected day', async () => {
    const user = userEvent.setup();
    const optionalChange = vi.fn();
    const requiredChange = vi.fn();
    render(
      <>
        <CalendarDayField id="optional" label="Optional" value="2024-02-29" onChange={optionalChange} />
        <CalendarDayField id="required" label="Required" value="2024-02-29" required onChange={requiredChange} />
      </>,
    );

    await openField(user, 'Optional');
    await user.keyboard(' ');
    expect(optionalChange).toHaveBeenCalledTimes(1);
    expect(optionalChange).toHaveBeenCalledWith('');
    expect(screen.queryByRole('dialog', { name: 'Optional' })).not.toBeInTheDocument();

    await openField(user, 'Required');
    await user.keyboard(' ');
    expect(requiredChange).toHaveBeenCalledTimes(1);
    expect(requiredChange).toHaveBeenCalledWith('2024-02-29');
    expect(screen.queryByRole('dialog', { name: 'Required' })).not.toBeInTheDocument();
  });

  it('returns focus on Escape and ends the visit when the field becomes disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const enabled = <CalendarDayField id="date" label="Date" value="2024-02-29" onChange={onChange} />;
    const { rerender } = render(enabled);
    const trigger = screen.getByRole('button', { name: 'Date' });
    await openField(user, 'Date');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Date' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const opened = await screen.findByRole('dialog', { name: 'Date' });
    expect(dayButton(within(opened).getByRole('grid'), '2024-02-29')).toHaveFocus();
    rerender(<CalendarDayField id="date" label="Date" value="2024-02-29" disabled onChange={onChange} />);
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Date' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    rerender(enabled);
    expect(screen.queryByRole('dialog', { name: 'Date' })).not.toBeInTheDocument();
  });

  it('keeps the strict local date text at the supported year edges', () => {
    for (const value of ['0001-01-01', '9999-12-31']) {
      expect(calendarDayText(calendarDayDate(value)!)).toBe(value);
    }
    expect(calendarDayDate('0000-12-31')).toBeUndefined();
    expect(calendarDayDate('10000-01-01')).toBeUndefined();
    expect(calendarDayDate('2024-02-30')).toBeUndefined();
  });
});
