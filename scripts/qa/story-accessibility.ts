import axe, { type ElementContext } from 'axe-core';
import { blocksAccessibilityGate, wcagTags } from './accessibility.ts';

/** Use the same engine and WCAG rules for the gate and its browser regression cases. */
export async function storyAccessibilityViolations(context: ElementContext) {
  axe.reset();
  const results = await axe.run(context, { runOnly: { type: 'tag', values: [...wcagTags] } });
  return results.violations.filter(blocksAccessibilityGate);
}
