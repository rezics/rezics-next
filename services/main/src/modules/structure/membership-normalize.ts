import { CommandRejected, FusekiClient } from '../../infrastructure/fuseki.ts';
import { profileValidations, type ProfileId } from '../../infrastructure/profile.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  iri,
  lit,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { CompositionCorrupt, itemListIri, itemPosition, structureIri } from './graph.ts';
import { structureProfileForGraph } from './profiles.ts';

function membershipCandidateQuery(limit: number): string {
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT DISTINCT ?placement ?type ?generation ?profile ?parent ?segmentKey ?orderKey
        ?item ?legacyTarget ?occurrence ?qualifier ?removed WHERE { GRAPH ${iri(GRAPHS.current)} {
        VALUES ?type { rv:OccurrencePlacement rv:RemovedPlacement }
        ?placement a ?type ; rv:generation ?generation ; rv:occurrence ?occurrence .
        ?generation rv:structure ?structure . ?structure rv:structureProfile ?profile .
        OPTIONAL { ?placement rv:orderSegment ?segment ; rv:orderKey ?orderKey .
          ?segment rv:parent ?parent ; rv:segmentKey ?segmentKey }
        OPTIONAL { ?placement schema:item ?item }
        OPTIONAL { ?placement rv:qualifier ?qualifier }
        OPTIONAL { ?placement rv:target ?legacyTarget }
        OPTIONAL { ?placement rv:removedBy ?removed }
        FILTER(BOUND(?legacyTarget) || ?type = rv:OccurrencePlacement && (
          !BOUND(?item) || NOT EXISTS { ?placement a schema:ListItem }
          || NOT EXISTS { ?placement schema:position ?position
            FILTER(?position = CONCAT(?segmentKey, "-", ?orderKey)) }
          || !BOUND(?removed) && NOT EXISTS { ?list a schema:ItemList ;
            rv:generation ?generation ; rv:parent ?parent ; schema:itemListElement ?placement }))
      } } ORDER BY ?placement LIMIT ${limit}`;
}

/** Refresh inspects the same candidates as the upgrader without writing data. */
export async function hasUnnormalizedMembership(
  fuseki: Pick<FusekiClient, 'query'>,
): Promise<boolean> {
  const result = await fuseki.query(membershipCandidateQuery(1), 128 * 1024);
  return Boolean(result.results?.bindings?.length);
}

/** Owner preparation must finish conversion before product processes start.
 * Batches share one wall deadline. Receipts let a failed preparation resume
 * from the remaining rows without replaying already converted membership.
 */
export async function upgradeStoredMembership(env: WorkActivationEnvironment) {
  const deadline = Date.now() + 540_000;
  let placements = 0;
  const receipts: string[] = [];
  while (Date.now() < deadline) {
    const result = await normalizeStoredMembership(env, 256, deadline);
    placements += result.placements;
    receipts.push(...result.receipts);
    if (result.complete) return { complete: true as const, placements, receipts };
  }
  throw new Error(
    'Ordered membership upgrade exceeded its preparation budget; product processes must remain stopped',
  );
}

/** Privileged representation repair, never exposed through a product route.
 * One transaction covers at most 24 placements and their parent lists. Each
 * exact basis has a durable receipt; interruption resumes from unconverted rows.
 * Heads, retained manifests, selection pins and parent-local keys do not change.
 */
export async function normalizeStoredMembership(
  env: WorkActivationEnvironment,
  maxBatches = 256,
  deadline = Date.now() + 540_000,
): Promise<{ complete: boolean; placements: number; receipts: string[] }> {
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 256) {
    throw new Error('membership normalization requires 1-256 bounded batches');
  }
  const receipts: string[] = [];
  let placements = 0;
  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch++) {
    const result = await env.fuseki.query(membershipCandidateQuery(24), 128 * 1024);
    const rows = result.results?.bindings ?? [];
    if (!rows.length) return { complete: true, placements, receipts };
    if (new Set(rows.map((row) => row.placement?.value)).size !== rows.length) {
      throw new CompositionCorrupt('membership normalization found ambiguous placement data');
    }
    const digest = hash(
      JSON.stringify({ family: 'ordered-membership-normalization-v1', lineage: env.lineage, rows }),
    );
    const receipt = `urn:rezics:receipt:bootstrap:ordered-membership:${digest}`;
    const event = `urn:rezics:event:${hash(receipt)}`;
    const deletes: string[] = [],
      inserts: string[] = [],
      guards: string[] = [];
    const specs = new Map<ProfileId, { shape: string; focus: string[]; graphs: string[] }[]>();
    const validate = (profile: ProfileId, shape: string, focus: string, graphs: string[]) => {
      const entries = specs.get(profile) ?? [];
      entries.push({
        shape: `https://rezics.com/definition/${profile}/${shape}-shape`,
        focus: [focus],
        graphs,
      });
      specs.set(profile, entries);
    };
    for (const [index, row] of rows.entries()) {
      const placement = row.placement?.value,
        generation = row.generation?.value;
      const profile = row.profile?.value,
        type = row.type?.value;
      if (!placement || !generation || !profile || !type) {
        throw new CompositionCorrupt('membership normalization found an incomplete placement');
      }
      const target =
        row.item?.value ?? row.legacyTarget?.value ?? row.qualifier?.value ?? row.occurrence?.value;
      if (row.item && row.legacyTarget && row.item.value !== row.legacyTarget.value) {
        throw new CompositionCorrupt(
          'membership normalization refuses conflicting item predicates',
        );
      }
      guards.push(`${iri(placement)} a ${structureIri(type)} ; rv:generation ${iri(generation)} ;
        rv:occurrence ${iri(row.occurrence!.value)} .`);
      // A writer can change a qualifier without changing its order keys.
      guards.push(
        row.item
          ? `${iri(placement)} schema:item ${structureIri(row.item.value)} .`
          : `FILTER NOT EXISTS { ${iri(placement)} schema:item ?item${index} }`,
      );
      guards.push(
        row.qualifier
          ? `${iri(placement)} rv:qualifier ${iri(row.qualifier.value)} .`
          : `FILTER NOT EXISTS { ${iri(placement)} rv:qualifier ?qualifier${index} }`,
      );
      if (row.legacyTarget) {
        const triple = `${iri(placement)} rv:target ${structureIri(row.legacyTarget.value)} .`;
        deletes.push(triple);
        guards.push(triple);
      }
      if (target) inserts.push(`${iri(placement)} schema:item ${structureIri(target)} .`);
      const projected = type === `${RV}OccurrencePlacement`;
      if (projected) {
        const parent = row.parent?.value,
          segmentKey = row.segmentKey?.value,
          orderKey = row.orderKey?.value;
        if (!parent || !segmentKey || !orderKey) {
          throw new CompositionCorrupt(
            'membership normalization found an incomplete order position',
          );
        }
        guards.push(`${iri(placement)} rv:orderKey ${lit(orderKey)} ; rv:orderSegment ?segment${index} .
          ?segment${index} rv:parent ${iri(parent)} ; rv:segmentKey ${lit(segmentKey)} .`);
        guards.push(
          row.removed
            ? `${iri(placement)} rv:removedBy ${iri(row.removed.value)} .`
            : `FILTER NOT EXISTS { ${iri(placement)} rv:removedBy ?removed${index} }`,
        );
        deletes.push(`${iri(placement)} schema:position ?position${index} .`);
        guards.push(`OPTIONAL { ${iri(placement)} schema:position ?position${index} }`);
        inserts.push(
          `${iri(placement)} a schema:ListItem ; schema:position ${lit(itemPosition(segmentKey, orderKey))} .`,
        );
        if (!row.removed) {
          const list = itemListIri(generation, parent);
          inserts.push(`${iri(list)} a schema:ItemList ; rv:generation ${iri(generation)} ;
            rv:parent ${iri(parent)} ; schema:itemListElement ${iri(placement)} .`);
          validate('structure-composition-v1', 'item-list', list, [GRAPHS.current]);
        }
      }
      const owner = structureProfileForGraph(profile);
      const validationProfile = owner.topologyValidationProfile ?? 'structure-composition-v1';
      validate(validationProfile, projected ? 'placement' : 'removed-placement', placement, [
        GRAPHS.current,
        GRAPHS.revisions,
      ]);
    }
    const checks = (
      await Promise.all(
        [...specs].map(([profile, entries]) => profileValidations(env.fuseki, profile, entries)),
      )
    ).flat();
    const command = await env.fuseki.commandWithReceipt({
      receipt,
      digest,
      deadlineMs: 10_000,
      validations: checks,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
          GRAPH ${iri(GRAPHS.current)} { ${deletes.join('\n')} } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${inserts.join('\n')} }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
            rv:action "structure.membership.normalize" ; rv:placementCount ${rows.length} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
            ${iri(event)} a rv:MembershipNormalizedEvent ; rv:ordinal 0 ;
              rv:action "structure.membership.normalize" ; rv:receipt ${iri(receipt)} . }
        } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          GRAPH ${iri(GRAPHS.current)} { ${guards.join('\n')} }
          BIND(?n + 1 AS ?next) }`,
    });
    if (command.status === 'guard-unmatched') continue;
    if (command.status !== 'committed') throw new CommandRejected(command);
    receipts.push(receipt);
    placements += rows.length;
  }
  return { complete: false, placements, receipts };
}

if (import.meta.main) {
  for (const name of [
    'FUSEKI_URL',
    'FUSEKI_MAINTENANCE_TOKEN',
    'MAIN_DATA_EPOCH',
    'MAIN_ROUTING_EPOCH',
  ]) {
    if (!Bun.env[name]) throw new Error(`Membership normalization requires ${name}`);
  }
  const result = await normalizeStoredMembership({
    fuseki: new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
    objectDirectory: '.temp/membership-normalization',
  });
  console.log(JSON.stringify(result));
  if (!result.complete) process.exitCode = 2;
}
