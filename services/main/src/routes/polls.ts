import { Elysia, t } from 'elysia';
import { ID } from '../modules/work/activate.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable } from '../modules/access/admission.ts';
import { VoteIneligible, VotePolicyStale } from '../modules/vote/access.ts';
import { activateAllocation, approveBallot, changePollState, changeProxyRoute,
  invalidateBallot, preparePoll, setBallot,
  setHolderCharter, type AdmittedVote, type VoteDependencies } from '../modules/vote/admitted.ts';
import { PendingVoteWork, VoteConflict, VoteRejected, VoteStale, VoteUnavailable,
  digestOf } from '../modules/vote/graph.ts';
import { readBallot, readHolderCharter, readPoll, readProxyRoute, readResolution, readSeat,
  readTally } from '../modules/vote/read.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const seatClass = t.Union([t.Literal('person'), t.Literal('organization'), t.Literal('collective')]);
const optionRole = t.Union([t.Literal('approve'), t.Literal('reject'), t.Literal('abstain'), t.Literal('choice')]);
const noStore = { 'cache-control': 'no-store' };
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const pollIri = (id: string) => ID + id;

const commandResult = t.Object({ profile: t.Literal('poll-command-v1'), operation: t.String(),
  poll: native, component: t.String(), revision: t.String(), receipt: t.String(),
  sourcePosition: t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(), sequence: t.String() }),
  replayed: t.Boolean() });
const commandResponses = { 200: commandResult, 201: commandResult, 202: pendingOperation,
  ...writeProblems, 404: problemResult(404) };
const pollResult = t.Object({ profile: t.Literal('poll-snapshot-v1'), poll: native,
  body: native, state: t.Union([t.Literal('draft'), t.Literal('open'), t.Literal('closed'),
    t.Literal('finalized')]),
  electorateCharter: native, question: native, snapshot: t.Nullable(native),
  proposal: t.Nullable(native), proposalRevision: t.Nullable(native),
  opening: t.Nullable(native), issuedUnits: t.Nullable(t.Number()),
  entitlementCount: t.Nullable(t.Number()), seatCount: t.Nullable(t.Number()),
  countedUnits: t.Nullable(t.Number()), closesAt: t.Nullable(t.String()),
  charter: t.Object({ allocation: t.Boolean(), admittedSeatClasses: t.Array(seatClass),
    unitScale: t.Number(), countingUnit: t.String(), quorumThreshold: t.Number(),
    abstention: t.String(), ruleRevision: native, invalidation: t.String(),
    proxy: t.Union([t.Literal('disabled'), t.Literal('one-hop')]), holderOverride: t.Boolean(),
    passNumerator: t.Number(), passDenominator: t.Number(), digest }),
  options: t.Array(t.Object({ option: native, key: t.String(), role: optionRole })) });
const tallyResult = t.Object({ profile: t.Literal('poll-tally-v1'), poll: native,
  state: t.String(), seatCount: t.Number(), countedUnits: t.Number(),
  castSeats: t.Number(), castUnits: t.Number(), abstainUnits: t.Number(),
  uncastUnits: t.Number(), options: t.Array(t.Object({ key: t.String(), role: optionRole,
    units: t.Number(), seats: t.Number() })) });
const resolutionResult = t.Object({ profile: t.Literal('poll-resolution-v1'), resolution: native,
  outcome: t.Union([t.Literal('adopted'), t.Literal('rejected'), t.Literal('no-quorum')]),
  winningOption: t.Nullable(native), proposalRevision: t.Nullable(native), effectDigest: t.Nullable(digest) });
const ballotResult = t.Object({ profile: t.Literal('ballot-v1'), ballot: native,
  revision: native, predecessor: t.Nullable(native),
  availability: t.Union([t.Literal('cast'), t.Literal('withdrawn'), t.Literal('invalidated')]),
  countedUnits: t.Number(), digest,
  castRoute: t.Union([t.Literal('holder'), t.Literal('proxy'), t.Literal('override')]),
  proxyRoute: t.Nullable(native), shares: t.Array(t.Object({ option: native, units: t.Number() })) });
const holderCharterResult = t.Object({ profile: t.Literal('holder-charter-v1'), charter: native,
  revision: native, rule: t.String(), threshold: t.Nullable(t.Number()),
  aggregation: t.String(), digest });
const representativePolicyResult = t.Object({ profile: t.Literal('vote-representative-policy-v1'),
  id: uuid, revision: t.String(), holderCharterRevision: native,
  holderCharterDigest: digest, members: t.Array(t.Object({
    role: t.Union([t.Literal('designated'), t.Literal('backup'), t.Literal('approver')]),
    representationId: uuid, principalId: uuid })), replayed: t.Boolean() });
const ballotCandidate = t.Object({ expectedHead: t.Nullable(native),
  availability: t.Union([t.Literal('cast'), t.Literal('withdrawn')]),
  shares: t.Array(t.Object({ option: t.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }),
    units: t.Integer({ minimum: 1, maximum: 1_000_000 }) },
  { additionalProperties: false }), { maxItems: 64 }),
  internalPoll: t.Nullable(native) }, { additionalProperties: false });

export const openApiOperations = {
  '/v1/polls': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}': { get: { exposure: 'platform:institutional-voting', rateLimitFamily: 'read', bearer: true } },
  '/v1/polls/{poll}/tallies': { get: { exposure: 'platform:institutional-voting', rateLimitFamily: 'read', bearer: true } },
  '/v1/polls/{poll}/openings': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/closures': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/resolutions': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true },
    get: { exposure: 'platform:institutional-voting', rateLimitFamily: 'read', bearer: true } },
  '/v1/polls/{poll}/allocations': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/holder-charters': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/holder-charters/{entitlement}': { get: { exposure: 'platform:institutional-voting', rateLimitFamily: 'read', bearer: true } },
  '/v1/polls/{poll}/representative-policies': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/ballots': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/ballot-invalidations': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/proxies': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/polls/{poll}/proxies/{seat}': { get: { exposure: 'platform:institutional-voting', rateLimitFamily: 'read', bearer: true } },
  '/v1/polls/{poll}/ballots/{seat}': { get: { exposure: 'platform:institutional-voting', rateLimitFamily: 'read', bearer: true } },
  '/v1/polls/{poll}/mandate-approvals': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;

function deps(work: MainWorkDependencies): VoteDependencies | null {
  return work.votes ? { environment: work.environment, account: work.account, votes: work.votes } : null;
}

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && keyPattern.test(key) ? key : null;
}

function succeeded(result: AdmittedVote, operation: string, poll: string): Response {
  const receipt = result.receipt;
  return Response.json({ profile: 'poll-command-v1', operation, poll,
    component: receipt.component!, revision: receipt.revision!, receipt: receipt.receipt,
    sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
    replayed: result.admission.replayed }, { status: result.admission.replayed ? 200 : 201,
    headers: noStore });
}

function voteError(error: unknown): Response {
  if (error instanceof PendingVoteWork) return Response.json({ operationId: error.operationId,
    status: 'reconciling', phase: 'graph-outcome', result: null,
    retry: { allowed: true, afterMs: 1000 } }, { status: 202, headers: noStore });
  if (error instanceof VoteStale) return problem(409, 'stale_vote_head', 'Vote state changed');
  if (error instanceof VotePolicyStale) return problem(409, 'stale_policy_head', 'Representative policy changed');
  if (error instanceof VoteRejected) return problem(409, error.code, 'Vote command was rejected');
  if (error instanceof VoteIneligible) return problem(403, 'vote_ineligible', 'Vote policy member is ineligible');
  if (error instanceof AdmissionConflict || error instanceof VoteConflict) {
    return problem(409, 'idempotency_conflict', 'Operation key binds another intent');
  }
  if (error instanceof AdmissionDenied) return problem(403, 'authority_denied', 'Current vote authority is required');
  if (error instanceof VoteUnavailable) return problem(404, 'poll_unavailable', 'Poll or seat is unavailable');
  if (error instanceof AdmissionUnavailable) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
  return commandError(error);
}

/** Poll write/read template: Account assertion, exact Access admission, guarded graph receipt and bounded read. */
export function pollRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/polls', {
      body: t.Object({ profile: t.Literal('poll-prepare-v1'), poll: native, body: native,
        actingSubject: native, representationId: uuid, grantId: uuid,
        charter: t.Object({ ruleRevision: native, unitScale: t.Integer({ minimum: 1, maximum: 1_000_000 }),
          countingUnit: t.Union([t.Literal('weight'), t.Literal('seats'), t.Literal('persons')]),
          admittedSeatClasses: t.Array(seatClass, { minItems: 1, maxItems: 3, uniqueItems: true }),
          allocation: t.Boolean(), quorumThreshold: t.Integer({ minimum: 0, maximum: 1_000_000 }),
          abstention: t.Union([t.Literal('counts'), t.Literal('excluded')]),
          passNumerator: t.Integer({ minimum: 1, maximum: 1_000_000 }),
          passDenominator: t.Integer({ minimum: 1, maximum: 1_000_000 }),
          invalidation: t.Union([t.Literal('none'), t.Literal('declared')]),
          proxy: t.Optional(t.Union([t.Literal('disabled'), t.Literal('one-hop')])),
          holderOverride: t.Optional(t.Boolean()) }, { additionalProperties: false }),
        question: t.Object({ text: t.String({ minLength: 1, maxLength: 500 }),
          language: t.String({ minLength: 2, maxLength: 32 }) }, { additionalProperties: false }),
        options: t.Array(t.Object({ key: t.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }),
          role: optionRole, label: t.String({ minLength: 1, maxLength: 200 }) },
        { additionalProperties: false }), { minItems: 2, maxItems: 64 }),
        entitlements: t.Array(t.Object({ holder: native, seatClass,
          units: t.Integer({ minimum: 1, maximum: 1_000_000 }) },
        { additionalProperties: false }), { minItems: 1, maxItems: 1000 }),
        proposal: t.Optional(t.Object({ proposal: native, effectDigest: digest, effectTarget: native,
          effectCapability: t.String({ pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$' }),
          expectedTargetState: digest }, { additionalProperties: false })),
      }, { additionalProperties: false }),
      response: commandResponses,
    }, async ({ request, body }) => {
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      const vote = deps(work);
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      try { return succeeded(await preparePoll(vote, request, { ...body, idempotencyKey: key }),
        'poll.prepare', body.poll); }
      catch (error) { return voteError(error); }
    })
    .get('/v1/polls/:poll', { params: t.Object({ poll: uuid }),
      response: { 200: pollResult, ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        await work.account.verify(request, ['vote:read']);
        return Response.json({ profile: 'poll-snapshot-v1',
          ...await readPoll(work.environment, pollIri(params.poll)) }, { headers: noStore });
      } catch (error) { return voteError(error); }
    })
    .get('/v1/polls/:poll/tallies', { params: t.Object({ poll: uuid }),
      response: { 200: tallyResult, ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        await work.account.verify(request, ['vote:read']);
        return Response.json({ profile: 'poll-tally-v1',
          ...await readTally(work.environment, pollIri(params.poll)) }, { headers: noStore });
      } catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/openings', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('poll-opening-v1'), actingSubject: native,
        representationId: uuid, grantId: uuid, closesAt: t.Optional(t.String({ format: 'date-time' })) },
      { additionalProperties: false }), response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await changePollState(vote, request,
        { poll, actingSubject: body.actingSubject, representationId: body.representationId,
          grantId: body.grantId, closesAt: body.closesAt, idempotencyKey: key }, 'poll.open'), 'poll.open', poll); }
      catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/closures', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('poll-closure-v1'), actingSubject: native,
        representationId: uuid, grantId: uuid }, { additionalProperties: false }),
      response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await changePollState(vote, request,
        { poll, actingSubject: body.actingSubject, representationId: body.representationId,
          grantId: body.grantId, idempotencyKey: key }, 'poll.close'), 'poll.close', poll); }
      catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/resolutions', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('poll-resolution-v1'), actingSubject: native,
        representationId: uuid, grantId: uuid }, { additionalProperties: false }),
      response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await changePollState(vote, request,
        { poll, actingSubject: body.actingSubject, representationId: body.representationId,
          grantId: body.grantId, idempotencyKey: key }, 'resolution.finalize'),
      'resolution.finalize', poll); }
      catch (error) { return voteError(error); }
    })
    .get('/v1/polls/:poll/resolutions', { params: t.Object({ poll: uuid }),
      response: { 200: resolutionResult, ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        await work.account.verify(request, ['vote:read']);
        const result = await readResolution(work.environment, pollIri(params.poll));
        return result ? Response.json({ profile: 'poll-resolution-v1', ...result }, { headers: noStore })
          : problem(404, 'resolution_unavailable', 'Poll resolution is unavailable');
      } catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/allocations', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('poll-allocation-v1'), rootEntitlement: native,
        holder: native, representationId: uuid,
        leaves: t.Array(t.Object({ holder: native, seatClass,
          units: t.Integer({ minimum: 1, maximum: 1_000_000 }) },
        { additionalProperties: false }), { minItems: 1, maxItems: 1024 }) },
      { additionalProperties: false }), response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await activateAllocation(vote, request,
        { poll, rootEntitlement: body.rootEntitlement, holder: body.holder,
          representationId: body.representationId, leaves: body.leaves, idempotencyKey: key }),
      'allocation.activate', poll); }
      catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/holder-charters', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('holder-charter-v1'), entitlement: native,
        holder: native, expectedHead: t.Nullable(native), ruleRevision: native,
        rule: t.Union([t.Literal('designated'), t.Literal('any-admitted'),
          t.Literal('k-of-n'), t.Literal('internal-decision')]),
        threshold: t.Nullable(t.Integer({ minimum: 1, maximum: 64 })),
        aggregation: t.Union([t.Literal('whole'), t.Literal('proportional')]),
        representationId: uuid }, { additionalProperties: false }),
      response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await setHolderCharter(vote, request,
        { poll, entitlement: body.entitlement, holder: body.holder,
          expectedHead: body.expectedHead, ruleRevision: body.ruleRevision,
          rule: body.rule, threshold: body.threshold, aggregation: body.aggregation,
          representationId: body.representationId, idempotencyKey: key }), 'holder-charter.set', poll); }
      catch (error) { return voteError(error); }
    })
    .get('/v1/polls/:poll/holder-charters/:entitlement',
      { params: t.Object({ poll: uuid, entitlement: uuid }),
        response: { 200: holderCharterResult, ...authorizedReadProblems } },
      async ({ request, params }) => {
        try {
          await work.account.verify(request, ['vote:read']);
          const charter = await readHolderCharter(work.environment, pollIri(params.poll),
            pollIri(params.entitlement));
          return charter ? Response.json({ profile: 'holder-charter-v1', ...charter }, { headers: noStore })
            : problem(404, 'holder_charter_unavailable', 'Holder charter is unavailable');
        } catch (error) { return voteError(error); }
      })
    .post('/v1/polls/:poll/representative-policies', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('vote-representative-policy-v1'),
        entitlement: native, holder: native, representationId: uuid,
        expectedRevision: t.Nullable(t.String({ pattern: '^[1-9][0-9]*$' })),
        holderCharterRevision: native,
        members: t.Array(t.Object({ role: t.Union([t.Literal('designated'),
          t.Literal('backup'), t.Literal('approver')]), representationId: uuid },
        { additionalProperties: false }), { minItems: 1, maxItems: 256 }) },
      { additionalProperties: false }),
      response: { 200: representativePolicyResult, 201: representativePolicyResult,
        ...writeProblems, 404: problemResult(404) } }, async ({ request, params, body }) => {
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!work.votes) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      try {
        const poll = pollIri(params.poll);
        const view = await readPoll(work.environment, poll);
        const seat = await readSeat(work.environment, poll, body.entitlement);
        if (seat.kind !== 'root' || seat.holder !== body.holder) throw new VoteRejected('not_seat_holder');
        const charter = await readHolderCharter(work.environment, poll, body.entitlement);
        if (!charter || charter.revision !== body.holderCharterRevision) {
          throw new VoteStale('holder charter changed');
        }
        const principal = await work.account.verify(request, ['vote:manage']);
        const change = { holder: body.holder, body: view.body,
          representationId: body.representationId, expectedRevision: body.expectedRevision,
          holderCharterRevision: charter.revision, holderCharterDigest: charter.digest,
          members: body.members };
        const result = await work.votes.setPolicy(principal, change, key,
          digestOf({ poll, entitlement: body.entitlement, change }));
        return Response.json({ profile: 'vote-representative-policy-v1',
          ...result.policy, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: noStore });
      } catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/ballots', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('ballot-v1'), seat: native, holder: native,
        proxySubject: t.Optional(native), proxyRoute: t.Optional(native),
        representationId: uuid, approvals: t.Array(native, { maxItems: 64 }),
        ...ballotCandidate.properties }, { additionalProperties: false }),
      response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await setBallot(vote, request, { poll, seat: body.seat,
        holder: body.holder, representationId: body.representationId,
        proxySubject: body.proxySubject, proxyRoute: body.proxyRoute,
        approvals: body.approvals, expectedHead: body.expectedHead,
        availability: body.availability, shares: body.shares, internalPoll: body.internalPoll,
        idempotencyKey: key }), body.availability === 'cast' ? 'ballot.cast' : 'ballot.withdraw', poll); }
      catch (error) { return voteError(error); }
    })
    .get('/v1/polls/:poll/ballots/:seat', { params: t.Object({ poll: uuid, seat: uuid }),
      response: { 200: ballotResult, ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        await work.account.verify(request, ['vote:read']);
        const ballot = await readBallot(work.environment, pollIri(params.poll), pollIri(params.seat));
        return ballot ? Response.json({ profile: 'ballot-v1', ...ballot }, { headers: noStore })
          : problem(404, 'ballot_unavailable', 'Ballot is unavailable');
      } catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/ballot-invalidations', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('ballot-invalidation-v1'), seat: native,
        holder: native, expectedHead: native, ruleRevision: native, evidenceDigest: digest,
        actingSubject: native, representationId: uuid, grantId: uuid },
      { additionalProperties: false }), response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await invalidateBallot(vote, request, { poll, seat: body.seat,
        holder: body.holder, expectedHead: body.expectedHead, ruleRevision: body.ruleRevision,
        evidenceDigest: body.evidenceDigest, actingSubject: body.actingSubject,
        representationId: body.representationId, grantId: body.grantId,
        idempotencyKey: key }), 'ballot.invalidate', poll); }
      catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/proxies', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('ballot-proxy-v1'), action: t.Union([
        t.Literal('designate'), t.Literal('revoke')]), seat: native, holder: native,
        proxy: native, expectedHead: t.Nullable(native), representationId: uuid },
      { additionalProperties: false }), response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      const operation = body.action === 'designate' ? 'proxy.designate' : 'proxy.revoke';
      try { return succeeded(await changeProxyRoute(vote, request, { poll,
        seat: body.seat, holder: body.holder, proxy: body.proxy, expectedHead: body.expectedHead,
        representationId: body.representationId, idempotencyKey: key }, operation), operation, poll); }
      catch (error) { return voteError(error); }
    })
    .get('/v1/polls/:poll/proxies/:seat', { params: t.Object({ poll: uuid, seat: uuid }),
      response: { 200: t.Object({ profile: t.Literal('ballot-proxy-v1'), route: native,
        revision: native, holder: native, proxy: native,
        sourceEntitlement: native, state: t.Union([t.Literal('active'), t.Literal('revoked')]) }),
        ...authorizedReadProblems } }, async ({ request, params }) => {
      try {
        await work.account.verify(request, ['vote:read']);
        const route = await readProxyRoute(work.environment, pollIri(params.poll), pollIri(params.seat));
        return route ? Response.json({ profile: 'ballot-proxy-v1', ...route }, { headers: noStore })
          : problem(404, 'proxy_route_unavailable', 'Proxy route is unavailable');
      } catch (error) { return voteError(error); }
    })
    .post('/v1/polls/:poll/mandate-approvals', { params: t.Object({ poll: uuid }),
      body: t.Object({ profile: t.Literal('mandate-approval-v1'), seat: native,
        holder: native, representationId: uuid, candidate: ballotCandidate },
      { additionalProperties: false }), response: commandResponses }, async ({ request, params, body }) => {
      const key = idempotencyKey(request), vote = deps(work);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      if (!vote) return problem(503, 'vote_owner_unavailable', 'Vote owner is unavailable');
      const poll = pollIri(params.poll);
      try { return succeeded(await approveBallot(vote, request, { poll, seat: body.seat,
        holder: body.holder, representationId: body.representationId,
        candidate: body.candidate, idempotencyKey: key }), 'ballot.approve', poll); }
      catch (error) { return voteError(error); }
    });
}
