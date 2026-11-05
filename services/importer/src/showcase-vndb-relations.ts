import { mapSourceEnumeration, vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import type { GraphEdgeDraft } from './cross-media-bindings.ts';

export const vndbWorkRelationConverterRevision = 'vndb-work-relations@1';

export type VndbWorkRelationEvidence = Readonly<{
  path: string;
  code: string;
  sourceSubject: string;
  sourceEndpoint: string;
  sourceUrl: string;
  recordRevision: string | null;
  digest: string;
  fields: readonly string[];
  record: Record<string, unknown>;
}>;

export type TypedVndbWorkRelationCode = 'side' | 'par';

export type VndbWorkRelationMapping =
  | {
      status: 'gap';
      record: Record<string, unknown>;
      reason: string;
      code?: string;
      endpoint?: string;
      property?: string;
    }
  | { status: 'mapped'; edge: GraphEdgeDraft };

export function isTypedVndbWorkRelation(code: string): code is TypedVndbWorkRelationCode {
  return code === 'side' || code === 'par';
}

/** Map one selected side/parent row using the released relation meaning and direction. */
export function mapVndbWorkRelation(input: {
  alias: string;
  id: string;
  vid: string;
  code: TypedVndbWorkRelationCode;
  record: Record<string, unknown>;
  fields: readonly string[];
  revisions: ReadonlyMap<string, string>;
}): VndbWorkRelationMapping {
  const mapping = mapSourceEnumeration('vndb', 'vn_relation', input.code);
  if (!mapping?.term || mapping.status === 'omitted') {
    return {
      status: 'gap',
      record: input.record,
      reason: mapping?.reason ?? 'No registered native converter for this source relation or entity',
      code: input.code,
      property: 'vn_relations.relation',
    };
  }

  const holder = mapping.inverse ? input.vid : input.id;
  const target = mapping.inverse ? input.id : input.vid;
  const recordRevision = input.revisions.get(holder);
  const evidence: VndbWorkRelationEvidence = {
    path: '/vn_relations/' + input.id + '/' + input.vid,
    code: input.code,
    sourceSubject: input.id,
    sourceEndpoint: input.vid,
    sourceUrl: vndbRecordUrl(input.id),
    recordRevision: input.revisions.get(input.id) ?? null,
    digest: sourceDigest(input.record),
    fields: [...input.fields],
    record: input.record,
  };
  return {
    status: 'mapped',
    edge: {
      source: 'vndb',
      alias: input.alias,
      table: 'vn_relations',
      holder,
      target,
      property: mapping.term,
      url: vndbRecordUrl(holder),
      membership: 'family',
      record: input.record,
      fields: [...input.fields],
      ...(recordRevision === undefined ? {} : { recordRevision }),
      converterRevision: vndbWorkRelationConverterRevision,
      vndbRelation: {
        sourceSubject: holder,
        sourceEndpoint: target,
        mappingRevision:
          vndbWorkRelationConverterRevision +
          ':' +
          input.code +
          ':' +
          mapping.term +
          ':' +
          (mapping.inverse ? 'inverse' : 'direct'),
        evidence: [evidence],
      },
    },
  };
}

/** Reciprocal side/par rows share one directed assertion and retain every cited source row. */
export function coalesceVndbWorkRelations(edges: readonly GraphEdgeDraft[]): GraphEdgeDraft[] {
  const groups = new Map<string, GraphEdgeDraft>();
  for (const edge of edges) {
    const identity = JSON.stringify([edge.holder, edge.target, edge.property]);
    const prior = groups.get(identity);
    if (!prior || !prior.vndbRelation || !edge.vndbRelation) {
      groups.set(identity, edge);
      continue;
    }
    const evidence = [...prior.vndbRelation.evidence, ...edge.vndbRelation.evidence]
      .filter(
        (row, index, all) =>
          all.findIndex((candidate) => candidate.path === row.path && candidate.digest === row.digest) === index,
      )
      .sort((left, right) => left.path.localeCompare(right.path) || left.digest.localeCompare(right.digest));
    const mappingRevision = [...new Set([prior.vndbRelation.mappingRevision, edge.vndbRelation.mappingRevision])]
      .sort()
      .join('+');
    const recordRevision = prior.recordRevision ?? edge.recordRevision;
    groups.set(identity, {
      ...prior,
      record: evidence[0]!.record,
      ...(recordRevision === undefined ? {} : { recordRevision }),
      fields: [...new Set([...prior.fields, ...edge.fields])].sort(),
      vndbRelation: {
        sourceSubject: prior.holder,
        sourceEndpoint: prior.target,
        mappingRevision,
        evidence,
      },
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.holder.localeCompare(right.holder) ||
      left.target.localeCompare(right.target) ||
      left.property.localeCompare(right.property),
  );
}
