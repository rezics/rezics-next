import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { EXPERIENCE_OBSERVATION_PROFILE, experienceRatingIdentity } from '../../../services/main/src/modules/rating/experience.ts';
import { standingRatingDigest, standingRatingReceiptIri } from '../../../services/main/src/modules/rating/observation.ts';
import { GRAPHS, ID, RV, iri, lit, prepareComponent, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

/** Fixture-only bulk data. These rows have no interactive command evidence.
 * Build all immutable bytes once; add prefixes without public-command seeding. */
export async function ratingAggregateBackground(env: WorkActivationEnvironment, pool: Pool,
  target: { context: string; work: string; mainVersion: string }, sampleObservation: string,
  count: number) {
  const sample = (await pool.query(`SELECT a.*, c.realm, c.revision AS context_revision FROM access.rating_aggregate_head h
    JOIN access.admission a ON a.id = h.original_admission_id JOIN access.rating_aggregate_context c ON c.context = h.context
    WHERE h.observation = $1`, [sampleObservation])).rows[0]!;
  const instant = (sample.registered_at as Date).toISOString();
  const items = Array.from({ length: count }, () => {
    const id = randomUUID(), observation = ID + randomUUID(), revision = ID + randomUUID(), occasion = randomUUID();
    const identity = experienceRatingIdentity(sample.principal_id, target.context, target.mainVersion, occasion);
    const digest = standingRatingDigest({ ...target, value: 2, expectedRevisionHead: null, occasion, actingSubject: sample.acting_subject });
    const receipt = standingRatingReceiptIri(id);
    const manifest = prepareComponent(env.objectDirectory, observation, { ...target,
      observation, revision, slot: identity.slot, occasion, occasionKey: identity.occasionKey,
      contextRevision: sample.context_revision, realm: sample.realm, predecessor: null,
      availability: 'available', value: 2, evaluatedAt: instant, submittedAt: instant,
      originalSubmissionAt: instant, revisedAt: instant }, EXPERIENCE_OBSERVATION_PROFILE);
    return { id, observation, revision, identity, receipt, digest, manifest,
      patch: { id, idempotency_key: id, request_digest: digest, graph_receipt: receipt } };
  });
  async function append(start: number, end: number) {
    const part = items.slice(start, end);
    if (!part.length) return;
    // Copy one actual admitted row's bounded shape, replacing every unique key.
    await pool.query(`INSERT INTO access.admission SELECT
      (jsonb_populate_record(NULL::access.admission, to_jsonb(a) || patch)).*
      FROM access.admission a CROSS JOIN jsonb_array_elements($2::jsonb) patch WHERE a.id = $1`,
    [sample.id, JSON.stringify(part.map(item => item.patch))]);
    await pool.query(`INSERT INTO access.rating_aggregate_head
      (context, main_version, slot, work, observation, revision, principal_id, admission_id, original_admission_id)
      SELECT $1,$2,x.slot,$3,x.observation,x.revision,$4,x.id::uuid,x.id::uuid
      FROM jsonb_to_recordset($5::jsonb) x(id text, observation text, revision text, slot text)`,
    [target.context, target.mainVersion, target.work, sample.principal_id,
      JSON.stringify(part.map(item => ({ id: item.id, observation: item.observation, revision: item.revision, slot: item.identity.slot })))]);
    await env.fuseki.update(`PREFIX rv: <${RV}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${part.map(item => `${iri(item.observation)}
        a rv:RatingObservation, rv:ExperienceRatingObservation ; rv:ratingContext ${iri(target.context)} ;
        rv:targetMainVersion ${iri(target.mainVersion)} ; rv:ratingSlot ${iri(item.identity.slot)} ;
        rv:ratingOccasion ${iri(item.identity.occasionKey)} ; rv:observationHead ${iri(item.revision)} .`).join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${part.map(item => `${iri(item.revision)}
        a rv:RatingObservationRevision, rv:ExperienceRatingObservationRevision, rv:RevisionAnchor ;
        rv:component ${iri(item.observation)} ; rv:observation ${iri(item.observation)} ; rv:ratingOccasion ${iri(item.identity.occasionKey)} ;
        rv:modelRevision ${iri(EXPERIENCE_OBSERVATION_PROFILE)} ; rv:ratingAvailability rv:Available ; rv:ratingValue 2 ;
        rv:manifest ${iri(`urn:rezics:sha256:${item.manifest}`)} ; rv:evaluatedAt ${lit(instant)}^^xsd:dateTime ;
        rv:submittedAt ${lit(instant)}^^xsd:dateTime ; rv:originalSubmissionAt ${lit(instant)}^^xsd:dateTime ;
        rv:revisedAt ${lit(instant)}^^xsd:dateTime ; rv:dataEpoch ${lit(sample.graph_data_epoch)} ; rv:sequence ${sample.graph_sequence} .`).join('\n')} }
      GRAPH ${iri(GRAPHS.receipts)} { ${part.map(item => `${iri(item.receipt)} rv:observationRevision ${iri(item.revision)} ;
        rv:ratingObservation ${iri(item.observation)} ; rv:outcome rv:Succeeded ; rv:requestDigest ${lit(item.digest)} .`).join('\n')} } }`);
  }
  async function clear() {
    await env.fuseki.update(`DELETE { GRAPH ?g { ?s ?p ?o } } WHERE {
      VALUES ?g { ${iri(GRAPHS.current)} ${iri(GRAPHS.revisions)} ${iri(GRAPHS.receipts)} }
      VALUES ?s { ${items.flatMap(item => [item.observation, item.revision, item.receipt]).map(iri).join(' ')} }
      GRAPH ?g { ?s ?p ?o } }`);
    const ids = items.map(item => item.id);
    await pool.query('DELETE FROM access.rating_aggregate_head WHERE admission_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM access.admission WHERE id = ANY($1::uuid[])', [ids]);
  }
  return { append, clear };
}
