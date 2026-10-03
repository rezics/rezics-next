import type { VerifiedPrincipal } from '../access/admission.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import type { DiscoverySignals } from './audience.ts';
import { ControlDenied } from '../access/topology-control.ts';
import { AdmissionDenied } from '../access/admission.ts';

export interface DiscoveryReader {
  principal: VerifiedPrincipal;
  actor: string;
  signals: DiscoverySignals;
}
export async function discoveryReader(
  session: WorkReadSession,
  actor?: string,
  personalize = true,
  request = session.request,
): Promise<DiscoveryReader | null> {
  if (actor && !request.headers.has('authorization'))
    throw new AdmissionDenied('Authentication is required for reader signals');
  if (!actor) return null;
  if (!session.deps.discoveryAudience)
    throw new WorkReadUnavailable('Discovery reader owner is unavailable');
  const principal = await session.deps.account.verify(request, ['work:read']);
  const signals = await session.deps.discoveryAudience.signals(principal, actor).catch((error) => {
    if (error instanceof ControlDenied)
      throw new AdmissionDenied('Discovery reader is not controlled');
    throw error;
  });
  return { principal, actor, signals: { ...signals, enabled: signals.enabled && personalize } };
}
export async function fenceDiscoveryReader(
  session: WorkReadSession,
  reader: DiscoveryReader | null,
  personalize = true,
) {
  if (!reader) return;
  const current = await session.deps.discoveryAudience!.signals(reader.principal, reader.actor);
  if (
    JSON.stringify({ ...current, enabled: current.enabled && personalize }) !==
    JSON.stringify(reader.signals)
  ) {
    throw new WorkReadMoved('Discovery preferences or follows changed');
  }
}
