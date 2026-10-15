import { BackpressureSaturated } from '../../src/operations/admission-budget.ts';

// A durable lane refuses before an owner effect. Retrying that refusal leaves
// command keys and bodies intact, while letting the shared relay catch up.
export async function withBrokerAdmission<T>(command: () => Promise<T>,
  wait: (milliseconds: number) => Promise<unknown> = Bun.sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await command(); }
    catch (error) {
      if (!(error instanceof BackpressureSaturated) || error.lane !== 'broker' || attempt >= 3) throw error;
      await wait(error.retryAfterSeconds * 1000);
    }
  }
}
