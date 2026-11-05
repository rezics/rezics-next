import type { WorkContext } from '../work/registry.ts';

/** An uncomposed consumer has no receiving service. The ordinary Commerce WorkModule
 * installs the native hold/gate path; no caller allow assertion or callback is accepted. */
export type CreatorSaleReceiving = Readonly<
  { state: 'pending'; gap: 'commerce-creator-sale-live-copy-receiving-unavailable' } | { state: 'available' }
>;
const configured = new WeakSet<WorkContext>();
export function enableCreatorSaleReceiving(context: WorkContext): void {
  configured.add(context);
}
export function readCreatorSaleReceiving(context?: WorkContext): CreatorSaleReceiving {
  return context && configured.has(context)
    ? { state: 'available' }
    : { state: 'pending', gap: 'commerce-creator-sale-live-copy-receiving-unavailable' };
}
