import type { KernelClient } from '@rezics/client';

type PublishedResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;
type PublishedPage = Extract<PublishedResponse, { hits: unknown }>;
type PublishedHit = PublishedPage extends { hits: (infer Hit)[] } ? Hit : never;
type PublishedContext = PublishedHit extends { workContext?: infer Context } ? Context : never;

/**
 * The retained publisher must install the root-derived callable before production activation.
 * This literal is checked against that callable, so publication requires a deliberate receiving change.
 * The admission schema and presentation can be reconciled independently, without a surrogate wire DTO.
 */
export const qualifiedWorkContextInstalled: [PublishedContext] extends [never] ? false : true = false;
