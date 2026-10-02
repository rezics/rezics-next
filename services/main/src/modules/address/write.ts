import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readMergedIdentity } from '../identity-merge/resolution.ts';
import { NameInvalid, NameDenied, NameUnavailable, scopeKind, type NameWrite } from './registry.ts';

export async function writeName(work: MainWorkDependencies, request: Request, input: NameWrite) {
  const registry = work.environment.addresses;
  if (!registry) throw new NameUnavailable('Name registry is unavailable');
  const kind = scopeKind(input.scope);
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
    return registry.withController(principal, input.actingSubject, input.holder, null, (client) =>
      registry.write(client, principal, input, input.holder),
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
      (client) => registry.write(client, principal, input, input.actingSubject),
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
    return registry.withController(
      principal,
      input.actingSubject,
      input.holder,
      row.realm.value,
      (client) => registry.write(client, principal, input, controller),
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
    (client) => registry.write(client, principal, input, controller),
  );
}
