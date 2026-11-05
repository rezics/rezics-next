import type { Pool } from 'pg';
import { classifyUnavailability, AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import type { Fact } from '../search/hits.ts';
import { routeOf } from '../route/route.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { readListPresentationFacts } from '../semantic/list-presentation.ts';
import { readSubjectSummaries, type SubjectSummary } from '../semantic/summaries.ts';
import { activeRelease } from '../semantic/definitions.ts';

type IdentityMapping = Awaited<ReturnType<typeof readIdentityMappings>>[number];

export const COPY_LIST_CONTEXT_MAX_ROWS = 100;
export const COPY_LIST_CONTEXT_MAX_BYTES = 65_536;

export type CopyListContextIdentity = Readonly<{ id: string; labels: Record<string, string> }>;
export type CopyListContext =
  | Readonly<{ state: 'available'; work: readonly CopyListContextIdentity[]; facts: Record<string, Fact[]> }>
  | Readonly<{ state: 'unsupported'; facts: Record<string, Fact[]> }>
  | Readonly<{ state: 'scope' | 'withheld' | 'missing' | 'unavailable' }>;

export type CopyListContextDependencies = {
  pool: Pool;
  access: Access;
  actor: Actor;
  routeKey: Uint8Array;
  deadline: number;
};

type ContextCopy = { subjectId: string };
type ContextRow<T> = T & { subject: SubjectSummary | null; context: CopyListContext };

const unavailable = (): CopyListContext => ({ state: 'unavailable' });
const forbiddenAssociation = 'schema:exampleOfWork';
const softSemanticFailures = new Set([
  'semantic_not_ready',
  'dependency_unavailable',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'overloaded',
]);

function semanticFailure(error: unknown): boolean {
  if (error instanceof AccessUnavailableError) return error.reason !== 'deadline';
  const reason = classifyUnavailability(error);
  if (reason !== undefined) return reason !== 'deadline';
  return error instanceof ProblemError && softSemanticFailures.has(error.code);
}

function sameMapping(left: IdentityMapping | undefined, right: IdentityMapping | undefined): boolean {
  if (!left || !right || left.state !== right.state) return false;
  switch (left.state) {
    case 'mapped':
      return (
        right.state === 'mapped' &&
        left.original === right.original &&
        left.terminal === right.terminal &&
        left.epoch === right.epoch
      );
    case 'pending':
      return (
        right.state === 'pending' &&
        left.original === right.original &&
        left.job.jobId === right.job.jobId &&
        left.job.epoch === right.job.epoch
      );
    case 'absent':
      return right.state === 'absent';
    case 'unavailable':
      return right.state === 'unavailable' && left.reason === right.reason;
  }
  return false;
}

function disclosedFacts(facts: Record<string, Fact[]>): Record<string, Fact[]> {
  // Semantic list presentation has not adopted a completeness-aware work/release
  // association result. Do not let a partial relation fact become an association.
  return Object.fromEntries(Object.entries(facts).filter(([property]) => property !== forbiddenAssociation));
}

/**
 * Attach one bounded Semantic projection to the complete raw copy page. Copies stay
 * present when their optional public context is hidden, missing, unsupported or unavailable.
 * The native caller must re-read and compare its page/account fence in `revalidate`.
 */
export async function attachCopyListContext<T extends ContextCopy>(
  deps: CopyListContextDependencies,
  copies: readonly T[],
  options: { languages?: readonly string[]; revalidate: () => Promise<void> },
): Promise<ContextRow<T>[]> {
  if (copies.length > COPY_LIST_CONTEXT_MAX_ROWS)
    throw new ProblemError('content_too_large', { detail: 'Copy list context accepts at most 100 raw copies' });
  requireAccessDeadline(deps.deadline);
  if (!copies.length) return [];

  const originals = copies.map((copy) => copy.subjectId);
  const validOriginals = [...new Set(originals.filter((id) => routeOf(id) !== null))];
  let before: IdentityMapping[] | null = null;
  let after: IdentityMapping[] | null = null;
  let summaries = new Map<string, SubjectSummary | null>();
  let facts = new Map<string, { id: string; facts: Record<string, Fact[]> } | null>();
  let semanticUnavailable = false;
  let releaseBefore: { digest: string; head: number } | null = null;

  try {
    const active = await withConnection(deps.pool, (client) => activeRelease(deadlineClient(client, deps.deadline)));
    if (active) releaseBefore = { digest: active.digest, head: active.head };
    else semanticUnavailable = true;
    before = await readIdentityMappings(deps.pool, validOriginals);
    const byOriginal = new Map(validOriginals.map((id, index) => [id, before![index]!]));
    const terminals = before.flatMap((mapping) => (mapping.state === 'mapped' ? [mapping.terminal] : []));
    const summaryIds = [...new Set([...validOriginals, ...terminals])];
    const languageOptions = options.languages?.length ? { languages: options.languages } : {};
    if (!semanticUnavailable) summaries = await readSubjectSummaries(deps, summaryIds, languageOptions);

    // Pass every mapped raw row, duplicates included, through one existing Semantic fact batch.
    const mappedOriginals = originals.filter((id) => byOriginal.get(id)?.state === 'mapped');
    if (!semanticUnavailable && mappedOriginals.length)
      facts = await readListPresentationFacts(deps, mappedOriginals, languageOptions);
  } catch (error) {
    if (!semanticFailure(error)) throw error;
    semanticUnavailable = true;
  }

  if (before) {
    try {
      after = await readIdentityMappings(deps.pool, validOriginals);
    } catch (error) {
      if (!semanticFailure(error)) throw error;
      semanticUnavailable = true;
    }
  }

  try {
    const active = await withConnection(deps.pool, (client) => activeRelease(deadlineClient(client, deps.deadline)));
    if (!active || !releaseBefore || active.digest !== releaseBefore.digest || active.head !== releaseBefore.head)
      semanticUnavailable = true;
  } catch (error) {
    if (!semanticFailure(error)) throw error;
    semanticUnavailable = true;
  }

  // This is deliberately the last foreign operation: the owner home is not held while
  // summaries/facts/identity are read, then the exact native page and epoch are rechecked.
  await options.revalidate();
  requireAccessDeadline(deps.deadline);

  const beforeByOriginal = new Map(validOriginals.map((id, index) => [id, before?.[index]!]));
  const afterByOriginal = new Map(validOriginals.map((id, index) => [id, after?.[index]!]));
  const rows = copies.map((copy): ContextRow<T> => {
    const original = copy.subjectId;
    if (routeOf(original) === null) return { ...copy, subject: null, context: { state: 'missing' } };
    const previous = beforeByOriginal.get(original);
    const current = afterByOriginal.get(original);
    const stable = sameMapping(previous, current);
    if (!stable) return { ...copy, subject: null, context: unavailable() };
    if (previous?.state === 'absent')
      return {
        ...copy,
        subject: summaries.get(original) ?? null,
        context: semanticUnavailable ? unavailable() : { state: 'missing' },
      };
    if (previous?.state !== 'mapped') return { ...copy, subject: null, context: unavailable() };

    const subject = summaries.get(previous.terminal) ?? null;
    if (semanticUnavailable) return { ...copy, subject, context: unavailable() };
    if (!subject) return { ...copy, subject: null, context: { state: 'withheld' } };
    if (!subject.creativeWork) return { ...copy, subject, context: { state: 'scope' } };

    const presentation = facts.get(original);
    if (!presentation || presentation.id !== previous.terminal) return { ...copy, subject, context: unavailable() };

    return {
      ...copy,
      subject,
      context: { state: 'unsupported', facts: disclosedFacts(presentation.facts) },
    };
  });

  // Count repeated rows before applying this projection's explicit 64 KiB context byte limit.
  // Overflow refuses the whole rich projection; it never truncates identity evidence.
  if (Buffer.byteLength(JSON.stringify(rows.map(({ context }) => context)), 'utf8') > COPY_LIST_CONTEXT_MAX_BYTES)
    return rows.map((row) =>
      row.context.state === 'unsupported' || row.context.state === 'available'
        ? { ...row, context: unavailable() }
        : row,
    );
  return rows;
}
