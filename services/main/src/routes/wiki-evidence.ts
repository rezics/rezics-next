import { Elysia, t } from 'elysia';
import { authorizedReadProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { WikiRejected } from '../modules/wiki/errors.ts';
import { readWikiClaimEvidence, projectWikiEvidence } from '../modules/wiki/evidence-read.ts';
import { readStatement, StatementNotFound } from '../modules/statement/read.ts';
import { readCurrentOccurrence } from '../modules/relation/change.ts';
import { readingPositionRead } from '../modules/reading-position/read.ts';
import { readingPositionQuery } from './reading-positions.ts';
import { wikiError } from './wiki.ts';
import { resolveTargets } from '../modules/target/resolve.ts';
import { problem } from './problems.ts';

export const openApiOperations = { '/v1/wiki/evidence/{id}': { get: { exposure: 'public', bearer: false } } } as const;
export const capabilities = {
  '/v1/wiki/evidence/{id}': { get: { disposition: 'supported',mcp: { tool: 'wiki_evidence',scopes: ['work:read'],
    title: 'Read wiki evidence',description: 'Read a claim’s source locator and permitted quotation at a reading position.' } } },
} as const;
export const WIKI_EVIDENCE_READ_COST = { evidenceRows: 1, rightsRows: 1, references: 64, referenceBatch: 50 } as const;
export function wikiEvidenceRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/wiki/evidence/:id', {
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
    query: t.Object({ actingSubject: t.Optional(t.String({ maxLength: 128 })),position: readingPositionQuery }),
    response: { 200: t.Object({ profile: t.Literal('wiki-evidence-v1'),id: t.String(),representationSha256: t.String(),
      sourceWork: t.String(),
      locator: t.Unknown(),quote: t.Nullable(t.String()),method: t.Unknown(),modality: t.String(),submitter: t.String(),rightsBasis: t.String(),
      claim: t.String(),claimKind: t.Union([t.Literal('statement'),t.Literal('relation')]),quoteWithheld: t.Boolean() }),
    ...authorizedReadProblems,422: problemResult(422) },
  },async ({ request,params,query }) => {
    try {
      const store = work.wikiEvidence;
      if (!store) throw new WikiRejected('wiki_quotation_unavailable',503);
      const row = await store.read(`https://rezics.com/id/${params.id}`);
      if (!row?.claim || !row.claimKind) return problem(404,'wiki_evidence_unavailable','Evidence is unavailable');
      const principal = request.headers.has('authorization') ? await work.account.verify(request,['work:read']) : null;
      const claim = row.claim, kind = row.claimKind;
      const projected = await readingPositionRead(work,request,principal,query.actingSubject,async boundary => {
        const evidence = (await readWikiClaimEvidence(boundary.session,[claim],kind,boundary)).get(claim);
        if (!evidence?.some(item => item.id === row.id)) throw new WikiRejected('wiki_unavailable',404);
        let references: string[];
        if (kind === 'statement') {
          const statement = await readStatement(work.environment,claim,async context => !!principal && !!query.actingSubject
            && !!await work.contextSelections?.canReadPrivate(principal,query.actingSubject,context));
          if (statement.state !== 'active' || statement.meaningBasis.state === 'unavailable') throw new WikiRejected('wiki_unavailable',404);
          references = [statement.subject,...(statement.value.kind === 'resource' ? [statement.value.iri] : [])];
        } else {
          const relation = await readCurrentOccurrence(work.environment,claim);
          if (!relation || relation.state.lifecycle !== 'active'
            || !evidence.some(item => item.id === relation.state.evidence)) throw new WikiRejected('wiki_unavailable',404);
          references = relation.state.participations.flatMap(item => item.participant.kind === 'resource' ? [item.participant.ref] : []);
        }
        for (let at = 0; at < references.length; at += WIKI_EVIDENCE_READ_COST.referenceBatch) {
          await resolveTargets(boundary.session,references.slice(at,at + WIKI_EVIDENCE_READ_COST.referenceBatch),'collection-member');
        }
        const visible = await boundary.visible([claim,...references]);
        if ([claim,...references].some(record => !visible.has(record))) throw new WikiRejected('wiki_unavailable',404);
        return (await projectWikiEvidence(boundary.session,[row]))[0]!;
      });
      return Response.json({ profile: 'wiki-evidence-v1',...projected,claim,claimKind: kind },
      { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return error instanceof StatementNotFound
      ? problem(404,'wiki_evidence_unavailable','Evidence is unavailable') : wikiError(error); }
  });
}
