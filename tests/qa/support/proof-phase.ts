import { AsyncLocalStorage } from 'node:async_hooks';

const proofs = new AsyncLocalStorage<{ active: boolean }>();

export function personaProofActive(): boolean {
  return proofs.getStore()?.active === true;
}

/** Only outcomeTest and its recorder own proof entry and completion. */
export async function duringPersonaProof(
  fn: () => unknown,
  onFinish?: (leave: () => void) => void,
): Promise<void> {
  const phase = { active: true };
  const leave = () => { phase.active = false; };
  onFinish?.(leave);
  await proofs.run(phase, async () => {
    try { await fn(); }
    finally { leave(); }
  });
}
