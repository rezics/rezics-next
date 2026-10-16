import { isValidElement } from 'react';

/** Wait for the production frame's streamed slot promises without replacing or invoking its components. */
export async function finishMangaSlots(node: unknown): Promise<void> {
  if (node && typeof node === 'object' && 'then' in node && typeof node.then === 'function') {
    await finishMangaSlots(await (node as PromiseLike<unknown>));
  } else if (Array.isArray(node)) {
    await Promise.all(node.map(finishMangaSlots));
  } else if (isValidElement<Record<string, unknown>>(node)) {
    await Promise.all(Object.values(node.props).map(finishMangaSlots));
  }
}
