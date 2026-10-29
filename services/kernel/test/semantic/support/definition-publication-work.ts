import { valueSchema, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { analyzePattern } from '../../../../../packages/definitions/src/pattern-safety.ts';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';

// Diagnostics only. Nothing here supplies a verdict, digest or budget to HTTP.
export const PROPOSED_WORK_MAX = 16 * 1024 * 1024;
export const CHECKPOINT_WEIGHT = 1024;
export const canonicalBytes = (value: unknown) => Buffer.byteLength(canonicalize(value)!);

function patterns(value: unknown, found = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'pattern' && typeof child === 'string') found.add(child);
    else if (child !== null && typeof child === 'object' && !Array.isArray(child)) patterns(child, found);
  }
  return found;
}

// Finite proposed membership derived from generated schemas, never a trust exemption.
// Every diagnostic actually runs the current checker, including IRI composition.
function fixedSources(): Set<string> {
  const sources = new Set<string>();
  for (const datatype of ['wikibase-item', 'media', 'url', 'document', 'monolingualtext', 'time'] as const)
    patterns(valueSchema(datatype), sources);
  for (const integer of [false, true])
    for (const exact of [undefined, true] as const)
      patterns(valueSchema('quantity', { integer, ...(exact ? { exact } : {}), units: ['*'] }), sources);
  return sources;
}

export function publicationFixture(addedProperties = 12): Release {
  const release = structuredClone(bundledRelease);
  release.catalogue = { id: 'https://example.org/publication-work', version: `properties-${addedProperties}` };
  release.prefixes.work = 'https://example.org/publication-work/';
  const keys: string[] = [];
  for (let index = 0; index < addedProperties; index++) {
    const suffix = String(index).padStart(4, '0');
    const key = `work:p${suffix}`;
    keys.push(key);
    release.properties[key] = {
      iri: `${release.prefixes.work}p${suffix}`,
      labels: { en: `Work code ${suffix}` },
      mappings: [],
      datatype: 'string',
      multivalued: false,
      qualifiers: [],
      value: valueSchema('string', { pattern: `^work${suffix}$` }),
    };
  }
  for (let index = 0; index < 3; index++) {
    const name = `Sample${index}`;
    release.types[`work:${name}`] = {
      iri: `${release.prefixes.work}${name}`,
      labels: { en: `Work sample ${index}` },
      mappings: [],
      bases: [],
      properties: keys.slice(index * 4, index * 4 + 4),
      facets: [],
    };
  }
  return release;
}

/** Exact public diagnostic counters and serialization sizes, not a product aggregate meter.
 * The floor deliberately omits opaque schema/semantic/sort work: it can prove excess,
 * but cannot certify admission or turn a low count into permission to publish.
 */
export function workDiagnostic(release: Release) {
  const fixed = new Map([...fixedSources()].map((source) => [source, analyzePattern(source)]));
  const distinct = new Set<string>();
  let valueCanonicalBytes = 0;
  let valueNodes = 0;
  for (const property of Object.values(release.properties)) {
    patterns(property.value, distinct);
    valueCanonicalBytes += canonicalBytes(property.value);
    const pending: unknown[] = [property.value];
    while (pending.length) {
      const current = pending.pop();
      valueNodes++;
      if (current !== null && typeof current === 'object') pending.push(...Object.values(current));
    }
  }
  const proofs = [...distinct].map((source) => {
    const actual = analyzePattern(source);
    return { source, ...actual, fixed: fixed.get(source)?.safe === true };
  });
  const steps = proofs.reduce((sum, proof) => sum + proof.steps, 0);
  const newSteps = proofs.filter((proof) => !proof.fixed).reduce((sum, proof) => sum + proof.steps, 0);
  const releaseBytes = canonicalBytes(release);
  const wireBytes = Buffer.byteLength(JSON.stringify({ release }));
  // The actual shared Auth driver's client id; requested_by is null for this account.
  const envelopeBytes = canonicalBytes({
    operation: 'definitions.publish',
    client_id: 'semantic-outcomes',
    requested_by: null,
    body: { params: {}, body: { release } },
  });
  // Existing successful path: size walk; validation JCS; digest JCS+SHA;
  // receipt-envelope JCS+SHA. This excludes parse and other traversals on purpose.
  const knownByteFloor = 4 * releaseBytes + 2 * envelopeBytes + 2 * valueCanonicalBytes;
  return {
    releaseBytes,
    wireBytes,
    envelopeBytes,
    valueCanonicalBytes,
    valueNodes,
    distinct: distinct.size,
    steps,
    newSteps,
    fixedInitializationSteps: [...fixed.values()].reduce((sum, proof) => sum + proof.steps, 0),
    fixedSources: fixed.size,
    fixedSafe: [...fixed.values()].every((proof) => proof.safe),
    allSafe: proofs.every((proof) => proof.safe),
    knownByteFloor,
    currentFloor: CHECKPOINT_WEIGHT * steps + knownByteFloor,
    proposedReuseFloor: CHECKPOINT_WEIGHT * newSteps + knownByteFloor,
    proofs,
  };
}

// Actual write surfaces of definitions publish/runCommand, plus semantic revision/fact
// surfaces to detect a mistakenly routed command. Missing tables throw; none mean zero.
export const EFFECT_TABLES = [
  'semantic.definition_release',
  'semantic.definition_activation',
  'semantic.revision',
  'semantic.subject',
  'semantic.fact',
  'semantic.candidate',
  'semantic.source_candidate',
  'semantic.external_claim',
  'core.partition',
  'core.receipt',
  'core.outbox',
  'editorial.write_basis',
] as const;

export async function effectsSnapshot(pool: Pool) {
  // One repeatable native snapshot, outside the HTTP operation. Retain contents,
  // not counts alone: an update or replacement must also fail equality.
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables: Record<string, unknown> = {};
    for (const table of EFFECT_TABLES) {
      const { rows } = await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
      tables[table] = rows.map(({ row }) => row);
    }
    await client.query('COMMIT');
    return tables;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
