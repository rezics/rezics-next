// Native owners rendezvous before checking out a connection. The catalogue runner
// owns admission and stage order. Each owner supplies the operation and its typed inputs.
import { AsyncLocalStorage } from 'node:async_hooks';

export const bindingSteps = [
  'definitions',
  'registration',
  'unopened',
  'pitOwner',
  'beforePit',
  'afterPit',
  'retain',
  'adopt',
  'reference',
  'restore',
  'successor',
  'release',
] as const;
export type BindingStep = (typeof bindingSteps)[number];
type Batch<I, O> = (inputs: readonly I[], deadline: number) => Promise<readonly O[]>;
export type BindingOffer = {
  owner: object;
  cohort: string;
  key: string;
  deadline: number;
  input: unknown;
  read: Batch<unknown, unknown>;
};
const scope = new AsyncLocalStorage<(step: BindingStep, offer: BindingOffer) => Promise<unknown> | undefined>();
export const withBookBindingSteps = scope.run.bind(scope);
export function bookBindingStep<I, R extends readonly unknown[]>(
  step: BindingStep,
  owner: object,
  cohort: string,
  key: string,
  deadline: number,
  input: I,
  read: (inputs: readonly I[], deadline: number) => Promise<R>,
): Promise<R[number]> | undefined {
  // A step and owner identify a single typed native method. Distinct keys
  // may share its statement. Repeated keys take separate turns.
  return scope.getStore()?.(step, { owner, cohort, key, deadline, input, read: read as BindingOffer['read'] }) as
    | Promise<R[number]>
    | undefined;
}

/** Divide only shared native work. Integer shares sum to the original meter. */
export function bookCostShare<T extends Record<string, number>>(cost: T, index: number, width: number): T {
  return Object.fromEntries(
    Object.entries(cost).map(([key, value]) => [key, Math.floor((value + index) / width)]),
  ) as T;
}
