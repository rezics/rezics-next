import type { PublishedSearchResponse } from '../discovery';

type PublishedPage = Extract<PublishedSearchResponse, { hits: unknown }>;
type PublishedHit = PublishedPage extends { hits: (infer Hit)[] } ? Hit : never;
type ContextPublished<Hit> = Hit extends unknown ? ('workContext' extends keyof Hit ? true : never) : never;

/**
 * The retained publisher must install the root-derived callable before production activation.
 * This literal is checked against that callable, so publication requires a deliberate receiving change.
 * The admission schema and presentation can be reconciled independently, without a surrogate wire DTO.
 */
export const qualifiedWorkContextInstalled: [ContextPublished<PublishedHit>] extends [never] ? false : true = false;
