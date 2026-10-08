import type { PoolClient } from 'pg';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { readResourceSummaries, type SummaryReader } from '../media/summary.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { readerLanguages } from '../display-language/select.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { resolveZoneRoute, zoneRouteViewer, ZoneRouteMissing } from '../zone/route.ts';
import { uuidToSid, identityKeyUuid } from '@rezics/model/address/sid';
import { fusekiReadBudget, FusekiReadBudgetExceeded } from '../../infrastructure/fuseki.ts';
import { workRead, WorkReadMissing } from '../work/read-session.ts';
import { publicLanguageRequest } from '../display-language/public-request.ts';
import { readRealmLanding } from '../realm-reads/read-realm.ts';
import { identityCanonical } from './canonical.ts';
import { readPost } from '../post/read.ts';
import { deriveAddressSuffix, isSid, type CanonicalAddress } from '@rezics/model/address';
import {
  ALIAS_COST,
  AliasInvalid,
  AliasUnavailable,
  scopeKind,
  type AliasScope,
  type AliasRow,
} from './registry.ts';

export type AddressScope = AliasScope | 'resource' | 'concept';
export interface AddressLookup {
  scope: AddressScope;
  key: string;
  route?: string;
}

/** SQL inventory lookup never establishes reading. The viewer's live Access
 * and disclosure checks admit holders and their independently readable capabilities. */
export async function resolveAddresses(
  work: MainWorkDependencies,
  request: Request,
  inputs: readonly AddressLookup[],
  actingSubject?: string,
) {
  if (!work.environment.addresses) throw new AliasUnavailable('Alias registry is unavailable');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(ALIAS_COST.deadlineMs)]);
  try {
    return await fusekiReadBudget.run({ signal, callsLeft: 4096, bytesLeft: 8 * 1024 * 1024 }, () =>
      work.environment.addresses!.withRead(client =>
        resolveAddressBatch(work, request, inputs, actingSubject, client),
      ),
    );
  } catch (error) {
    if (signal.aborted || error instanceof FusekiReadBudgetExceeded)
      throw new AliasUnavailable('Address read exceeded its budget');
    throw error;
  }
}

async function resolveAddressBatch(
  work: MainWorkDependencies,
  request: Request,
  inputs: readonly AddressLookup[],
  actingSubject?: string,
  client?: PoolClient,
) {
  if (!inputs.length || inputs.length > ALIAS_COST.batch)
    throw new AliasInvalid('Address batch exceeds its bound');
  const env = work.environment,
    registry = env.addresses;
  if (!registry) throw new AliasUnavailable('Alias registry is unavailable');
  if (request.headers.has('authorization') && !actingSubject)
    throw new AliasInvalid('actingSubject is required for an authenticated resolution');
  const viewer = await zoneRouteViewer(
    work,
    request,
    request.headers.has('authorization') ? actingSubject : undefined,
  );
  const reader: SummaryReader = {
    viewer: disclosureViewer(viewer.principal),
    ...(work.mediaAccess
      ? {
          canReadSemantics: (targets) =>
            work.mediaAccess!.canReadSemantics(
              viewer.principal,
              actingSubject ?? null,
              targets,
              env.fuseki,
            ),
        }
      : {}),
    ...(viewer.principal && actingSubject
      ? {
          canReadSemantic: (target) =>
            work.access.canReadSemanticResource?.(
              viewer.principal,
              actingSubject,
              target,
              undefined,
              env.fuseki,
              client,
            ) ?? Promise.resolve(false),
          realmReadProof: (realm) =>
            work.access.realmReadProof?.(viewer.principal!, actingSubject, realm) ??
            Promise.resolve(null),
        }
      : {}),
    ...(viewer.workPrincipal && actingSubject
      ? {
          canReadWork: (target) =>
            work.access.canReadWork(viewer.workPrincipal!, actingSubject, target, client),
        }
      : {}),
  };
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const selected: Array<{
    input: AddressLookup;
    holder: string | null;
    alias: AliasRow | null;
    capabilityIdentity?: string;
  }> = [];
  const deadline = Date.now() + ALIAS_COST.deadlineMs;
  for (const input of inputs) {
    if (Date.now() > deadline) throw new AliasUnavailable('Address read deadline exceeded');
    if (input.scope === 'resource' || input.scope === 'concept') {
      const uuid = identityKeyUuid(input.key);
      selected.push({ input, holder: uuid ? `https://rezics.com/id/${uuid}` : null, alias: null });
    } else selected.push({ input, ...(await registry.identify(input.scope, input.key)) });
  }
  const zoneSpaces = [
    ...new Set(
      inputs
        .filter((input) => input.scope.startsWith('zone:'))
        .map((input) => input.scope.slice(5)),
    ),
  ];
  const scopeZones = new Map<string, string>();
  if (zoneSpaces.length) {
    const sites =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT DISTINCT ?space ?zone WHERE {
      VALUES ?space { ${zoneSpaces.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?space a rv:Space .
        ?zone a rv:Zone ; rv:space ?space ; rv:zoneState rv:Active .
        FILTER NOT EXISTS { ?space rv:protectionHead ?p }
        FILTER NOT EXISTS { ?zone rv:protectionHead ?p }
      } } LIMIT ${zoneSpaces.length + 1}`,
          8192,
        )
      ).results?.bindings ?? [];
    for (const row of sites) {
      if (!row.space || !row.zone || scopeZones.has(row.space.value))
        throw new AliasUnavailable('Zone scope identity is ambiguous');
      scopeZones.set(row.space.value, row.zone.value);
    }
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
        UNION { ?resource a rv:Zone ; rv:zoneState rv:Active ; rv:space ?space }
        ?space a rv:Space .
        OPTIONAL { ?space rv:realmCapability ?realm . ?realm rv:realmState rv:Active }
        OPTIONAL { ?space rv:zoneCapability ?zone . ?zone rv:zoneState rv:Active }
      } } LIMIT ${ALIAS_COST.batch + 1}`,
          64 * 1024,
        )
      ).results?.bindings ?? [];
    const identities = new Map(rows.map((row) => [row.resource?.value, row.space?.value]));
    if (identities.size !== rows.length)
      throw new AliasUnavailable('Space capability identity is ambiguous');
    for (const row of rows)
      if (row.space) {
        capabilities.set(row.space.value, {
          ...(row.realm ? { realm: row.realm.value } : {}),
          ...(row.zone ? { zone: row.zone.value } : {}),
        });
        if (row.zone) scopeZones.set(row.space.value, row.zone.value);
      }
    for (const item of aliases) {
      const original = item.holder!;
      item.holder = identities.get(original) ?? (item.input.scope === 'space' ? null : item.holder);
      if (item.holder && item.holder !== original) item.capabilityIdentity = original;
    }
  }
  const resources = [
    ...new Set([
      ...selected.flatMap((item) =>
        item.holder
          ? [
              item.holder,
              ...(item.capabilityIdentity ? [item.capabilityIdentity] : []),
              ...(item.alias?.successor ? [item.alias.successor] : []),
            ]
          : [],
      ),
      ...scopeZones.values(),
      ...[...capabilities.values()].flatMap((item) =>
        [item.realm, item.zone].filter((ref): ref is string => !!ref),
      ),
    ]),
  ];
  const summaries = new Map();
  for (let at = 0; at < resources.length; at += ALIAS_COST.batch) {
    const batch = await readResourceSummaries(env, work.media?.store, reader, {
      resources: resources.slice(at, at + ALIAS_COST.batch),
      context: DEFAULT_MEDIA_CONTEXT,
      language: null,
      languages: readerLanguages(
        request.headers.get('x-rezics-display-languages'),
        request.headers.get('accept-language'),
      ),
      includeCollections: true,
    }, client);
    for (const summary of batch.summaries) summaries.set(summary.reference, summary);
  }
  // Scope membership is confidential even when the target is public. Retirement
  // must not turn a denied site into a readable alias inventory.
  for (const item of selected) {
    if (
      item.capabilityIdentity &&
      summaries.get(item.capabilityIdentity)?.status !== 'available' &&
      item.capabilityIdentity !== capabilities.get(item.holder!)?.realm
    )
      item.holder = null;
    if (
      item.input.scope.startsWith('zone:') &&
      summaries.get(scopeZones.get(item.input.scope.slice(5)))?.status !== 'available'
    )
      item.holder = null;
  }
  const aliased = selected.filter((item) => item.alias);
  const wantedHeads = aliased.flatMap((item) => {
    const summary = summaries.get(item.holder);
    return summary?.status === 'available'
      ? [
          {
            scope: item.input.scope as AliasScope,
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
  // A request landing admits only its Space address and Realm request target.
  // It never makes the private summary or a Zone capability readable. Cache by
  // holder so duplicate batch inputs share the bounded landing and alias reads.
  const landings = new Map<
    string,
    Promise<{
      canonical: ReturnType<typeof identityCanonical>;
      realm: string;
      head?: AliasRow;
    } | null>
  >();
  const landing = (holder: string) => {
    let pending = landings.get(holder);
    if (!pending) {
      pending = (async () => {
        const realm = capabilities.get(holder)?.realm;
        if (!realm) return null;
        try {
          return await workRead(
            work,
            publicLanguageRequest(request),
            {
              publicViewer: disclosureViewer(viewer.principal),
            },
            async (session) => {
              const page = await readRealmLanding(session, realm);
              if (page.profile !== 'realm-join-page-v1' || page.space !== holder) return null;
              const head = (await registry.heads(['space'], [holder])).get(`space\0${holder}`);
              const canonical = identityCanonical('space', holder, '');
              if (head?.state === 'current') canonical.key = head.key;
              return { canonical, realm: page.id, head };
            },
          );
        } catch (error) {
          if (error instanceof WorkReadMissing) return null;
          throw new AliasUnavailable('Space request address is unavailable', { cause: error });
        }
      })();
      landings.set(holder, pending);
    }
    return pending;
  };
  // Each distinct former chapter shares one Post read (at most eight readable
  // placements) and one Book summary. The existing Post/read-session budgets
  // fence graph changes and authority; duplicate aliases do not multiply them.
  const postPlaces = new Map<string, Promise<CanonicalAddress | null>>();
  const postPlace = (holder: string) => {
    let pending = postPlaces.get(holder);
    if (!pending) {
      pending = workRead(
        work,
        viewer.workPrincipal ? request : publicLanguageRequest(request),
        {
          publicViewer: disclosureViewer(viewer.principal),
          ...(viewer.workPrincipal && actingSubject ? { actingSubject } : {}),
        },
        async (session) => {
          const post = await readPost(session, holder);
          const first = post.placements[0];
          if (!first) return null;
          // A bounded list with only one entry cannot establish uniqueness if
          // truncated. Fail closed rather than guess a reader location.
          const places = post.placements.filter((place) => place.book === first.book);
          const single =
            places.length === 1 && (!post.placementsTruncated || post.placements.length > 1);
          const [book] = await session.summaries([first.book]);
          if (book?.status !== 'available' || book.type !== 'work') return null;
          const suffix = isSid(book.address.key)
            ? deriveAddressSuffix(book.address.suffixSource)
            : '';
          const key = `${book.address.key}${suffix ? `-${suffix}` : ''}`;
          return {
            prefix: single
              ? `/w/${encodeURIComponent(key)}/read/`
              : `/w/${encodeURIComponent(key)}/`,
            key: single ? first.occurrence.slice(-36) : 'contents',
            suffixSource: '',
          } satisfies CanonicalAddress;
        },
      ).catch((error) => {
        if (error instanceof WorkReadMissing) return null;
        throw new AliasUnavailable('Chapter address is unavailable', { cause: error });
      });
      postPlaces.set(holder, pending);
    }
    return pending;
  };
  return Promise.all(
    selected.map(async ({ input, holder, alias, capabilityIdentity }) => {
      const summary = holder ? summaries.get(holder) : null;
      const kind =
        input.scope === 'resource' || input.scope === 'concept'
          ? input.scope
          : scopeKind(input.scope);
      const chapter =
        kind === 'work' && summary?.status === 'available' && summary.type === 'resource';
      const chapterAddress = chapter ? await postPlace(holder!) : null;
      if (
        !summary ||
        summary.status !== 'available' ||
        (capabilityIdentity && summaries.get(capabilityIdentity)?.status !== 'available') ||
        (kind !== 'zone' && kind !== 'resource' && summary.type !== kind && !chapterAddress)
      ) {
        const page =
          input.scope === 'space' && holder && !alias?.successor ? await landing(holder) : null;
        if (page) {
          const retired = alias?.state === 'retired' || page.head?.state === 'retired';
          return {
            profile: 'address-resolution-v1' as const,
            scope: input.scope,
            key: input.key,
            holder: holder!,
            status: retired ? ('retired' as const) : ('resolved' as const),
            state: retired ? ('retired' as const) : (alias?.state ?? ('current' as const)),
            canonical: page.canonical,
            capabilities: { realm: page.realm },
            ...(alias ? { revision: alias.revision } : {}),
          };
        }
        return { scope: input.scope, key: input.key, status: 'unavailable' as const };
      }
      if (alias?.successor) {
        const next = summaries.get(alias.successor);
        if (!next || next.status !== 'available')
          return { scope: input.scope, key: input.key, status: 'unavailable' as const };
        if (
          !summary.resolution ||
          summary.resolution.survivor !== (next.resolution?.survivor ?? alias.successor)
        ) {
          throw new AliasUnavailable('Alias successor is no longer equivalent');
        }
      }
      let canonical = chapterAddress ?? summary.address;
      const availableCapabilities = Object.fromEntries(
        Object.entries(capabilities.get(holder!) ?? {}).filter(
          ([, target]) => summaries.get(target)?.status === 'available',
        ),
      );
      if (summary.type === 'space' && availableCapabilities.zone)
        canonical = summaries.get(availableCapabilities.zone).address;
      const retired =
        alias?.state === 'retired' ||
        (!!alias &&
          heads.get(`${input.scope}\0${summary.resolution?.survivor ?? holder}`)?.state ===
            'retired');
      if (kind === 'zone' && !retired) {
        const site = (
          await env.fuseki.query(
            `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT ?zone ?segment WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?zone a rv:Zone ; rv:space ${iri(input.scope.slice(5))} ; rv:zoneState rv:Active ; rv:navigation ?navigation .
          ?navigation rv:selectedGeneration ?generation .
          ?mount a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrenceRole rv:MountRole ; schema:item ?collection ; rv:qualifier ?q .
          ?q rv:zone ?zone ; rv:routeSegment ?segment .
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
              ...(actingSubject ? { actingSubject } : {}),
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
        state: retired
          ? ('retired' as const)
          : chapterAddress
            ? ('redirect' as const)
            : (alias?.state ?? ('current' as const)),
        canonical,
        ...(alias ? { revision: alias.revision } : {}),
        ...(summary.type === 'space' ? { capabilities: availableCapabilities } : {}),
        ...(summary.resolution ? { resolution: summary.resolution } : {}),
      };
    }),
  );
}
