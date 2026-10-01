import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { commandError, problem } from '../../routes/problems.ts';
import { checkedOpenLibraryWorkId, fetchOpenLibraryWork } from '../source/open-library.ts';
import {
  OpenLibraryImportSearchUnavailable,
  searchOpenLibraryImport,
} from './open-library-search.ts';
import { ReaderImportBudgetExceeded, ReaderImportUnavailable } from './reader-import.ts';

const privateHeaders = { 'cache-control': 'private, no-store' };

// Source acquisition stays behind the reviewed file operations. Keep its daily
// budgets and identity lock when retiring the old public transport routes.
export async function searchLibrarySource(
  work: MainWorkDependencies,
  request: Request,
  query: { actingSubject: string; isbn?: string; title?: string; author?: string },
): Promise<Response> {
  try {
    if (
      !(await work.access.canReadAsBaselineMember?.(
        await work.account.verify(request, ['work:read']),
        query.actingSubject,
      ))
    ) {
      return problem(403, 'reader_library_denied', 'Reader library unavailable');
    }
    if (!query.isbn && !query.title)
      return problem(400, 'invalid_request', 'Search for an ISBN or title');
    if (!work.libraryImport)
      return problem(503, 'reader_import_unavailable', 'Reader import unavailable');
    await work.libraryImport.takeBudget(query.actingSubject, 'search');
    return Response.json(
      { items: await searchOpenLibraryImport(query, work.openLibraryFetch ?? fetch) },
      { headers: privateHeaders },
    );
  } catch (error) {
    if (error instanceof ReaderImportBudgetExceeded) {
      return problem(
        429,
        'reader_import_search_budget',
        'Search limit reached; try again tomorrow',
      );
    }
    if (error instanceof OpenLibraryImportSearchUnavailable) {
      return problem(503, 'source_search_unavailable', 'Open Library search is unavailable');
    }
    return commandError(error);
  }
}

export async function adoptLibrarySource(
  work: MainWorkDependencies,
  request: Request,
  body: { actingSubject: string; workId: string; titleLanguage?: string },
): Promise<Response> {
  const key = request.headers.get('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
    return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key is required');
  }
  if (
    !work.sourceIntake ||
    !work.sourceConversions ||
    !work.sourceGraph ||
    !work.sourceProposals ||
    !work.sourceAdoptions ||
    !work.libraryImport
  ) {
    return problem(503, 'source_unavailable', 'Source owner is unavailable');
  }
  try {
    const principal = await work.account.verify(request, ['work:read', 'work:create']);
    if (!(await work.access.canReadAsBaselineMember?.(principal, body.actingSubject))) {
      return problem(403, 'reader_library_denied', 'Reader library unavailable');
    }
    const principalId = await work.access.activePrincipalId(principal);
    if (!principalId) return problem(403, 'authority_denied', 'Source principal is inactive');
    const workId = checkedOpenLibraryWorkId(body.workId);
    return await work.libraryImport.withOpenLibraryWork(workId, async () => {
      let observation = await work.sourceIntake!.replay(principalId, key);
      if (observation) {
        if (
          observation.provider !== 'open-library' ||
          observation.namespace !== 'work' ||
          observation.externalId !== workId ||
          observation.capture?.profile !== 'open-library-work-acquisition-v1'
        ) {
          return problem(409, 'source_intent_conflict', 'Import key changed Work');
        }
      }
      const existing = await work.libraryImport!.adoptedOpenLibraryWork(workId);
      if (existing)
        return Response.json({ work: existing, replayed: true }, { headers: privateHeaders });
      if (!observation) {
        await work.libraryImport!.takeBudget(body.actingSubject, 'acquisition');
        await work.sourceIntake!.reserveOpenLibrarySlot();
        const captured = await fetchOpenLibraryWork(workId, work.openLibraryFetch ?? fetch);
        observation = (
          await work.sourceIntake!.submit(principalId, key, captured.input, captured.capture)
        ).observation;
      }
      const conversion = await work.sourceConversions!.convert(
        principalId,
        observation.observation.slice(-36),
      );
      if (!conversion)
        return problem(503, 'source_unavailable', 'Source conversion is unavailable');
      const conversionId = conversion.conversion.conversion.slice(-36);
      await work.sourceGraph!.project(principalId, conversionId);
      const proposal = await work.sourceProposals!.propose(principalId, conversionId);
      if (!proposal) return problem(503, 'source_unavailable', 'Source proposal is unavailable');
      const adopted = await work.sourceAdoptions!.adopt(
        principalId,
        request,
        proposal.proposal.proposal.slice(-36),
        {
          actingSubject: body.actingSubject,
          authorityPath: 'represented-agent',
          confirmedTitle: proposal.proposal.candidateTitle,
          titleLanguage: body.titleLanguage,
        },
      );
      if (!adopted) return problem(503, 'source_unavailable', 'Work adoption is unavailable');
      return Response.json(
        { work: adopted.adoption.work, replayed: adopted.replayed },
        { headers: privateHeaders },
      );
    });
  } catch (error) {
    if (error instanceof ReaderImportBudgetExceeded) {
      return problem(
        429,
        'reader_import_adoption_budget',
        'Book addition limit reached; try again tomorrow',
      );
    }
    if (error instanceof ReaderImportUnavailable) {
      return problem(503, 'reader_import_unavailable', 'Reader import is temporarily unavailable');
    }
    return commandError(error);
  }
}
