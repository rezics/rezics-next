import { types } from 'node:util';
import type { CommandResult } from './command.ts';
import type { CommandDispatchPrice } from './dispatch-lifetime.ts';

const price = (
  nativeRows: number,
  nativePoints: number,
  statements: number,
  bytes: number,
  emptySeeks = 0,
): CommandDispatchPrice =>
  Object.freeze({
    work: Object.freeze({
      candidateKeys: 0,
      nativeRows,
      identityMetadataRows: 0,
      nativePoints,
      witnessKeys: 0,
      statements,
      bytes,
      emptySeeks,
    }),
    engineRequests: 0,
  });
const sum = (...parts: readonly CommandDispatchPrice[]): CommandDispatchPrice => {
  const work = { ...price(0, 0, 0, 0).work };
  for (const part of parts)
    for (const axis of Object.keys(work) as (keyof typeof work)[]) work[axis] += part.work[axis];
  return Object.freeze({ work: Object.freeze(work), engineRequests: 0 });
};

export const SOURCE_FENCE_EVENT_TYPE = 'com.rezics.semantic.erasure.progress.v1';
// Full existing catalogue domain, including nil and every UUID version.
const accountPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function assertSourceFenceAccount(accountId: string): void {
  if (typeof accountId !== 'string' || accountId.length !== 36 || !accountPattern.test(accountId))
    throw new TypeError('Unsupported Source fence account ID');
}

/** Fixed compact JSON payload lengths, derived in README; never caller ceilings. */
export const SOURCE_FENCE_BINDING_BYTES = 281;
export const SOURCE_FENCE_COMMAND_DISPATCH_CONTROLS = Object.freeze({
  accountSelection: price(0, 0, 0, 36),
  checkout: price(0, 0, 0, 0),
  begin: price(0, 0, 1, 0),
  lockTimeout: price(0, 0, 1, 0),
  statementTimeout: price(0, 0, 1, 12),
  time: price(1, 0, 1, 40),
  eventShape: price(0, 0, 0, 111), // type (39), subject (36), data.accountId (36)
  eventSerialization: price(0, 0, 0, 52), // actual catalogue JSON round trip
  eventValidation: price(0, 0, 0, 52), // existing catalogue validation payload
  finalStatementTimeout: price(0, 0, 1, 12),
  noEffectFence: price(1, 1, 1, 105, 1),
  eventFence: price(2, 2, 1, 336, 1), // 281 bindings + 55 returned projection
  finalize: price(0, 0, 0, 0),
  commit: price(0, 0, 1, 0),
  cleanupRollback: price(0, 0, 1, 0),
});
const c = SOURCE_FENCE_COMMAND_DISPATCH_CONTROLS;
const common = sum(
  c.accountSelection,
  c.checkout,
  c.begin,
  c.lockTimeout,
  c.statementTimeout,
  c.time,
  c.finalStatementTimeout,
  c.finalize,
  c.commit,
);
const branches = Object.freeze({
  noEffect: sum(common, c.noEffectFence),
  event: sum(common, c.eventShape, c.eventSerialization, c.eventValidation, c.eventFence),
});
// Coordinate-wise maximum of ALTERNATIVES. Never charge both fences in one attempt.
const envelope = { ...common.work };
for (const axis of Object.keys(envelope) as (keyof typeof envelope)[])
  envelope[axis] = Math.max(branches.noEffect.work[axis], branches.event.work[axis]);
const effect: CommandDispatchPrice = Object.freeze({ work: Object.freeze(envelope), engineRequests: 0 });
export const SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE = Object.freeze({
  profile: 'single-source-fence' as const,
  components: SOURCE_FENCE_COMMAND_DISPATCH_CONTROLS,
  branches,
  effect,
  cleanup: c.cleanupRollback,
  total: sum(effect, c.cleanupRollback),
  maxima: Object.freeze({ attempts: 1, checkouts: 1, fences: 1, events: 1, cleanupRollbacks: 1 }),
});
export type SourceFenceCommandDispatchAllowance = typeof SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE;

/** Trusted server closures over the SAME genuine original, Pool, deadline, selected account
 * and live owner callback. reserve atomically holds total (effect + disjoint cleanup) before
 * checkout. This distinct parameter type cannot be supplied to the old no-effect adapter.
 * Core supplies no private owner funding; fixtures using this port prove no production grant.
 */
export type SourceFenceCommandDispatchOwner = Readonly<{
  original: object;
  validate(): void;
  reserve(allowance: SourceFenceCommandDispatchAllowance): void | Promise<void>;
}>;

function reject(): never {
  throw new TypeError('Unsupported dispatch lifetime Source fence result');
}
function fields(input: unknown, names: readonly string[]): Record<string, PropertyDescriptor> {
  if (!input || typeof input !== 'object' || types.isProxy(input)) reject();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) reject();
  if ('toJSON' in input) reject();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) reject();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (names.some((key) => !('value' in descriptors[key]!))) reject();
  return descriptors;
}

/** Inspect descriptors before any property access, serializer or native fence. Snapshot the
 * selected strings so later foreign mutation cannot change the admitted binding. value is
 * carried by identity: Core does not traverse, serialize or price a foreign body result.
 */
export function sourceFenceResponse<T>(
  response: CommandResult<T>,
  authenticNoEffect: boolean,
  accountId: string,
): CommandResult<T> {
  if (authenticNoEffect) return response;
  const result = fields(response, ['value', 'events']);
  const input: unknown = result.events!.value;
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    'toJSON' in input
  )
    reject();
  if (Object.getOwnPropertyDescriptor(input, 'length')?.value !== 1 || Reflect.ownKeys(input).length !== 2) reject();
  const first = Object.getOwnPropertyDescriptor(input, '0');
  if (!first || !('value' in first)) reject();
  const event = fields(first.value, ['type', 'subject', 'data']);
  const data = fields(event.data!.value, ['accountId']);
  if (
    event.type!.value !== SOURCE_FENCE_EVENT_TYPE ||
    event.subject!.value !== accountId ||
    data.accountId!.value !== accountId
  )
    reject();
  // Null prototypes also prevent inherited custom serializers during native binding.
  const snapshot = Object.assign(Object.create(null), { accountId });
  const selected = Object.assign(Object.create(null), {
    type: SOURCE_FENCE_EVENT_TYPE,
    subject: accountId,
    data: Object.freeze(snapshot),
  });
  return Object.freeze({ value: result.value!.value as T, events: Object.freeze([Object.freeze(selected)]) });
}

/** Only partition and the exact absolute deadline; inspect before normal option spreading. */
export function assertSourceFenceOptions(options: object): void {
  fields(options, ['partition', 'deadline']);
}
