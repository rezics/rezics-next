import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { readerLanguages } from '../display-language/select.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { resolveZoneRoute, ZoneRouteMissing } from '../zone/route.ts';
import { uuidToSid, identityKeyUuid } from '@rezics/model/address/sid';
import { fusekiReadBudget, FusekiReadBudgetExceeded } from '../../infrastructure/fuseki.ts';
import {
  NAME_COST,
  NameInvalid,
  NameUnavailable,
  scopeKind,
  type NameScope,
  type NameRow,
} from './registry.ts';

export type AddressScope = NameScope | 'resource' | 'concept';
export interface AddressLookup {
  scope: AddressScope;
  key: string;
  route?: string;
}

/** One resolver for all scopes. SQL inventory lookup never establishes reading:
 * only the anonymous summary/disclosure owner admits a returned holder. */
export async function resolveAddresses(
  work: MainWorkDependencies,
  request: Request,
  inputs: readonly AddressLookup[],
) {
  if (!work.environment.addresses) throw new NameUnavailable('Name registry is unavailable');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(NAME_COST.deadlineMs)]);
  try {
    return await fusekiReadBudget.run({ signal, callsLeft: 4096, bytesLeft: 8 * 1024 * 1024 }, () =>
      work.environment.addresses!.withRead(() => resolveAddressBatch(work, request, inputs)),
    );
  } catch (error) {
    if (signal.aborted || error instanceof FusekiReadBudgetExceeded)
      throw new NameUnavailable('Address read exceeded its budget');
    throw error;
  }
}

async function resolveAddressBatch(
  work: MainWorkDependencies,
  request: Request,
  inputs: readonly AddressLookup[],
) {
  if (!inputs.length || inputs.length > NAME_COST.batch)
    throw new NameInvalid('Address batch exceeds its bound');
  const env = work.environment,
    registry = env.addresses;
  if (!registry) throw new NameUnavailable('Name registry is unavailable');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const selected: Array<{ input: AddressLookup; holder: string | null; name: NameRow | null }> = [];
  const deadline = Date.now() + NAME_COST.deadlineMs;
  for (const input of inputs) {
    if (Date.now() > deadline) throw new NameUnavailable('Address read deadline exceeded');
    if (input.scope === 'resource' || input.scope === 'concept') {
      const uuid = identityKeyUuid(input.key);
      selected.push({ input, holder: uuid ? `https://rezics.com/id/${uuid}` : null, name: null });
    } else selected.push({ input, ...(await registry.identify(input.scope, input.key)) });
  }
  const zoneSpaces = [
    ...new Set(
      inputs
        .filter((input) => input.scope.startsWith('zone:'))
        .map((input) => input.scope.slice(5)),
    ),
  ];
  if (zoneSpaces.length) {
    const sites =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT DISTINCT ?space WHERE {
      VALUES ?space { ${zoneSpaces.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?space a rv:Space ; rv:disclosure rv:Public .
        ?zone a rv:Zone ; rv:space ?space ; rv:zoneState rv:Active ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?space rv:protectionHead ?p }
        FILTER NOT EXISTS { ?zone rv:protectionHead ?p }
      } } LIMIT ${zoneSpaces.length}`,
          8192,
        )
      ).results?.bindings ?? [];
    const readable = new Set(sites.map((row) => row.space?.value));
    // Scope membership is confidential even when its target is independently public,
    // and retirement must not turn a private site into a public name inventory.
    for (const item of selected)
      if (item.input.scope.startsWith('zone:') && !readable.has(item.input.scope.slice(5)))
        item.holder = null;
  }
  const aliases = selected.filter(
    (item) => (item.input.scope === 'space' || item.input.scope === 'resource') && item.holder,
  );
  const capabilities = new Map<string, { realm?: string; zone?: string }>();
  if (aliases.length) {
    const rows =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT DISTINCT ?resource ?space ?realm ?zone WHERE {
      VALUES ?resource { ${[...new Set(aliases.map((item) => item.holder!))].map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        { ?resource a rv:Space . BIND(?resource AS ?space) }
        UNION { ?resource a rv:Realm ; rv:realmState rv:Active ; rv:space ?space . ?space rv:realmCapability ?resource }
        UNION { ?resource a rv:Zone ; rv:zoneState rv:Active ; rv:disclosure rv:Public ; rv:space ?space }
        ?space rv:disclosure rv:Public .
        OPTIONAL { ?space rv:realmCapability ?realm . ?realm rv:realmState rv:Active }
        OPTIONAL { ?space rv:zoneCapability ?zone . ?zone rv:zoneState rv:Active ; rv:disclosure rv:Public }
      } } LIMIT ${NAME_COST.batch + 1}`,
          64 * 1024,
        )
      ).results?.bindings ?? [];
    const identities = new Map(rows.map((row) => [row.resource?.value, row.space?.value]));
    if (identities.size !== rows.length)
      throw new NameUnavailable('Space capability identity is ambiguous');
    for (const row of rows)
      if (row.space)
        capabilities.set(row.space.value, {
          ...(row.realm ? { realm: row.realm.value } : {}),
          ...(row.zone ? { zone: row.zone.value } : {}),
        });
    for (const item of aliases)
      item.holder =
        identities.get(item.holder!) ?? (item.input.scope === 'space' ? null : item.holder);
  }
  const resources = [
    ...new Set(
      selected.flatMap((item) =>
        item.holder ? [item.holder, ...(item.name?.successor ? [item.name.successor] : [])] : [],
      ),
    ),
  ];
  const summaries = new Map();
  for (let at = 0; at < resources.length; at += NAME_COST.batch) {
    const batch = await readResourceSummaries(
      env,
      work.media?.store,
      {
        ...(work.mediaAccess
          ? {
              canReadSemantics: (targets: readonly string[]) =>
                work.mediaAccess!.canReadSemantics(null, null, targets, env.fuseki),
            }
          : {}),
      },
      {
        resources: resources.slice(at, at + NAME_COST.batch),
        context: DEFAULT_MEDIA_CONTEXT,
        language: null,
        languages: readerLanguages(
          request.headers.get('x-rezics-display-languages'),
          request.headers.get('accept-language'),
        ),
        includeCollections: true,
      },
    );
    for (const summary of batch.summaries) summaries.set(summary.reference, summary);
  }
  const named = selected.filter((item) => item.name);
  const wantedHeads = named.flatMap((item) => {
    const summary = summaries.get(item.holder);
    return summary?.status === 'available'
      ? [
          {
            scope: item.input.scope as NameScope,
            holder: summary.resolution?.survivor ?? item.holder!,
          },
        ]
      : [];
  });
  const heads = wantedHeads.length
    ? await registry.heads(
        wantedHeads.map((item) => item.scope),
        wantedHeads.map((item) => item.holder),
      )
    : new Map();
  return Promise.all(
    selected.map(async ({ input, holder, name }) => {
      const summary = holder ? summaries.get(holder) : null;
      const kind =
        input.scope === 'resource' || input.scope === 'concept'
          ? input.scope
          : scopeKind(input.scope);
      if (
        !summary ||
        summary.status !== 'available' ||
        (kind !== 'zone' && kind !== 'resource' && summary.type !== kind)
      ) {
        return { scope: input.scope, key: input.key, status: 'unavailable' as const };
      }
      if (name?.successor) {
        const next = summaries.get(name.successor);
        if (!next || next.status !== 'available')
          return { scope: input.scope, key: input.key, status: 'unavailable' as const };
        if (
          !summary.resolution ||
          summary.resolution.survivor !== (next.resolution?.survivor ?? name.successor)
        ) {
          throw new NameUnavailable('Name successor is no longer equivalent');
        }
      }
      let canonical = summary.address;
      const retired =
        name?.state === 'retired' ||
        (!!name &&
          heads.get(`${input.scope}\0${summary.resolution?.survivor ?? holder}`)?.state ===
            'retired');
      if (kind === 'zone' && !retired) {
        const site = (
          await env.fuseki.query(
            `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT ?zone ?segment WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?zone a rv:Zone ; rv:space ${iri(input.scope.slice(5))} ; rv:zoneState rv:Active ; rv:disclosure rv:Public ; rv:navigation ?navigation .
          ?navigation rv:selectedGeneration ?generation .
          ?mount a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrenceRole rv:MountRole ; schema:item ?collection ; rv:qualifier ?q .
          ?q rv:zone ?zone ; rv:routeSegment ?segment ; rv:disclosure rv:Public .
          ?collection a rv:Collection ; rv:structure ?structure . ?structure rv:selectedGeneration ?members .
          ?member a rv:OccurrencePlacement ; rv:generation ?members ; rv:occurrenceRole rv:MemberRole ; schema:item ${iri(holder!)} .
          FILTER NOT EXISTS { ?mount rv:removedBy ?removedMount }
          FILTER NOT EXISTS { ?member rv:removedBy ?removedMember }
          ${input.route ? `FILTER(?segment = ${lit(input.route)})` : ''}
        } } ORDER BY STR(?segment) LIMIT 1`,
            8192,
          )
        ).results?.bindings?.[0];
        if (site?.zone && site.segment) {
          try {
            const resolved = await resolveZoneRoute(work, request, {
              zone: site.zone.value,
              path: `/${site.segment.value}/${uuidToSid(holder!.slice(-36))}`,
            });
            if (resolved.kind === 'detail') canonical = resolved.resource.address;
          } catch (error) {
            if (!(error instanceof ZoneRouteMissing)) throw error;
            return { scope: input.scope, key: input.key, status: 'unavailable' as const };
          }
        } else if (input.route)
          return { scope: input.scope, key: input.key, status: 'unavailable' as const };
      }
      return {
        profile: 'address-resolution-v1' as const,
        scope: input.scope,
        key: input.key,
        status: retired ? ('retired' as const) : ('resolved' as const),
        holder: holder!,
        state: retired ? ('retired' as const) : (name?.state ?? ('current' as const)),
        canonical,
        ...(name ? { revision: name.revision } : {}),
        ...(summary.type === 'space' ? { capabilities: capabilities.get(holder!) ?? {} } : {}),
        ...(summary.resolution ? { resolution: summary.resolution } : {}),
      };
    }),
  );
}
