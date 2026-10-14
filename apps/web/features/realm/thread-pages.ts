import type { ThreadRead } from '../feed/thread.ts';
type Continuation = ThreadRead['continuations'][number];
const continuationKey = (value: Continuation) => `${value.kind}:${value.reply}`;

/** A route fallback can traverse the same sibling page as the inline loader. */
export function threadContinuationHref(path: string, query: string, cursor?: string): string {
  const params = new URLSearchParams(query);
  if (cursor) params.set('cursor', cursor);
  return `${path}${params.size ? `?${params}` : ''}`;
}

export function assertThreadPage(current: ThreadRead, page: ThreadRead, consumed: Continuation): void {
  if (page.realm !== current.realm || page.work.id !== current.work.id || page.rootRevision !== current.rootRevision
    || page.sort !== current.sort || page.focus !== consumed.reply) throw new Error('Thread continuation changed');
}

/** Keep loaded branches in Main's sibling order and replace only the consumed control. */
export function mergeThreadPage(current: ThreadRead, page: ThreadRead, consumed: Continuation): ThreadRead {
  assertThreadPage(current, page, consumed);
  const items = new Map(current.items.map((item) => [item.reply, item]));
  for (const item of page.items) items.set(item.reply, item);
  const controls = new Map((current.continuations ?? []).map((value) => [continuationKey(value), value]));
  controls.delete(continuationKey(consumed));
  for (const value of page.continuations ?? []) {
    if (value.kind !== 'ancestors') controls.set(continuationKey(value), value);
  }
  const continuations = [...controls.values()];
  return { ...current, items: [...items.values()], continuations, complete: continuations.length === 0 };
}

