/** Include the WCAG 2.2 rules that axe does not enable in its default ruleset. */
export const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export const accessibilityViewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 860 },
} as const;

export function blocksAccessibilityGate(violation: { impact?: string | null }): boolean {
  return violation.impact === 'serious' || violation.impact === 'critical';
}
