import { canonicalCandidate, EDITORIAL_COST, EditorialInvalid, EditorialReceiptInvalid,
  type ApplyInput, type ApplyOutcome, type CommandOutcome, type EditorialAdapter, type OwnerCommand } from './contract.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';

export const ORDERED_COMMAND_COST = { graphCalls: 64, graphBytes: 4 * 1024 * 1024,
  commandMs: 10_000, deliveryMs: 10_000, commands: EDITORIAL_COST.commands } as const;

export function checkedOwnerCommand(binding: OwnerCommand): OwnerCommand {
  if (!binding || !binding.action || binding.action.length > 128 || !binding.scope || binding.scope.length > 512
    || !/^[0-9a-f]{64}$/.test(binding.digest)) throw new EditorialInvalid('Invalid ordered owner binding');
  return { action: binding.action, scope: binding.scope, digest: binding.digest };
}
export function checkedCommandOutcome(outcome: CommandOutcome, key: string): CommandOutcome {
  if (!outcome || outcome.key !== key || !['applied','rejected','dependency_rejected'].includes(outcome.outcome)
    || outcome.outcome === 'applied' && !outcome.receipt
    || outcome.receipt !== null && (typeof outcome.receipt !== 'string' || outcome.receipt.length > 2048)) {
    throw new EditorialReceiptInvalid('Ordered command lacks its exact outcome');
  }
  canonicalCandidate(outcome.result);
  return outcome;
}

/** No later item can overtake an unknown acknowledgement. Receipt-only reads
 * resolve admitted items; authenticated retries dispatch the first undelivered
 * item and continue. Settled outcomes are immutable, including rejected items. */
export async function applyOrderedCommands(adapter: EditorialAdapter, input: ApplyInput): Promise<ApplyOutcome> {
  if (!adapter.commands || !adapter.complete || !input.commands) throw new EditorialInvalid('Ordered owner is unavailable');
  const commands = await adapter.commands(input), keys = commands.map(command => command.key);
  if (!keys.length || keys.length > EDITORIAL_COST.commands || new Set(keys).size !== keys.length
    || keys.some(key => !/^[A-Za-z0-9:_./-]{1,128}$/.test(key))) throw new EditorialInvalid('Invalid ordered command plan');
  await input.commands.plan(input,keys);
  const started = Date.now();
  const outcomes: CommandOutcome[] = [];
  for (const [position,command] of commands.entries()) {
    let stored = await input.commands.read(input,position);
    if (stored.outcome) { outcomes.push(checkedCommandOutcome(stored.outcome,command.key)); continue; }
    if (Date.now() - started >= ORDERED_COMMAND_COST.deliveryMs) return { outcome: 'pending' };
    const outcome = await fusekiReadBudget.run({ signal: AbortSignal.timeout(ORDERED_COMMAND_COST.commandMs),
      callsLeft: ORDERED_COMMAND_COST.graphCalls,bytesLeft: ORDERED_COMMAND_COST.graphBytes },async () => {
      if (!stored.binding) {
        if (input.resumeDelivery === false) return null;
        await input.commands!.bind(input,position,checkedOwnerCommand(await command.prepare(outcomes)));
        stored = await input.commands!.read(input,position);
      }
      const delivery = { input,key: command.key,binding: stored.binding!,
        ...(stored.admissionId ? { admissionId: stored.admissionId } : {}) };
      return await command.resolve(delivery,outcomes)
        ?? (input.resumeDelivery !== false ? await command.execute(delivery,outcomes) : null);
    });
    if (!outcome) return { outcome: 'pending' };
    const checked = checkedCommandOutcome(outcome,command.key);
    await input.commands.settle(input,position,checked);
    outcomes.push(checked);
  }
  const receipt = await adapter.complete(input,outcomes);
  return { outcome: 'applied',receipt: { ...receipt,commands: outcomes } };
}
