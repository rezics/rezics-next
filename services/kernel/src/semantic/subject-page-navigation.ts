import { readPublicAccountCanonicalTargets } from '../access/account-canonical-targets.ts';
import { preparePublicSemanticPageMetadata } from '../presentation/semantic-page.ts';
import { routeOf } from '../route/route.ts';
import type { SummaryReaderDependencies } from './summaries.ts';

export type PublicSubjectPageCandidate = {
  id: string;
  target: { family: 'subject'; subjectId: string } | { family: 'account'; accountId: string; canonicalPath: string };
  views: readonly string[];
};

/** Released native observations bracket the publication reader's existing proof, without new leaf reads. */
export async function preparePublicSubjectPageCandidates(
  deps: SummaryReaderDependencies,
  subjectIds: readonly string[],
) {
  if (subjectIds.length > 100) throw new RangeError('Public subject page candidates accept at most 100 ids');
  const ids = [...new Set(subjectIds)];
  if (ids.some((id) => routeOf(id) === null))
    throw new TypeError('Public subject page candidates require full routed keys');
  if (!(deps.routeKey instanceof Uint8Array) || deps.routeKey.byteLength < 32)
    throw new TypeError('Public subject page candidates require the server route key');
  const reader: SummaryReaderDependencies = { ...deps, actor: { kind: 'anonymous' } };
  const metadata = ids.length ? await preparePublicSemanticPageMetadata(reader, ids) : null;
  const accounts = metadata ? await readPublicAccountCanonicalTargets(reader, ids) : null;
  return {
    async finish(): Promise<Map<string, PublicSubjectPageCandidate | null>> {
      const result = new Map<string, PublicSubjectPageCandidate | null>(ids.map((id) => [id, null]));
      if (!metadata || !accounts) return result;
      const currentAccounts = await readPublicAccountCanonicalTargets(reader, ids);
      // Keep the original Subject/profile/release/disclosure guards after all dependent Account work.
      const pages = await metadata.finish();
      for (const id of ids) {
        const page = pages.get(id);
        if (!page) continue;
        if (!accounts.has(id) || !currentAccounts.has(id)) continue;
        const before = accounts.get(id);
        const account = currentAccounts.get(id);
        if (before || account) {
          // Equality only rejects changed navigation. Both reads enforce current native Account admission.
          if (
            !before ||
            !account ||
            before.accountId !== account.accountId ||
            before.accountKind !== account.accountKind ||
            before.handle !== account.handle ||
            before.canonicalPath !== account.canonicalPath ||
            before.views.length !== account.views.length ||
            before.views.some((view, index) => view !== account.views[index])
          )
            continue;
          const admitted = new Set<string>(account.views);
          // A valid identity with no current claim has no native navigable Account destination.
          if (account.canonicalPath !== null)
            result.set(id, {
              id,
              target: { family: 'account', accountId: account.accountId, canonicalPath: account.canonicalPath },
              views: page.views.filter((view) => admitted.has(view)),
            });
        } else if (page.independentSubject) {
          result.set(id, { id, target: { family: 'subject', subjectId: id }, views: page.views });
        }
      }
      return result;
    },
  };
}

/** Current anonymous navigation data, never publication, permission, ordering or custody authority. */
export async function readPublicSubjectPageCandidates(
  deps: SummaryReaderDependencies,
  subjectIds: readonly string[],
): Promise<Map<string, PublicSubjectPageCandidate | null>> {
  return (await preparePublicSubjectPageCandidates(deps, subjectIds)).finish();
}
