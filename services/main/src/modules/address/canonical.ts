import { uuidToSid } from '@rezics/model/address/sid';
import type { CanonicalAddress } from '@rezics/model/address';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { NameUnavailable, NATIVE_ADDRESS_HOLDER } from './registry.ts';

export function identityCanonical(
  type: string,
  holder: string,
  slugSource: string,
): CanonicalAddress {
  if (!NATIVE_ADDRESS_HOLDER.test(holder)) throw new NameUnavailable('Address holder is invalid');
  const prefix =
    type === 'agent'
      ? '/a/'
      : type === 'space' || type === 'realm'
        ? '/r/'
        : type === 'zone'
          ? '/z/'
          : type === 'work'
            ? '/w/'
            : type === 'concept'
              ? '/concepts/'
              : '/e/';
  return { prefix, key: uuidToSid(holder.slice(-36)), slugSource };
}

export interface AddressableSummary {
  reference: string;
  type: string;
  disclosure?: string;
  name: { value: string; preferenceRevision?: string };
}

/** One bounded capability-to-Space query and one indexed current-name batch.
 * Call only after the owning summary has admitted each returned resource. */
export async function canonicalAddresses(
  env: WorkActivationEnvironment,
  summaries: readonly AddressableSummary[],
) {
  const holders = new Map(summaries.map((summary) => [summary.reference, summary.reference]));
  const spaceTypes = summaries.filter((summary) =>
    ['space', 'realm', 'zone'].includes(summary.type),
  );
  const siteSpaces = new Set<string>();
  if (spaceTypes.length) {
    const rows =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT ?resource ?space ?site WHERE {
      VALUES ?resource { ${spaceTypes.map((summary) => iri(summary.reference)).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        { ?resource a rv:Space . BIND(?resource AS ?space) }
        UNION { ?resource a rv:Realm ; rv:space ?space . ?space rv:realmCapability ?resource }
        UNION { ?resource a rv:Zone ; rv:space ?space }
        BIND(EXISTS { ?zone a rv:Zone ; rv:space ?space ; rv:zoneState rv:Active ; rv:disclosure rv:Public } AS ?site)
      } } LIMIT ${summaries.length + 1}`,
          64 * 1024,
        )
      ).results?.bindings ?? [];
    if (rows.length !== spaceTypes.length)
      throw new NameUnavailable('Space address identity is ambiguous');
    for (const row of rows) {
      if (!row.resource || !row.space)
        throw new NameUnavailable('Space address identity is incomplete');
      holders.set(row.resource.value, row.space.value);
      if (row.site?.value === 'true') siteSpaces.add(row.space.value);
    }
  }
  const names = (await env.addresses?.currents([...new Set(holders.values())])) ?? new Map();
  const policies = env.addresses
    ? await Promise.all(
        ['agent', 'space', 'work'].map(
          async (scope) => [scope, (await env.addresses!.policy(scope)).canonical] as const,
        ),
      )
    : [];
  const policy = new Map(policies);
  const result = new Map<string, CanonicalAddress>();
  for (const summary of summaries) {
    const holder = holders.get(summary.reference)!;
    const scope =
      summary.type === 'agent'
        ? 'agent'
        : ['space', 'realm', 'zone'].includes(summary.type)
          ? 'space'
          : summary.type === 'work'
            ? 'work'
            : null;
    const name = scope ? names.get(`${scope}\0${holder}`) : null;
    const named = name && policy.get(scope!) === 'name';
    const address = identityCanonical(
      summary.type,
      holder,
      summary.disclosure === 'restricted' || summary.name.preferenceRevision
        ? ''
        : summary.name.value,
    );
    if (scope === 'space') address.prefix = siteSpaces.has(holder) ? '/z/' : '/r/';
    if (named) {
      address.key = name.key;
      if (scope === 'agent') address.prefix = '/@';
    }
    result.set(summary.reference, address);
  }
  return result;
}
