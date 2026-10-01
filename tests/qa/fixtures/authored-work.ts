import { randomUUID } from 'node:crypto';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

/** Owner-authored API fixtures need a native Person as well as Access representation. */
export async function provisionFixtureAuthor(environment: WorkActivationEnvironment, actor: string) {
  const intent = { kind: 'person' as const, displayName: 'QA fixture author' };
  await createAgentGraph(environment, { id: randomUUID(), agent: actor,
    ...intent, digest: agentProvisionDigest(intent) });
}
