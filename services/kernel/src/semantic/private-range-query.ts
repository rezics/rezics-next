import { memoizedValue } from '../memoized.ts';
import disclosure from './private-subject-disclosure.sql';
import mapping from './private-range-mapping.sql';
import keys from './private-range-keys.sql';
import candidate from './scope-leaf-selection-candidate.sql';
import privacy from './scope-leaf-selection-privacy.sql';
import provenance from './scope-leaf-selection-provenance.sql';

// Compose only owner literals. A module's bind refers to a previously typed column
// of the outer query. The wire statement binds each of its twelve operands once.
function body(sql: string) {
  return sql
    .replace(/--[^\n]*|\/\*file='[^']*'\*\//g, '')
    .trim()
    .replace(/;$/, '');
}

function correlate(query: { sql: string; params: readonly string[] }, columns: Record<string, string>) {
  return body(query.sql).replace(/\$(\d+)\b/g, (_, index: string) => {
    const name = query.params[Number(index) - 1]!;
    if (!Object.hasOwn(columns, name)) throw new TypeError('Unknown native catalogue operand: ' + name);
    return columns[name]!;
  });
}

// A scalar without qualifiers needs only its immutable datatype. The active release has
// already been digest-verified by Definitions. For an older digest, read exactly the
// requested property, keeping its native recording version and rejecting relation slots.
function recordedDefinition(digest: string) {
  return `SELECT r.digest,r.recorded_transaction_id AS version,r.erasure_key::text AS key,
      CASE WHEN (d.property->>'datatype') IN ('time','quantity') THEN d.property->>'datatype' END AS datatype
    FROM semantic.definition_release r
    CROSS JOIN LATERAL (SELECT r.body->'properties'->page.property AS property) d
    WHERE r.route=0 AND r.digest=${digest} AND r.digest<>page.digest
      AND jsonb_typeof(d.property)='object' AND NOT (d.property ? 'relation') LIMIT 1`;
}

export function privateRangeQuery() {
  return memoizedValue(privateRangeQuery, () => buildRangeQuery(false));
}

/** Scalar selection only. Its caller supplies the separately guarded directed population.
 * Require the active recording definition, so no historical release lookup enters this plan. */
export function preparedScalarRangeQuery() {
  return memoizedValue(preparedScalarRangeQuery, () => buildRangeQuery(true));
}

function buildRangeQuery(prepared: boolean) {
  const viewerColumns = ['viewer_route', 'viewer_id', 'floor', 'account_version', 'routes', 'ids', 'at', 'first_at'];
  const authority = body(disclosure.sql).replace(/\$(\d+)\b/g, (_, index: string) => {
    const column = viewerColumns[Number(index) - 1];
    if (!column) throw new TypeError('Unknown native disclosure operand');
    return 'page.' + column;
  });
  const point = { route: 'k.route', subject_id: 'k.id', candidate_id: 'raw.witness' };
  const rawKeys = correlate(keys, { route: 'k.route', subject: 'k.id', slot: 'k.slot', width: 'page.width' });
  const publicFloor = correlate(privacy, point);
  const chosen = correlate(candidate, { ...point, max_bytes: '1024' });
  const support = correlate(provenance, {
    routes: 'ARRAY[k.route]',
    subjects: 'ARRAY[k.id]',
    candidates: 'ARRAY[raw.witness]',
    slots: 'ARRAY[k.slot]',
    max_bytes: '0',
  });
  const identity = prepared ? '' : `mapping.source,mapping.control,`;
  const mappingJoin = prepared
    ? ''
    : `CROSS JOIN LATERAL (${correlate(mapping, { route: 'k.route', original: 'k.id' })}) mapping`;
  const subjectDefinition = prepared ? 'NULL::jsonb' : 'to_jsonb(subject_definition)';
  const factDefinition = prepared ? 'NULL::jsonb' : 'to_jsonb(fact_definition)';
  const subjectDefinitionJoin = prepared
    ? ''
    : `LEFT JOIN LATERAL (${recordedDefinition('a.current_release')}) subject_definition
      ON a.visibility='visible' AND NOT a.denied`;
  const factDefinitionJoin = prepared
    ? ''
    : `LEFT JOIN LATERAL (${recordedDefinition('raw.release')}) fact_definition ON raw.located=k.slot::text`;
  const releaseGuard = prepared
    ? 'raw.release=page.digest'
    : '(raw.release=page.digest OR fact_definition.datatype IS NOT NULL)';
  return `WITH page AS MATERIALIZED (
      SELECT $1::integer AS viewer_route,$2::uuid AS viewer_id,$3::bigint AS floor,$4::uuid AS account_version,
             $5::integer[] AS routes,$6::uuid[] AS ids,$7::timestamptz AS at,$8::timestamptz AS first_at,
             $9::uuid[] AS slots,$10::text AS property,$11::text AS digest,$12::integer AS width
    ), subjects AS MATERIALIZED (SELECT a.* FROM page CROSS JOIN LATERAL (${authority}) a),
    meaning AS MATERIALIZED (
      SELECT a.head,a.digest,a.recorded_transaction_id AS activation,r.recorded_transaction_id AS release_version,
             p.epoch AS home_epoch
      FROM page JOIN core.partition p ON p.partition_no=0 AND p.write_state='active' AND p.moved_to IS NULL
      CROSS JOIN LATERAL (SELECT head,digest,recorded_transaction_id FROM semantic.definition_activation
        WHERE route=0 ORDER BY head DESC LIMIT 1) a
      JOIN semantic.definition_release r ON r.route=0 AND r.digest=a.digest
      WHERE a.digest=page.digest
    )
    SELECT k.id,to_jsonb(a) AS authority,to_jsonb(m) AS meaning,${identity}
           ${subjectDefinition} AS subject_definition,selection.tuples
    FROM page CROSS JOIN meaning m
    CROSS JOIN LATERAL unnest(page.routes,page.ids,page.slots) WITH ORDINALITY k(route,id,slot,ordinal)
    JOIN subjects a ON a.id=k.id::text AND a.target IS NULL
    ${mappingJoin}
    ${subjectDefinitionJoin}
    LEFT JOIN LATERAL (
      WITH raw AS MATERIALIZED (SELECT r.* FROM (${rawKeys}) r WHERE a.visibility='visible' AND NOT a.denied),
      disclosed AS MATERIALIZED (
        SELECT raw.*,p.concealed FROM raw LEFT JOIN LATERAL (${publicFloor}) p ON raw.witness IS NOT NULL
      ), selected AS MATERIALIZED (
        SELECT raw.*,c.slot_id AS located,c.property,c.expanded,c.operation,c.body,c.release
        FROM disclosed raw LEFT JOIN LATERAL (${chosen}) c ON raw.witness IS NOT NULL AND NOT raw.concealed
      )
      SELECT jsonb_agg(jsonb_build_object(
        'slotOperation',raw.slot_operation,'log',raw.log_seq,'head',raw.head,'mode',raw.mode,'adoptionKey',raw.adoption_key,
        'count',raw.raw_count,'ordinal',raw.ordinal,'witness',raw.witness,'rank',raw.rank,'concealed',raw.concealed,
        'located',raw.located,'sameProperty',raw.property=page.property,'expanded',raw.expanded,'operation',raw.operation,
        'sameRelease',raw.release=page.digest,'recording',${factDefinition},'revision',v.revision,'sourceBytes',v.source_bytes,
        'bodyRank',CASE WHEN raw.body->>'rank' IN ('normal','preferred') THEN raw.body->>'rank' END,
        'scalar',raw.body IS NOT NULL AND coalesce(raw.body->'qualifiers','[]'::jsonb)='[]'::jsonb,
        'value',CASE WHEN v.source_bytes=0 AND raw.property=page.property AND raw.located=k.slot::text
          AND ${releaseGuard} AND coalesce(raw.body->'qualifiers','[]'::jsonb)='[]'::jsonb
          THEN raw.body->'value' END
      ) ORDER BY raw.ordinal) AS tuples
      FROM selected raw LEFT JOIN LATERAL (${support}) v ON raw.located=k.slot::text
      ${factDefinitionJoin}
    ) selection ON true
    ORDER BY k.ordinal`;
}
