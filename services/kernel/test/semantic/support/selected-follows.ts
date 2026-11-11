import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { accessCommandAuthorization } from '../../../src/request/access.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import { mergeSubjects } from '../../../src/semantic/merges.ts';
import { subjectTarget } from '../../../src/semantic/subject.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createRealAccess } from '../real-access.ts';
import { quotedKey, withIdentityHttp } from './identity-operations-http.ts';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';

const FOLLOWS = 'wdt:P155';
const FOLLOWED_BY = 'wdt:P156';
const RELEASE_TYPE = 'wd:Q20631656';

type RelationCandidate = {
  holder: string;
  target: string;
  candidate: string;
  context: string;
  source: string;
  proposal: OperationEvidence;
  acceptance: OperationEvidence;
};

type OperationEvidence = {
  operation: string;
  status: number;
  location: string | null;
  body: Record<string, unknown>;
};

type RelationEdge = { from: string; to: string; statements: string[] };

type EvidenceRecord = {
  holder: string;
  candidate: string;
  source: string;
  retainedSources: string[];
  release: string | null;
  statement: unknown;
};

export type SelectedFollowsObservation = {
  name: string;
  context: string;
  operations: unknown[];
  cleanup: OperationEvidence[];
  endpoints: Record<string, { status: number; body: Record<string, unknown>; canonical: string }>;
  forward: RelationEdge[];
  inverse: RelationEdge[];
  evidence: EvidenceRecord[];
  history: Record<string, unknown>;
  violations: string[];
};

function evidence(answer: HttpResponse, operation: string): OperationEvidence {
  return {
    operation,
    status: answer.status,
    location: answer.headers.get('location'),
    body: answer.body,
  };
}

function requireStatus(answer: HttpResponse, status: number, operation: string): HttpResponse {
  if (answer.status !== status)
    throw new Error(`${operation}: expected ${status}; received ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer;
}

function idempotencyHeaders(): Record<string, string> {
  return { 'Idempotency-Key': quotedKey() };
}

function canonicalEdge(property: string, from: string, to: string): [string, string] {
  if (property === FOLLOWS) return [from, to];
  if (property === FOLLOWED_BY) return [to, from];
  throw new Error(`Unexpected property in selected follows read: ${property}`);
}

function edgeKey(edge: Pick<RelationEdge, 'from' | 'to'>): string {
  return `${edge.from}\u0000${edge.to}`;
}

function canonicalizeEdge(
  property: string,
  from: string,
  to: string,
  canonical: ReadonlyMap<string, string>,
  statement: string,
): RelationEdge {
  const [orientedFrom, orientedTo] = canonicalEdge(property, from, to);
  return {
    from: canonical.get(orientedFrom) ?? orientedFrom,
    to: canonical.get(orientedTo) ?? orientedTo,
    statements: [statement],
  };
}

function mergedEdges(rows: RelationEdge[]): RelationEdge[] {
  const edges = new Map<string, RelationEdge>();
  for (const row of rows) {
    const key = edgeKey(row);
    const existing = edges.get(key);
    if (existing) existing.statements.push(...row.statements);
    else edges.set(key, { ...row, statements: [...row.statements] });
  }
  return [...edges.values()].sort((left, right) =>
    `${left.from}\u0000${left.to}`.localeCompare(`${right.from}\u0000${right.to}`),
  );
}

function sourceUrls(statement: unknown): string[] {
  if (!statement || typeof statement !== 'object') return [];
  const candidate = statement as {
    references?: { parts?: { property?: { id?: string }; value?: { content?: unknown } }[] }[];
  };
  return (candidate.references ?? []).flatMap((reference) =>
    (reference.parts ?? [])
      .filter((part) => part.property?.id === 'schema:url' && typeof part.value?.content === 'string')
      .map((part) => part.value!.content as string),
  );
}

function pairPresent(edges: readonly RelationEdge[], from: string, to: string): boolean {
  return edges.some((edge) => edge.from === from && edge.to === to);
}

function operationSucceeded(operation: OperationEvidence): boolean {
  return operation.status === 200 || operation.status === 201;
}

export async function runSelectedFollowsWitness(): Promise<SelectedFollowsObservation[]> {
  const observations: SelectedFollowsObservation[] = [];

  await withIdentityHttp(async (driver) => {
    const follows = bundledRelease.properties[FOLLOWS] as
      | { relation?: { inverse?: string; acyclic?: boolean } }
      | undefined;
    if (follows?.relation?.inverse !== FOLLOWED_BY || follows.relation.acyclic !== true)
      throw new Error(`Bundled ${FOLLOWS} must declare inverse ${FOLLOWED_BY} and acyclic: true`);

    await driver.grant('editor', ['context:accept', 'context:adopt'], driver.globalContext);

    const editor = await driver.fixtures.person('editor');
    const routeKey = Buffer.from(driver.fixtures.runtime.routeKey, 'base64url');
    const usedPartitions = new Set<number>();
    const subjects: string[] = [];
    for (const label of ['Selected follows A', 'Selected follows B', 'Selected follows C']) {
      let key = '';
      let ownerPartition = -1;
      for (let attempt = 0; attempt < 10_000; attempt++) {
        const candidate = randomUUID();
        const target = subjectTarget(routeKey, editor.accountId, candidate);
        const candidatePartition = partitionOf(target.route);
        if (usedPartitions.has(candidatePartition)) continue;
        key = candidate;
        ownerPartition = candidatePartition;
        usedPartitions.add(candidatePartition);
        break;
      }
      if (!key) throw new Error('Could not assign three subjects to distinct native partitions');

      const answer = requireStatus(
        await driver.request(
          'editor',
          'POST',
          '/v1/subjects',
          { type: RELEASE_TYPE, labels: { en: label } },
          { 'Idempotency-Key': JSON.stringify(key) },
        ),
        201,
        `create ${label}`,
      );
      const subject = answer.body.subject as { id?: unknown } | undefined;
      if (typeof subject?.id !== 'string')
        throw new Error(`create ${label}: subject id missing from ${JSON.stringify(answer.body)}`);
      const actualRoute = routeOf(subject.id);
      if (actualRoute === null || partitionOf(actualRoute) !== ownerPartition)
        throw new Error(`create ${label}: assigned partition ${ownerPartition}, got ${String(actualRoute)}`);
      subjects.push(subject.id);
    }
    const [a, b, c] = subjects as [string, string, string];

    const contextAnswer = requireStatus(
      await driver.request(
        'editor',
        'POST',
        '/v1/contexts',
        { labels: { en: 'Selected follows community' } },
        idempotencyHeaders(),
      ),
      201,
      'create community Context',
    );
    const contextBody = contextAnswer.body.context as { id?: unknown } | undefined;
    if (typeof contextBody?.id !== 'string')
      throw new Error(`create community Context: id missing from ${JSON.stringify(contextAnswer.body)}`);
    const community = contextBody.id;
    const partitions = new Set(subjects.map((id) => partitionOf(routeOf(id)!)));
    const projection = linkProjection(driver.fixtures.pool);
    const selectionHeads = new Map<string, number>();

    function selectionKey(holder: string, target: string, context: string): string {
      return `${holder}\u0000${FOLLOWS}\u0000${target}\u0000${context}`;
    }

    function recordSelectionHead(holder: string, target: string, context: string, operation: OperationEvidence): void {
      const adoption = operation.body.adoption as { head?: unknown } | undefined;
      if (!operationSucceeded(operation) || typeof adoption?.head !== 'number')
        throw new Error(`${operation.operation}: successful adoption head missing from ${JSON.stringify(operation.body)}`);
      selectionHeads.set(selectionKey(holder, target, context), adoption.head);
    }

    async function drain(): Promise<void> {
      await driver.projection('paused');
      try {
        for (let step = 0; step < 100; step++) {
          let pending = false;
          for (const partition of partitions) {
            const result = await projection.run(partition);
            pending ||= result.status === 'busy' || result.envelopes > 0;
          }
          if (!pending) return;
        }
        throw new Error('Selected follows link projection did not drain');
      } finally {
        await driver.projection('running');
      }
    }

    async function proposeAndAccept(holder: string, target: string, context: string): Promise<RelationCandidate> {
      const source = `https://example.test/selected-follows/${randomUUID()}`;
      const proposed = requireStatus(
        await driver.request(
          'editor',
          'POST',
          `/v1/subjects/${holder}/candidates`,
          {
            statement: {
              property: { id: FOLLOWS },
              value: { type: 'value', content: target },
              references: [
                {
                  parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: source } }],
                },
              ],
            },
          },
          idempotencyHeaders(),
        ),
        201,
        `propose ${holder} ${FOLLOWS} ${target}`,
      );
      const candidate = proposed.body.candidate;
      if (typeof candidate !== 'string')
        throw new Error(`proposal candidate id missing from ${JSON.stringify(proposed.body)}`);
      const accepted = requireStatus(
        await driver.request(
          'acceptor',
          'POST',
          `/v1/subjects/${holder}/candidates/${candidate}:accept`,
          { context, expected_head: null },
          idempotencyHeaders(),
        ),
        200,
        `accept candidate ${candidate} in ${context}`,
      );
      return {
        holder,
        target,
        candidate,
        context,
        source,
        proposal: evidence(proposed, `propose ${holder} ${FOLLOWS} ${target}`),
        acceptance: evidence(accepted, `accept ${candidate} in ${context}`),
      };
    }

    async function adopt(edge: RelationCandidate, persona: 'editor' | 'acceptor'): Promise<OperationEvidence> {
      const answer = await driver.request(
        persona,
        'POST',
        `/v1/subjects/${edge.holder}:adopt`,
        {
          context: edge.context,
          property: FOLLOWS,
          target: edge.target,
          mode: 'replace',
          expected_head: selectionHeads.get(selectionKey(edge.holder, edge.target, edge.context)) ?? null,
          selection: [{ candidate: edge.candidate, rank: 'normal' }],
        },
        idempotencyHeaders(),
      );
      const result = evidence(answer, `adopt ${edge.holder} ${FOLLOWS} ${edge.target} in ${edge.context}`);
      if (operationSucceeded(result)) recordSelectionHead(edge.holder, edge.target, edge.context, result);
      return result;
    }

    async function unselect(edge: RelationCandidate, selection: OperationEvidence): Promise<OperationEvidence | null> {
      if (!operationSucceeded(selection)) return null;
      const currentHead = selectionHeads.get(selectionKey(edge.holder, edge.target, edge.context));
      if (currentHead === undefined)
        throw new Error(`${selection.operation}: current selection head is missing`);
      const answer = await driver.request(
        'acceptor',
        'POST',
        `/v1/subjects/${edge.holder}:adopt`,
        {
          context: edge.context,
          property: FOLLOWS,
          target: edge.target,
          mode: edge.context === driver.globalContext ? 'replace' : 'inherit',
          expected_head: currentHead,
          selection: [],
        },
        idempotencyHeaders(),
      );
      const result = evidence(answer, `clear ${edge.holder} ${FOLLOWS} ${edge.target} in ${edge.context}`);
      if (operationSucceeded(result)) recordSelectionHead(edge.holder, edge.target, edge.context, result);
      return result;
    }

    async function suppressGlobalEdge(holder: string, target: string): Promise<OperationEvidence> {
      const answer = await driver.request(
        'acceptor',
        'POST',
        `/v1/subjects/${holder}:adopt`,
        {
          context: community,
          property: FOLLOWS,
          target,
          mode: 'suppress',
          expected_head: selectionHeads.get(selectionKey(holder, target, community)) ?? null,
          selection: [],
        },
        idempotencyHeaders(),
      );
      const result = evidence(answer, `suppress inherited ${holder} ${FOLLOWS} ${target} in ${community}`);
      if (operationSucceeded(result)) recordSelectionHead(holder, target, community, result);
      return result;
    }

    async function readCanonical(id: string): Promise<{ status: number; body: Record<string, unknown>; canonical: string }> {
      const answer = await driver.request('editor', 'GET', `/v1/subjects/${id}`);
      if (answer.status === 200) {
        const subject = answer.body.subject as { id?: unknown } | undefined;
        if (typeof subject?.id !== 'string')
          throw new Error(`read canonical ${id}: subject id missing from ${JSON.stringify(answer.body)}`);
        return { status: answer.status, body: answer.body, canonical: subject.id };
      }
      if (answer.status === 308) {
        const redirect = answer.body.redirect as { from?: unknown; to?: unknown } | undefined;
        if (redirect?.from !== id || typeof redirect.to !== 'string')
          throw new Error(`read canonical ${id}: invalid redirect ${JSON.stringify(answer.body)}`);
        return { status: answer.status, body: answer.body, canonical: redirect.to };
      }
      throw new Error(`read canonical ${id}: ${answer.status} ${JSON.stringify(answer.body)}`);
    }

    async function readEvidence(candidates: RelationCandidate[]): Promise<EvidenceRecord[]> {
      const records: EvidenceRecord[] = [];
      for (const candidate of candidates) {
        const route = routeOf(candidate.holder);
        if (route === null) throw new Error(`Candidate holder is not routable: ${candidate.holder}`);
        const result = await driver.fixtures.pool.query<{
          candidate_id: string;
          statement: unknown;
          release: string;
        }>(
          `SELECT candidate_id::text, statement, release
             FROM semantic.candidate
            WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
          [route, candidate.holder, candidate.candidate],
        );
        const row = result.rows[0];
        records.push({
          holder: candidate.holder,
          candidate: candidate.candidate,
          source: candidate.source,
          retainedSources: row ? sourceUrls(row.statement) : [],
          release: row?.release ?? null,
          statement: row?.statement ?? null,
        });
      }
      return records;
    }

    async function capture(
      name: string,
      context: string,
      operations: unknown[],
      candidates: RelationCandidate[],
      options: {
        cyclePair?: readonly [string, string];
        canonicalTogether?: readonly [string, string];
        requiredEdges?: readonly (readonly [string, string])[];
        forbiddenEdges?: readonly (readonly [string, string])[];
        eitherEdges?: readonly [readonly [string, string], readonly [string, string]];
      } = {},
    ): Promise<SelectedFollowsObservation> {
      const endpointRows = await Promise.all(subjects.map(async (id) => [id, await readCanonical(id)] as const));
      const endpoints = Object.fromEntries(endpointRows);
      const canonical = new Map(endpointRows.map(([id, read]) => [id, read.canonical]));
      const visibleSubjects = [...new Set(endpointRows.map(([, read]) => read.canonical))];
      const forwardRows: RelationEdge[] = [];
      const inverseRows: RelationEdge[] = [];

      for (const holder of visibleSubjects) {
        const forward = requireStatus(
          await driver.request(
            'editor',
            'GET',
            `/v1/subjects/${holder}/relations?property=${FOLLOWS}&context=${context}&limit=100`,
          ),
          200,
          `read forward ${FOLLOWS} for ${holder} in ${context}`,
        );
        const relations = forward.body.relations as {
          target?: unknown;
          statement?: { id?: unknown; property?: { id?: unknown } };
        }[];
        for (const relation of relations) {
          if (typeof relation.target !== 'string' || typeof relation.statement?.id !== 'string')
            throw new Error(`forward relation has no resolved target or statement: ${JSON.stringify(relation)}`);
          const property =
            typeof relation.statement.property?.id === 'string' ? relation.statement.property.id : FOLLOWS;
          forwardRows.push(
            canonicalizeEdge(property, holder, relation.target, canonical, relation.statement.id),
          );
        }

        const inverse = requireStatus(
          await driver.request(
            'editor',
            'GET',
            `/v1/subjects/${holder}/links?property=${FOLLOWS}&context=${context}&limit=100`,
          ),
          200,
          `read inverse ${FOLLOWED_BY} for ${holder} in ${context}`,
        );
        const links = inverse.body.links as {
          subject?: unknown;
          statement?: { id?: unknown };
        }[];
        for (const link of links) {
          if (typeof link.subject !== 'string' || typeof link.statement?.id !== 'string')
            throw new Error(`inverse link has no holder or statement: ${JSON.stringify(link)}`);
          // The inverse page is read as P156 (anchor -> holder); normalize it once to P155.
          inverseRows.push(
            canonicalizeEdge(FOLLOWED_BY, holder, link.subject, canonical, link.statement.id),
          );
        }
      }

      const forward = mergedEdges(forwardRows);
      const inverse = mergedEdges(inverseRows);
      const forwardKeys = new Set(forward.map(edgeKey));
      const inverseKeys = new Set(inverse.map(edgeKey));
      const evidenceRows = await readEvidence(candidates);
      const histories = await Promise.all(subjects.map(async (id) => [id, await driver.inspect.revisions(id)] as const));
      const violations: string[] = [];
      if (forwardKeys.size !== inverseKeys.size || [...forwardKeys].some((key) => !inverseKeys.has(key)))
        violations.push('forward and inverse selected-edge reads disagree after P156 normalization');

      if (options.canonicalTogether) {
        const [left, right] = options.canonicalTogether;
        if ((canonical.get(left) ?? left) !== (canonical.get(right) ?? right))
          violations.push(`expected merged canonical identity for ${left} and ${right}`);
      }

      const selfLoops = forward.filter((edge) => edge.from === edge.to);
      if (selfLoops.length) violations.push(`canonical self-loop: ${JSON.stringify(selfLoops)}`);

      if (options.cyclePair) {
        const left = canonical.get(options.cyclePair[0]) ?? options.cyclePair[0];
        const right = canonical.get(options.cyclePair[1]) ?? options.cyclePair[1];
        if (pairPresent(forward, left, right) && pairPresent(forward, right, left))
          violations.push(`directed two-edge cycle: ${left} -> ${right} -> ${left}`);
      }

      for (const [from, to] of options.requiredEdges ?? []) {
        const canonicalFrom = canonical.get(from) ?? from;
        const canonicalTo = canonical.get(to) ?? to;
        if (!pairPresent(forward, canonicalFrom, canonicalTo))
          violations.push(`expected selected edge missing: ${canonicalFrom} -> ${canonicalTo}`);
      }
      for (const [from, to] of options.forbiddenEdges ?? []) {
        const canonicalFrom = canonical.get(from) ?? from;
        const canonicalTo = canonical.get(to) ?? to;
        if (pairPresent(forward, canonicalFrom, canonicalTo))
          violations.push(`suppressed edge remains selected: ${canonicalFrom} -> ${canonicalTo}`);
      }
      if (options.eitherEdges) {
        const [[firstFrom, firstTo], [secondFrom, secondTo]] = options.eitherEdges;
        if (
          !pairPresent(forward, canonical.get(firstFrom) ?? firstFrom, canonical.get(firstTo) ?? firstTo) &&
          !pairPresent(forward, canonical.get(secondFrom) ?? secondFrom, canonical.get(secondTo) ?? secondTo)
        )
          violations.push('neither concurrent opposite edge was selected');
      }

      for (const item of evidenceRows) {
        if (item.release !== bundledDigest || !item.retainedSources.includes(item.source))
          violations.push(`original candidate evidence changed or disappeared: ${item.candidate}`);
      }

      return {
        name,
        context,
        operations,
        cleanup: [],
        endpoints,
        forward,
        inverse,
        evidence: evidenceRows,
        history: Object.fromEntries(histories),
        violations,
      };
    }

    async function clearSuccessful(edges: readonly RelationCandidate[], selections: readonly OperationEvidence[]): Promise<OperationEvidence[]> {
      const cleanup: OperationEvidence[] = [];
      for (let index = 0; index < edges.length; index++) {
        const result = await unselect(edges[index]!, selections[index]!);
        if (!result) continue;
        cleanup.push(result);
        if (!operationSucceeded(result))
          throw new Error(`${result.operation}: ${result.status} ${JSON.stringify(result.body)}`);
      }
      await drain();
      return cleanup;
    }

    const sequentialForward = await proposeAndAccept(a, b, driver.globalContext);
    const sequentialReverse = await proposeAndAccept(b, a, driver.globalContext);
    const firstSelection = await adopt(sequentialForward, 'acceptor');
    await drain();
    const sequentialFirst = await capture(
      'sequential edge before attempted closure',
      driver.globalContext,
      [sequentialForward.proposal, sequentialForward.acceptance, firstSelection],
      [sequentialForward],
      { requiredEdges: [[a, b]] },
    );
    sequentialFirst.cleanup = await clearSuccessful([sequentialForward], [firstSelection]);

    const reopenFirst = await adopt(sequentialForward, 'acceptor');
    const closeSequential = await adopt(sequentialReverse, 'acceptor');
    await drain();
    const sequential = await capture(
      'sequential closing-edge selection',
      driver.globalContext,
      [
        sequentialForward.proposal,
        sequentialForward.acceptance,
        sequentialReverse.proposal,
        sequentialReverse.acceptance,
        reopenFirst,
        closeSequential,
      ],
      [sequentialForward, sequentialReverse],
      { cyclePair: [a, b], requiredEdges: [[a, b]] },
    );
    sequential.cleanup = await clearSuccessful(
      [sequentialForward, sequentialReverse],
      [reopenFirst, closeSequential],
    );
    observations.push(sequentialFirst, sequential);

    const concurrentForward = await proposeAndAccept(a, b, driver.globalContext);
    const concurrentReverse = await proposeAndAccept(b, a, driver.globalContext);
    const [concurrentOne, concurrentTwo] = await Promise.all([
      adopt(concurrentForward, 'editor'),
      adopt(concurrentReverse, 'acceptor'),
    ]);
    await drain();
    const concurrent = await capture(
      'concurrently adopted opposite edges on distinct native partitions',
      driver.globalContext,
      [
        concurrentForward.proposal,
        concurrentForward.acceptance,
        concurrentReverse.proposal,
        concurrentReverse.acceptance,
        concurrentOne,
        concurrentTwo,
        { partitions: [...partitions].sort((left, right) => left - right) },
      ],
      [concurrentForward, concurrentReverse],
      { cyclePair: [a, b], eitherEdges: [[a, b], [b, a]] },
    );
    concurrent.cleanup = await clearSuccessful(
      [concurrentForward, concurrentReverse],
      [concurrentOne, concurrentTwo],
    );
    observations.push(concurrent);

    const inherited = await proposeAndAccept(a, b, driver.globalContext);
    const communityReverse = await proposeAndAccept(b, a, community);
    const globalSelection = await adopt(inherited, 'acceptor');
    await drain();
    const globalBase = await capture(
      'Global base before community reverse selection',
      driver.globalContext,
      [inherited.proposal, inherited.acceptance, globalSelection],
      [inherited],
      { requiredEdges: [[a, b]] },
    );
    const communitySelection = await adopt(communityReverse, 'acceptor');
    await drain();
    const communityOverlay = await capture(
      'inherited Global edge plus community Context reverse edge',
      community,
      [communityReverse.proposal, communityReverse.acceptance, communitySelection],
      [inherited, communityReverse],
      { cyclePair: [a, b], requiredEdges: [[a, b]] },
    );
    const suppression = await suppressGlobalEdge(a, b);
    await drain();
    const suppressedView = await capture(
      'community suppression removes the inherited Global edge',
      community,
      [suppression],
      [inherited, communityReverse],
      { requiredEdges: [[b, a]], forbiddenEdges: [[a, b]] },
    );
    const suppressionHead = suppression.body.adoption as { head?: unknown } | undefined;
    if (operationSucceeded(suppression)) {
      if (typeof suppressionHead?.head !== 'number')
        throw new Error(`${suppression.operation}: adoption head missing from ${JSON.stringify(suppression.body)}`);
      const restore = await driver.request(
        'acceptor',
        'POST',
        `/v1/subjects/${a}:adopt`,
        {
          context: community,
          property: FOLLOWS,
          target: b,
          mode: 'inherit',
          expected_head: suppressionHead.head,
          selection: [],
        },
        idempotencyHeaders(),
      );
      const restoreEvidence = evidence(restore, `restore inherited ${a} ${FOLLOWS} ${b} in ${community}`);
      if (!operationSucceeded(restoreEvidence))
        throw new Error(`${restoreEvidence.operation}: ${restore.status} ${JSON.stringify(restore.body)}`);
      recordSelectionHead(a, b, community, restoreEvidence);
      communityOverlay.cleanup = [restoreEvidence];
    }
    communityOverlay.cleanup.push(
      ...(await clearSuccessful([communityReverse, inherited], [communitySelection, globalSelection])),
    );
    suppressedView.cleanup = [...communityOverlay.cleanup];
    observations.push(globalBase, communityOverlay, suppressedView);

    const pathAB = await proposeAndAccept(a, b, driver.globalContext);
    const pathBC = await proposeAndAccept(b, c, driver.globalContext);
    const shortcutAC = await proposeAndAccept(a, c, driver.globalContext);
    const pathSelectionAB = await adopt(pathAB, 'acceptor');
    const pathSelectionBC = await adopt(pathBC, 'acceptor');
    const shortcutSelection = await adopt(shortcutAC, 'acceptor');
    await drain();
    const beforeMerge = await capture(
      'A to B to C path before endpoint merge',
      driver.globalContext,
      [pathSelectionAB, pathSelectionBC, shortcutSelection],
      [pathAB, pathBC, shortcutAC],
      { requiredEdges: [[a, b], [b, c], [a, c]] },
    );
    observations.push(beforeMerge);

    const mergeAdmin = new pg.Pool({ connectionString: driver.fixtures.runtime.databaseUrl, max: 2 });
    let mergeResult: Awaited<ReturnType<typeof mergeSubjects>> | null = null;
    try {
      const mergerId = newId(0x6d10);
      const real = await createRealAccess(mergeAdmin, { merger: mergerId }, ['subject:merge']);
      const access = real.access({ actions: new Map([['subject:merge', { anonymous: false }]]) });
      await real.grant({ route: 0, id: driver.globalContext }, 'merger', 'subject:merge');
      const deadline = Date.now() + 30_000;
      const actor = await access.authenticate(real.bearer('merger'), { pool: driver.fixtures.pool, deadline });
      if (actor.kind !== 'account') throw new Error('native merge authorization did not authenticate an account');
      const authorization = accessCommandAuthorization(
        access,
        actor,
        'subject:merge',
        { route: 0, id: driver.globalContext },
        { pool: driver.fixtures.pool, deadline },
        () => new Error('Denied subject:merge'),
      );
      const key = randomUUID();
      mergeResult = await mergeSubjects(driver.fixtures.pool, {
        subjects: [a, c],
        survivor: a,
        actor,
        idempotencyKey: key,
        digest: createHash('sha256').update(key).digest(),
        release: { digest: bundledDigest, release: bundledRelease },
        authorization,
        deadline,
      });
    } finally {
      await mergeAdmin.end();
    }
    if (mergeResult === null) throw new Error('authorized native mergeSubjects returned no outcome');
    await drain();
    const afterMerge = await capture(
      'A to B to C plus shortcut after merging A and C',
      driver.globalContext,
      [
        {
          operation: 'authorized native mergeSubjects',
          status: 200,
          body: mergeResult as unknown as Record<string, unknown>,
        },
      ],
      [pathAB, pathBC, shortcutAC],
      { cyclePair: [a, b], canonicalTogether: [a, c] },
    );
    observations.push(afterMerge);
  });

  return observations;
}
