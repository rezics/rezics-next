import { planReads, platformRegistry } from '@rezics/composition';
import type { Pool } from 'pg';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import { activeProfile } from '../presentation/profiles.ts';
import { readPage } from '../presentation/reads.ts';
import type { Access, Actor } from '../request/access.ts';
import { validateHitOptions } from '../search/hits.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ZonePageRequest, ZonePageResponse } from './contract.ts';
import { createZoneReads } from './resource-reads.ts';

/** Independent configured-page runtime. Source-dependent execution requires the real owner ports. */
export async function readStaticZonePage(
  dependencies: { pool: Pool; access: Access; tokens: KeyRing; clock: () => Date },
  input: {
    actor: Actor;
    id: string;
    body: ZonePageRequest;
    request: Request;
    dispatch: (request: Request) => Promise<Response>;
    deadline: number;
  },
) {
  const route = 'route' in input.body.target ? input.body.target.route : null;
  if (route?.split('/')[0] === 'subjects')
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/target/route', code: 'invalid_format' }] });
  const { languages } = validateHitOptions({ languages: input.body.languages });
  requireAccessDeadline(input.deadline);
  // Authority, selected document, safe shell and observation share the Zone's RR snapshot at native T.
  const selected = await createZoneReads(dependencies).page(input.actor, input.id, route, input.deadline);
  // No owner connection remains checked out while reading the common profile on Global.
  const active = await activeProfile(dependencies.pool);
  requireAccessDeadline(input.deadline);
  if (!active) throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
  const plan = planReads(platformRegistry, selected.document, {});
  if (Object.keys(plan.reads).length > 0)
    throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
  const page = await readPage({
    dispatch: input.dispatch,
    incoming: input.request,
    reads: plan.reads,
    session: {
      ring: dependencies.tokens,
      scope: input.actor.kind === 'account' ? `account:${input.actor.accountId}` : 'anonymous',
    },
    ...(languages === undefined ? {} : { languages }),
  });
  requireAccessDeadline(input.deadline);
  const value: ZonePageResponse = {
    profile: active.digest,
    template: { scope: 'route', key: route },
    document: selected.document,
    reads: page.results,
    zone: selected.zone,
  };
  return { value, component: selected.component };
}
