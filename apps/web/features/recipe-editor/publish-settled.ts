import type { PublishOutcome } from './saves.ts';

/**
 * Publication is of the recipe a reader will open. Composition and details writes still in
 * flight, including one record waiting behind another, finish before the notes are published,
 * and again afterwards so a write that started during publication is not still outstanding
 * when the editor says it is published.
 */
export async function publishWhenSettled(input: {
  recipe: { whenIdle(): Promise<void> };
  details: { whenIdle(): Promise<void> };
  notes: { whenIdle(): Promise<void>; publish(body: string): Promise<PublishOutcome> };
  /** Read after the writes ahead of publication have settled, so the field is what gets published. */
  body: string | (() => string);
}): Promise<PublishOutcome> {
  await Promise.all([input.recipe.whenIdle(), input.details.whenIdle()]);
  const body = typeof input.body === 'function' ? input.body() : input.body;
  const outcome = await input.notes.publish(body);
  await Promise.all([input.recipe.whenIdle(), input.details.whenIdle(), input.notes.whenIdle()]);
  return outcome;
}
