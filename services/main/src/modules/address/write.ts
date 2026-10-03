import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readMergedIdentity } from '../identity-merge/resolution.ts';
import { NameInvalid, NameDenied, NameUnavailable, scopeKind, type NameWrite } from './registry.ts';
import type { PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';

export async function writeName(work: MainWorkDependencies, request: Request, input: NameWrite) {
  return withNameAuthority(work, request, input, async (client, principal, controller) =>
    work.environment.addresses!.write(
      client,
      principal,
      input,
      controller,
      null,
      await platformNameAuthority(work.environment, input.scope, input.holder),
    ),
  );
}

/** Official Zones own their site's Space handle. Authentication and owner
 * authority remain mandatory; this proof only opens the reservation gate. */
export async function platformNameAuthority(
  env: WorkActivationEnvironment,
  scope: string,
  holder: string,
): Promise<boolean> {
  if (scope !== 'space') return false;
  return (
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(holder)} a rv:Space .
      { ${iri(holder)} rv:official true }
      UNION { ?zone a rv:Zone ; rv:official true ; rv:space ${iri(holder)} }
    } }`,
        1024,
      )
    ).boolean === true
  );
}

/** The same owner proofs admit a writer's current revision, including private
 * holders. Public address resolution never grants this editing authority. */
export async function withNameAuthority<T>(
  work: MainWorkDependencies,
  request: Request,
  input: Pick<NameWrite, 'scope' | 'holder' | 'actingSubject' | 'operation' | 'successor'>,
  operation: (client: PoolClient, principal: VerifiedPrincipal, controller: string) => Promise<T>,
): Promise<T> {
  const registry = work.environment.addresses;
  if (!registry) throw new NameUnavailable('Name registry is unavailable');
  const kind = scopeKind(input.scope);
  if (!work.access.withOwnerAuthority) throw new NameUnavailable('Name authority is unavailable');
  await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
  const principal = await work.account.verify(request, [
    kind === 'agent'
      ? 'agent:create'
      : kind === 'space'
        ? 'space:create'
        : kind === 'zone'
          ? 'zone:edit'
          : input.operation === 'claim'
            ? 'address:claim'
            : 'address:manage',
  ]);
  if (input.operation === 'merge') {
    const resolution = await readMergedIdentity(work.environment, input.holder, async () => true);
    if (!resolution || resolution.survivor !== input.successor)
      throw new NameInvalid('Name merges require an equivalent successor');
  }
  if (kind === 'agent')
    return work.access.withOwnerAuthority(
      {
        principal,
        actingSubject: input.holder,
        scope: `agent:control:${input.holder}`,
        action: 'agent.control',
      },
      (client) => operation(client, principal, input.holder),
    );
  if (kind === 'work') {
    const exists = await work.environment.fuseki.query(
      `PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.holder)} a schema:CreativeWork ; <${RV}mainVersion> ?main } }`,
      1024,
    );
    if (exists.boolean !== true) throw new NameInvalid('Work identity is unavailable');
    if (!work.access.withOwnerAuthority) throw new NameUnavailable('Name authority is unavailable');
    const action =
      input.operation === 'claim'
        ? 'address.claim'
        : input.operation === 'rename'
          ? 'address.rename'
          : 'address.dispose';
    const family =
      input.operation === 'claim' ? 'claim' : input.operation === 'rename' ? 'rename' : 'dispose';
    return work.access.withOwnerAuthority(
      {
        principal,
        actingSubject: input.actingSubject,
        scope: `address:${family}:${input.holder}`,
        action,
      },
      (client) => operation(client, principal, input.actingSubject),
    );
  }
  const space = kind === 'space' ? input.holder : input.scope.slice(5);
  const rows =
    (
      await work.environment.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?owner ?realm ?zone WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(space)} a rv:Space .
      OPTIONAL { ${iri(space)} rv:owner ?owner }
      OPTIONAL { ${iri(space)} rv:realmCapability ?realm }
      OPTIONAL { ?zone a rv:Zone ; rv:space ${iri(space)} ; rv:zoneState rv:Active }
    } } LIMIT 2`,
        8192,
      )
    ).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0])
    throw new NameInvalid('Space identity is unavailable or ambiguous');
  const row = rows[0];
  const controller = row.owner?.value ?? input.actingSubject;
  if (kind === 'space' && row.realm)
    return work.access.withOwnerAuthority(
      {
        principal,
        actingSubject: input.actingSubject,
        scope: `governance:realm:${row.realm.value}`,
        action: 'realm.settings.manage',
      },
      (client) => operation(client, principal, controller),
    );
  if (!row.zone || !work.access.withOwnerAuthority)
    throw new NameDenied('Zone editor authority is unavailable');
  return work.access.withOwnerAuthority(
    {
      principal,
      actingSubject: input.actingSubject,
      scope: `zone:edit:${row.zone.value}`,
      action: 'zone.edit',
    },
    (client) => operation(client, principal, controller),
  );
}

export async function withNameAvailabilityAuthority<T>(
  work: MainWorkDependencies,
  request: Request,
  scope: string,
  actingSubject: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (scopeKind(scope) !== 'zone') return operation();
  if (!actingSubject || !work.access.withOwnerAuthority)
    throw new NameDenied('Zone editor authority is required');
  const principal = await work.account.verify(request, ['zone:edit']);
  const rows =
    (
      await work.environment.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?zone WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:space ${iri(scope.slice(5))} ; rv:zoneState rv:Active }
    } LIMIT 2`,
        2048,
      )
    ).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.zone)
    throw new NameDenied('Zone editor authority is unavailable');
  return work.access.withOwnerAuthority(
    { principal, actingSubject, scope: `zone:edit:${rows[0].zone.value}`, action: 'zone.edit' },
    operation,
  );
}
