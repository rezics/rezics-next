import { createHash } from 'node:crypto';
import { checkedDerivation, derivationProjection, type ContentDerivationInput, type ContentDerivationRecord }
  from '../../../../content/src/derivation.ts';
import { ContentAdoptionInvalid } from '../../../../content/src/adoption.ts';
import { AdmissionDenied } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, workRead, WorkReadMissing, WorkReadUnavailable, type WorkReadSession }
  from '../work/read-session.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { contentReferenceOwners } from './reference.ts';
import { resolveResourceReference } from '../../../../content/src/reference.ts';

export async function recordContentDerivation(deps: MainWorkDependencies, request: Request,
  input: ContentDerivationInput & { actingSubject: string }, key: string) {
  checkedDerivation(input);
  if (!deps.contentAuthoring || !deps.access.withOwnerAuthority) throw new WorkReadUnavailable('Content authoring is unavailable');
  await assertGraphAdmissionOpen(deps.environment.fuseki, deps.environment.lineage);
  const principal = await deps.account.verify(request, ['work:edit']);
  const store = deps.contentAuthoring.derivations;
  const operation = createHash('sha256').update(JSON.stringify([
    'content-derivation-v1', principal.issuer, principal.subject, input.actingSubject, key,
  ])).digest('hex');
  // A current control mandate supplies participation evidence for the named
  // public Agent; it cannot be fabricated by merely naming an AI or another person.
  return deps.access.withOwnerAuthority({ principal, actingSubject: input.actingSubject,
    action: 'content.draft', scope: `content:draft:${input.output.target}` }, () =>
    deps.access.withOwnerAuthority!({ principal, actingSubject: input.responsibleAgent,
      action: 'agent.control', scope: `agent:control:${input.responsibleAgent}` }, async () => {
      const rows = (await deps.environment.fuseki.query(`SELECT ?type WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.responsibleAgent)} a <https://rezics.com/vocab/Agent> ;
          <https://rezics.com/vocab/agentKind> ?type ; <https://rezics.com/vocab/profileDisclosure> <https://rezics.com/vocab/Public> }
        VALUES ?type { <https://rezics.com/vocab/PersonAgent> <https://rezics.com/vocab/ServiceAgent> }
      } LIMIT 3`, 4096)).results?.bindings ?? [];
      const types = new Set(rows.map(row => row.type?.value));
      if (types.size !== 1) throw new AdmissionDenied('responsible public Agent is unavailable');
      const agentType = types.has('https://rezics.com/vocab/PersonAgent') ? 'human' as const : 'software' as const;
      const recorded = await store.record(operation, input, agentType, client => {
        const read = () => workRead(deps, request,
          { actingSubject: input.actingSubject }, async session => {
            // Exact Content reads share the transaction that pins these revisions.
            const owners = contentReferenceOwners(session, client);
            // Recheck under both authority locks immediately before the Content commit.
            for (const reference of [input.output, ...input.inputs]) {
              if ((await resolveResourceReference(reference, owners)).status !== 'available')
                throw new ContentAdoptionInvalid('an exact derivation selection is unavailable');
            }
          });
        // Media shares Content's pool, including visibility and avatar probes.
        return deps.media ? deps.media.store.withSummaryClient(client, read) : read();
      });
      return { ...recorded, projection: derivationProjection(recorded) };
    }));
}

export type DisclosedDerivation = Omit<ContentDerivationRecord, 'inputs' | 'responsibleAgent'> & {
  replayed: false;
  inputs: (ContentDerivationRecord['inputs'][number] | { status: 'unavailable' })[];
  responsibleAgent: string | { status: 'unavailable' };
  projection?: Record<string, unknown>;
};
/** Every input is fenced again on every page. An unavailable input loses its identities. */
export async function readContentDerivations(session: WorkReadSession, revision: string,
  limit = 20, cursor?: string): Promise<{ revision: string; items: DisclosedDerivation[]; nextCursor: string | null; complete: boolean }> {
  const content = session.deps.contentAuthoring;
  if (!content) throw new WorkReadUnavailable('Content owner is unavailable');
  const resource = await content.owningResourceForRevision(revision);
  if (!resource) throw new WorkReadMissing('Revision is unavailable');
  const exact = (await content.readExactBatch([revision], async ids => new Set(ids)))[0];
  if (exact?.status !== 'available') throw new WorkReadMissing('Revision is unavailable');
  const owners = contentReferenceOwners(session);
  const output = { target: resource, selector: { grain: 'content' as const, variantId: exact.reference.variantId, revision } };
  if ((await resolveResourceReference(output, owners)).status !== 'available') throw new WorkReadMissing('Revision is unavailable');
  const binding = { family: 'content-derivations-v1', revision, limit, actor: session.options.actingSubject ?? null };
  const after = decodeReadCursor(cursor, binding, session.position, true)?.after ?? null;
  const page = await content.derivations.page(revision, limit, after);
  const next = page.length > limit; page.splice(limit);
  const items: DisclosedDerivation[] = [];
  for (const record of page) {
    const inputs: DisclosedDerivation['inputs'] = [];
    for (const input of record.inputs) inputs.push((await resolveResourceReference(input, owners)).status === 'available'
      ? input : { status: 'unavailable' });
    const agentAvailable = await owners.resource(record.responsibleAgent);
    items.push({ ...record, replayed: false, inputs, responsibleAgent: agentAvailable ? record.responsibleAgent : { status: 'unavailable' },
      ...(agentAvailable && inputs.every(item => !('status' in item)) ? { projection: derivationProjection(record) } : {}) });
  }
  // Publication can close while input checks await. Re-fence the output too.
  if ((await resolveResourceReference(output, owners)).status !== 'available') throw new WorkReadMissing('Revision is unavailable');
  return { revision, items, complete: !next, nextCursor: next ? encodeReadCursor(binding, session.position, page.at(-1)!.derivation,
    '', Date.now() + 15 * 60_000) : null };
}
