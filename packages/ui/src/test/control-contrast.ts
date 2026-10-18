import { expect, userEvent } from 'storybook/test';
import { settled } from '../stories/support.tsx';

type Color = Uint8ClampedArray;

function luminance(color: Color): number {
  const linear = Array.from(color.slice(0, 3), channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: Color, b: Color): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Use the browser's color conversion and alpha compositing, including color-mix().
 * These probes cover solid surfaces; refuse unsupported paint rather than ignore it. */
function colorProbe(element: HTMLElement) {
  const canvas = element.ownerDocument.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Control contrast needs a 2D color context');

  const paint = (color: string) => {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  };
  const fill = (target: HTMLElement) => {
    const style = getComputedStyle(target);
    if (style.opacity !== '1' || style.backgroundImage !== 'none') {
      throw new Error('Control contrast probe requires solid backgrounds without group opacity');
    }
    paint(style.backgroundColor);
  };
  const background = (target: HTMLElement | null): void => {
    if (!target) {
      paint('#ffffff');
      return;
    }
    background(target.parentElement);
    fill(target);
  };
  const color = () => context.getImageData(0, 0, 1, 1).data;
  background(element.parentElement);
  const outside = color();
  fill(element);
  const inside = color();
  return { paint, color, outside, inside };
}

/** An enabled field must remain identifiable without text, an icon or a focus ring. */
export async function expectControlBoundary(element: HTMLElement): Promise<void> {
  const style = getComputedStyle(element);
  await expect(Number.parseFloat(style.borderTopWidth), 'visible control boundary').toBeGreaterThanOrEqual(1);
  await expect(style.borderTopStyle).toBe('solid');
  const probe = colorProbe(element);
  probe.paint(style.borderTopColor);
  const border = probe.color();
  await expect(contrast(border, probe.outside), 'control boundary against its outer surface').toBeGreaterThanOrEqual(3);
  await expect(contrast(border, probe.inside), 'control boundary against its fill').toBeGreaterThanOrEqual(3);
}

/** Keyboard focus must add a contrasting cue while the error and entered value survive. */
export async function expectInvalidFieldKeyboardFocus(control: HTMLElement, frame = control): Promise<void> {
  await expect(control).toBeInvalid();
  await expect(control).not.toHaveFocus();
  await settled(frame);
  const resting = getComputedStyle(frame);
  const border = resting.borderTopColor;
  const outlineWidth = Number.parseFloat(resting.outlineWidth);
  const text = getComputedStyle(control).color;
  const value = (control as HTMLInputElement | HTMLTextAreaElement).value;
  await expectControlBoundary(frame);

  await userEvent.tab();
  await expect(control).toHaveFocus();
  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(control).toHaveValue(value);
  await settled(frame);
  const focused = getComputedStyle(frame);
  await expect(Number.parseFloat(focused.outlineWidth), 'focus adds a visible outline').toBeGreaterThan(outlineWidth);
  await expect(Number.parseFloat(focused.outlineWidth), 'focus outline remains discernible').toBeGreaterThanOrEqual(2);
  await expect(focused.outlineStyle).toBe('solid');
  await expect(Number.parseFloat(focused.outlineOffset), 'focus is separated from the error boundary').toBeGreaterThanOrEqual(2);
  const probe = colorProbe(frame);
  probe.paint(focused.outlineColor);
  await expect(contrast(probe.color(), probe.outside), 'focus indicator against the adjacent surface').toBeGreaterThanOrEqual(3);
  await expect(focused.borderTopColor, 'error boundary survives focus').toBe(border);
  await expect(getComputedStyle(control).color, 'error text survives focus').toBe(text);
  await expectControlBoundary(frame);
}

/** Check the track's outline and the thumb that communicates the on/off position. */
export async function expectSwitchContrast(toggle: HTMLElement): Promise<void> {
  const track = toggle.closest<HTMLElement>('[data-slot="switch"]');
  const thumb = track?.querySelector<HTMLElement>('[data-slot="switch-thumb"]');
  if (!track || !thumb) throw new Error('Switch contrast needs its track and thumb');
  const probe = colorProbe(track);
  await expect(contrast(probe.inside, probe.outside), 'switch track against its surface').toBeGreaterThanOrEqual(3);
  probe.paint(getComputedStyle(thumb).backgroundColor);
  await expect(contrast(probe.color(), probe.inside), 'switch thumb against its track').toBeGreaterThanOrEqual(3);
  const trackBounds = track.getBoundingClientRect();
  const thumbBounds = thumb.getBoundingClientRect();
  const offset = thumbBounds.x + thumbBounds.width / 2 - (trackBounds.x + trackBounds.width / 2);
  const right = (toggle as HTMLInputElement).checked !== (getComputedStyle(track).direction === 'rtl');
  await expect(right ? offset : -offset, 'thumb position agrees with the switch state').toBeGreaterThan(0);
}
