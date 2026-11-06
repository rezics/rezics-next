import type { PageRead } from '@rezics/composition';
import { admitObservedMembersPage, admitObservedSearchPage } from '../slot-bodies.ts';

export type ObservedSlotResult = { status: number; body: unknown; headers?: Record<string, string> };

/** Admit a 200 Zone-composed search/members body at the HTTP boundary; other reads pass through. */
export function observeComposedSlot(read: PageRead, result: ObservedSlotResult): ObservedSlotResult | undefined {
  if (result.status !== 200) return result;
  if (read.kind === 'search') {
    const admitted = admitObservedSearchPage(read, result.body);
    return admitted ? { ...result, body: admitted } : undefined;
  }
  if (read.kind === 'members') {
    const admitted = admitObservedMembersPage(read, result.body);
    return admitted ? { ...result, body: admitted } : undefined;
  }
  return result;
}
