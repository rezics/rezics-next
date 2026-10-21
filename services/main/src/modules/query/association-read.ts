import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { namePolicyPrincipal } from '../disclosure/viewer.ts';
import { problemDefinition } from '../problem.ts';
import { publicWorkRead, workRead, WorkReadInvalid, WorkReadLimit, WorkReadMoved,
  type WorkReadSession } from '../work/read-session.ts';
import { ASSOCIATION_QUERY, type AssociationCreditsQuery, type AssociationRequest } from './association-contract.ts';
import { AssociationCursorInvalid, AssociationStaleQuery, type AssociationSurface } from './association-cursor.ts';
import { readRetainedCreditAssociationPage, type AssociationReadOwners } from './association-credit.ts';
import { selectAssociations } from './association-selection.ts';

declare module '../../routes/dependencies.ts' {
  interface MainWorkDependencies {
    /** Server-owned Relation/Statement and Source composition. Missing owners
     * keep the admitted template unavailable, including empty inventories. */
    subjectAssociations?: AssociationReadOwners;
  }
}

export function creditAssociationRequest(work: string, options: AssociationCreditsQuery): AssociationRequest {
  return { profile: 'template-query-v1', query: ASSOCIATION_QUERY, revision: 1,
    parameters: { kind: 'credit', direction: 'work-to-subject', roots: [{ kind: 'resource', ref: work }],
      projection: 'occurrence', context: !options.context || options.context === 'global' ? 'global' : { realm: options.context },
      frame: options.frame ?? [], position: options.position ?? 'start', match: { all: [], any: [], none: [] } },
    presentation: { language: options.language, actingSubject: options.actingSubject },
    limit: options.limit === undefined ? undefined : Number(options.limit), cursor: options.cursor };
}

/** Both public surfaces use the same session, owner adapter and page projection.
 * Global reads retain live viewer preferences without bearer catalogue authority. */
export async function executeAssociationQuery(deps: MainWorkDependencies, request: Request,
  input: AssociationRequest, surface: AssociationSurface = 'query'): Promise<Response> {
  let selection = selectAssociations(input);
  const operation = async (session: WorkReadSession) => {
    selection = selectAssociations(input, session.displayLanguages[0]);
    if (selection.presentation.actingSubject && !namePolicyPrincipal(session.viewer)) {
      throw new AccountAssertionDenied('Authentication is required');
    }
    if (selection.parameters.context !== 'global') await session.realm(selection.parameters.context.realm);
    const owners = deps.subjectAssociations;
    const result = owners?.native ? await owners.native(session, selection, surface, input.cursor)
      : await readRetainedCreditAssociationPage(session, selection, owners ?? {}, surface, input.cursor);
    return surface === 'query' ? { profile: 'query-v1' as const, template: ASSOCIATION_QUERY, selection, result } : result;
  };
  const options = { ...input.presentation, limit: selection.limit, cursor: input.cursor,
    localBasis: true, readOnlyTemplate: true };
  const { actingSubject: _actor, ...publicOptions } = options;
  try {
    const result = selection.parameters.context === 'global'
      ? await publicWorkRead(deps, request, publicOptions, operation)
      : await workRead(deps, request, options, operation);
    return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof WorkReadMoved) throw new AssociationStaleQuery(selection);
    throw error;
  }
}

/** Association-specific refusals keep the legacy read routes' defaults intact. */
export function associationReadFailure(error: unknown): Response | undefined {
  const failure = error instanceof AssociationCursorInvalid
    ? problemDefinition(400, 'invalid_cursor', 'Association cursor is invalid')
    : error instanceof AssociationStaleQuery
      ? problemDefinition(409, 'stale_query_result', 'Association read changed; restart the selection')
      : error instanceof WorkReadInvalid
        ? problemDefinition(422, 'invalid_work_read', 'Subject association selection is invalid')
        : error instanceof WorkReadLimit
          ? problemDefinition(503, 'work_read_unavailable', 'Work read is unavailable') : null;
  if (!failure) return undefined;
  return Response.json({ ...failure.body, ...(error instanceof AssociationStaleQuery ? { restart: error.restart } : {}) },
    { status: failure.body.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}
