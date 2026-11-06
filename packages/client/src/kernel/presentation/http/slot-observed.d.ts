import type { PageRead } from '@rezics/composition';
export type ObservedSlotResult = {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
};
/** Admit a 200 Zone-composed search/members body at the HTTP boundary; other reads pass through. */
export declare function observeComposedSlot(read: PageRead, result: ObservedSlotResult): ObservedSlotResult | undefined;
