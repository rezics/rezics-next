import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

// axe-core, the engine behind Storybook's a11y addon, run on whole pages of the
// built site. Evaluated through the DevTools protocol, so the page's CSP does
// not apply to it.
const source = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** WCAG 2.2 A and AA, the level REZICS holds every page to. */
export const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string; html: string; summary: string }[];
}

/** Run axe on the page as it stands and return its violations, trimmed for reading. */
export async function axeViolations(page: Page, options: { exclude?: string[] } = {}): Promise<AxeViolation[]> {
  if (!await page.evaluate(() => 'axe' in globalThis)) await page.evaluate(source);
  return page.evaluate(async ({ tags, exclude }) => {
    const axe = (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{
      violations: { id: string; impact: string | null; help: string;
        nodes: { target: unknown[]; html: string; failureSummary?: string }[] }[] }> } }).axe;
    const result = await axe.run({ include: [['html']], exclude: exclude.map(selector => [selector]) },
      { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map(violation => ({ id: violation.id, impact: violation.impact, help: violation.help,
      nodes: violation.nodes.slice(0, 5).map(node => ({ target: node.target.map(String).join(' '),
        html: node.html.slice(0, 240), summary: node.failureSummary ?? '' })) }));
  }, { tags: [...wcagTags], exclude: options.exclude ?? [] });
}

/** A readable report of violations for an assertion message. */
export function formatViolations(violations: readonly AxeViolation[]): string {
  return violations.map(violation => `${violation.id} (${violation.impact}): ${violation.help}\n${violation.nodes
    .map(node => `  ${node.target}\n    ${node.html}\n    ${node.summary.replaceAll('\n', '\n    ')}`).join('\n')}`)
    .join('\n\n');
}
