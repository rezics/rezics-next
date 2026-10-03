import { uuidToSid } from '@rezics/model/address/sid';
import type { CanonicalAddress } from '@rezics/model/address';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { AliasUnavailable, NATIVE_ADDRESS_HOLDER } from './registry.ts';
import { ALIAS_POLICIES } from './policy.ts';

export function identityCanonical(
  type: string,
  holder: string,
  suffixSource: string,
): CanonicalAddress {
  if (!NATIVE_ADDRESS_HOLDER.test(holder)) throw new AliasUnavailable('Address holder is invalid');
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
  return { prefix, key: uuidToSid(holder.slice(-36)), suffixSource };
}

export interface AddressableSummary {
  reference: string;
  type: string;
  disclosure?: string;
  name: { value: string; preferenceRevision?: string };
}

/** One bounded capability-to-Space query and one indexed current-alias batch.
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
        await env.fuseki
          .query(
            `PREFIX rv: <${RV}> SELECT ?resource ?space ?site WHERE {
      VALUES ?resource { ${spaceTypes.map((summary) => iri(summary.reference)).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        { ?resource a rv:Space . BIND(?resource AS ?space) }
        UNION { ?resource a rv:Realm ; rv:space ?space . ?space rv:realmCapability ?resource }
        UNION { ?resource a rv:Zone ; rv:space ?space }
        BIND(EXISTS { ?zone a rv:Zone ; rv:space ?space ; rv:zoneState rv:Active ; rv:disclosure rv:Public .
          FILTER NOT EXISTS { ?zone rv:protectionHead ?protection } } AS ?site)
      } } LIMIT ${summaries.length + 1}`,
            64 * 1024,
          )
          .catch(() => ({ results: { bindings: [] } }))
      ).results?.bindings ?? [];
    const byResource = new Map<string, string[]>();
    for (const row of rows)
      if (row.resource && row.space) {
        const found = byResource.get(row.resource.value) ?? [];
        found.push(row.space.value);
        byResource.set(row.resource.value, found);
      }
    for (const row of rows) {
      if (!row.resource || !row.space || !NATIVE_ADDRESS_HOLDER.test(row.space.value)
        || byResource.get(row.resource.value)?.length !== 1) continue;
      holders.set(row.resource.value, row.space.value);
      if (row.site?.value === 'true'
        || spaceTypes.some(summary => summary.reference === row.resource!.value && summary.type === 'zone')) {
        siteSpaces.add(row.space.value);
      }
    }
  }
  const aliases =
    (await env.addresses?.currents([...new Set(holders.values())]).catch(() => new Map())) ??
    new Map();
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
    const alias = scope ? aliases.get(`${scope}\0${holder}`) : null;
    const aliased = alias && ALIAS_POLICIES[scope!].canonical === 'alias';
    const address = identityCanonical(
      summary.type,
      holder,
      summary.disclosure === 'restricted' || summary.name.preferenceRevision
        ? ''
        : summary.name.value,
    );
    if (scope === 'space') address.prefix = siteSpaces.has(holder) ? '/z/' : '/r/';
    if (aliased) {
      address.key = alias.key;
      if (scope === 'agent') address.prefix = '/@';
    }
    result.set(summary.reference, address);
  }
  return result;
}
