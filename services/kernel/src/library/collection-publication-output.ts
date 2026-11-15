import { ProblemError } from '../http/problem-error.ts';
import { createPublicIdentityOutputCapture } from '../semantic/identity-public-output-capture.ts';
import type { WorkContext } from '../work/registry.ts';
import { readMembershipWorkConfig } from './access-port.ts';
import { requireLibraryDomain } from './domain-binding.ts';

export function collectionPublicationOutputProducer(
  context: Pick<WorkContext, 'pool' | 'clock' | 'env' | 'getAuthorization'>,
) {
  const native = requireLibraryDomain().nativePublicOutput;
  if (!native) throw new ProblemError('dependency_unavailable');
  return createPublicIdentityOutputCapture(
    {
      pool: context.pool,
      access: context.getAuthorization().access,
      routeKey: readMembershipWorkConfig(context.env).routeKey,
      clock: context.clock,
    },
    native,
  );
}
