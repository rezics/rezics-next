import type { AccessApplicationPorts, AccessDecision, DecideAuthorizationInput } from '../contract/index.ts';
import { authorizationAllows, decideResourceAuthorization } from '../core/index.ts';

export function createResourceAuthorizationApplication(ports: Pick<AccessApplicationPorts, 'resourceAuthorization'>) {
  return {
    decide(facts: DecideAuthorizationInput): AccessDecision {
      return decideResourceAuthorization(facts);
    },
    async authorize(facts: DecideAuthorizationInput): Promise<AccessDecision> {
      const decided = decideResourceAuthorization(facts);
      if (!authorizationAllows(decided)) return decided;
      const port = ports.resourceAuthorization;
      if (!port) return decided;
      const prepared = await port.prepare(facts.actor, facts.action, facts.resource, facts.deadline);
      if (!prepared) return { outcome: 'deny', explicit: decided.explicit };
      if (prepared.expires < facts.deadline && prepared.expires <= 0) {
        return { outcome: 'unavailable', explicit: true };
      }
      return decided;
    },
  };
}
