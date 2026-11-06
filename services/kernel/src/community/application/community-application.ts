import type { CommunityApplication, CommunityApplicationPorts } from '../contract/index.ts';
import { deadlineElapsed, remainingBudgetMs } from '../core/index.ts';

/** Use cases over Community-owned ports. Downstream implementations are never imported here. */
export function createCommunityApplication(ports: CommunityApplicationPorts): CommunityApplication {
  return Object.freeze({
    ports,
    ambient: ports.ambient,
    elapsed: (deadline) => deadlineElapsed(ports.ambient.deadlineNow(), deadline),
    remainingBudgetMs: (deadline) => remainingBudgetMs(ports.ambient.deadlineNow(), deadline),
    effects: (operands) => ports.effects.effects(operands),
    createMembership: (dependencies) => ports.access.createMembership(dependencies),
    createParticipation: (input) => ports.access.createParticipation(input),
  });
}
