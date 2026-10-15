import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { storyAccessibilityViolations } from '../../../../scripts/qa/story-accessibility.ts';

const meta = {
  title: 'Accessibility/Launch gate',
  render: () => <div className="p-6"><button type="button" className="min-h-6 px-3 text-primary">Continue</button></div>,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Each broken control exists only while the engine is measured; the story ends in its repaired state. */
export const UnnamedControl: Story = { async play({ canvasElement }) {
  const button = canvasElement.querySelector('button')!;
  try {
    button.textContent = '';
    const violations = await storyAccessibilityViolations(canvasElement);
    await expect(violations.map(item => item.id)).toContain('button-name');
    await expect(violations.find(item => item.id === 'button-name')?.impact).toBe('critical');
  } finally { button.textContent = 'Continue'; }
  await expect(await storyAccessibilityViolations(canvasElement)).toEqual([]);
} };

export const InsufficientContrast: Story = { async play({ canvasElement }) {
  const button = canvasElement.querySelector('button')!;
  try {
    button.style.cssText = 'color: #eeeeee; background: #ffffff';
    const violations = await storyAccessibilityViolations(canvasElement);
    await expect(violations.map(item => item.id)).toContain('color-contrast');
    await expect(violations.find(item => item.id === 'color-contrast')?.impact).toBe('serious');
  } finally { button.removeAttribute('style'); }
  await expect(await storyAccessibilityViolations(canvasElement)).toEqual([]);
} };

export const CrowdedSmallTargets: Story = { async play({ canvasElement }) {
  const button = canvasElement.querySelector('button')!;
  const neighbour = button.cloneNode(true) as HTMLButtonElement;
  try {
    button.style.cssText = 'width: 16px; height: 16px; min-height: 0; padding: 0; font-size: 8px';
    button.textContent = 'A';
    neighbour.style.cssText = button.style.cssText;
    neighbour.textContent = 'B';
    button.after(neighbour);
    const violations = await storyAccessibilityViolations(canvasElement);
    await expect(violations.map(item => item.id)).toContain('target-size');
  } finally {
    neighbour.remove();
    button.textContent = 'Continue';
    button.removeAttribute('style');
  }
  await expect(await storyAccessibilityViolations(canvasElement)).toEqual([]);
} };
