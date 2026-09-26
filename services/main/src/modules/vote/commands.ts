import { profileValidations } from '../../infrastructure/profile.ts';
import { RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { SeatClass, VoteAdmission, VotePolicyHead } from './access.ts';
import { CURRENT, DEF, REVISIONS, VoteRejected, VoteStale, dateTime, digestOf, executeVoteCommand,
  langText, newId, voteId } from './graph.ts';
import { activeProxyRoutes, ballotComponent, holderCharterComponent, optionRoleTerm, proxyRouteComponent,
  readBallot, readHolderCharter, readPoll, readProxyRoute, readResolution, readSeat, readTally,
  ruleTerm, seatClassTerm, type Aggregation, type HolderCharterView, type MandateRule,
  type OptionRole, type PollView, type SeatView } from './read.ts';

/**
 * The vote operations. Each exported `prepare*` function performs the bounded
 * reads and pure checks that need no admission; each `dispatch*` function runs
 * after admission and commits one guarded graph command. Guards restate every
 * frozen-state expectation, so a concurrent change fails the TDB2 transaction.
 */

const G = (graph: string, body: string) => `GRAPH ${iri(graph)} { ${body} }`;
const graphs = [CURRENT, REVISIONS];
const operationIri = () => `urn:rezics:operation:${digestOf(newId())}`;
const now = () => new Date().toISOString();
const intIn = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

// ---------------------------------------------------------------- poll.prepare

export interface ElectorateCharterInput {
  ruleRevision: string;
  unitScale: number;
  countingUnit: 'weight' | 'seats' | 'persons';
  admittedSeatClasses: SeatClass[];
  allocation: boolean;
  quorumThreshold: number;
  abstention: 'counts' | 'excluded';
  passNumerator: number;
  passDenominator: number;
  invalidation: 'none' | 'declared';
  proxy?: 'disabled' | 'one-hop';
  holderOverride?: boolean;
}

export interface PreparePollIntent {
  poll: string;
  body: string;
  charter: ElectorateCharterInput;
  question: { text: string; language: string };
  options: { key: string; role: OptionRole; label: string }[];
  entitlements: { holder: string; seatClass: SeatClass; units: number }[];
  proposal?: { proposal: string; effectDigest: string; effectTarget: string;
    effectCapability: string; expectedTargetState: string };
}

/** Pure intent checks; `slots` are the Access counting identities in entitlement order. */
export function checkPreparePoll(intent: PreparePollIntent, slots: readonly string[]): void {
  const keys = new Set(intent.options.map(option => option.key));
  if (intent.options.length < 2 || keys.size !== intent.options.length
    || intent.options.filter(option => option.role === 'abstain').length > 1) {
    throw new VoteRejected('invalid_options');
  }
  if (!intent.entitlements.length || intent.entitlements.length > 1000
    || intent.entitlements.some(item => !intIn(item.units, 1, 1_000_000))) {
    throw new VoteRejected('invalid_entitlements');
  }
  const admitted = new Set(intent.charter.admittedSeatClasses);
  if (!admitted.size || intent.entitlements.some(item => !admitted.has(item.seatClass))) {
    throw new VoteRejected('seat_class_not_admitted');
  }
  if (new Set(slots).size !== slots.length) throw new VoteRejected('duplicate_counting_identity');
  if (intent.charter.proxy !== 'one-hop' && intent.charter.holderOverride) {
    throw new VoteRejected('holder_override_requires_proxy');
  }
  if (intent.proposal && (!/^[0-9a-f]{64}$/.test(intent.proposal.effectDigest)
    || !/^[0-9a-f]{64}$/.test(intent.proposal.expectedTargetState)
    || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(intent.proposal.effectCapability)
    || intent.proposal.effectCapability.startsWith('governance.')
    || intent.proposal.proposal === intent.poll)) throw new VoteRejected('invalid_proposal_effect');
}

export function electorateCharterDigest(charter: ElectorateCharterInput): string {
  return digestOf({ ...charter, proxy: charter.proxy ?? 'disabled',
    holderOverride: charter.holderOverride ?? false,
    admittedSeatClasses: [...charter.admittedSeatClasses].sort() });
}

export async function dispatchPreparePoll(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: PreparePollIntent, slots: readonly string[]): Promise<boolean> {
  const { poll, charter } = intent;
  const component = voteId('electorate-charter', poll);
  const revision = newId();
  const question = newId();
  const snapshot = newId();
  const proposalRevision = intent.proposal ? newId() : null;
  const operation = operationIri();
  const at = now();
  const options = intent.options.map(option => ({ ...option, iri: newId() }));
  const entitlements = intent.entitlements.map((item, index) =>
    ({ ...item, slot: slots[index]!, iri: voteId('entitlement', poll, slots[index]!) }));
  const issued = entitlements.reduce((sum, item) => sum + item.units, 0);
  const term = { weight: 'WeightUnits', seats: 'SeatCount', persons: 'PersonCount' }[charter.countingUnit];
  const insert = `${G(CURRENT, `
    ${iri(component)} a rv:VotingCharter ; rv:governingBody ${iri(intent.body)} ;
      rv:charterKind rv:ElectorateCharter ; rv:charterHead ${iri(revision)} ; rv:poll ${iri(poll)} .
    ${iri(poll)} a rv:Poll ; rv:governingBody ${iri(intent.body)} ; rv:electorateCharter ${iri(revision)} ;
      rv:questionHead ${iri(question)} ; rv:pollState rv:PollDraft ;
      rv:electorateSnapshot ${iri(snapshot)}
      ${proposalRevision ? `; rv:proposalRevision ${iri(proposalRevision)}` : ''} .
    ${intent.proposal ? `${iri(intent.proposal.proposal)} a rv:Proposal ; rv:governingBody ${iri(intent.body)} ;
      rv:proposalHead ${iri(proposalRevision!)} ; rv:proposalState rv:ProposalOpen .` : ''}`)}
    ${G(REVISIONS, `
    ${iri(revision)} a rv:VotingCharterRevision, rv:ElectorateCharterRevision ; rv:charter ${iri(component)} ;
      rv:ruleRevision ${iri(charter.ruleRevision)} ; rv:charterDigest ${lit(electorateCharterDigest(charter))} ;
      rv:operation ${iri(operation)} ; rv:revisedAt ${dateTime(at)} ; rv:unitScale ${charter.unitScale} ;
      rv:countingUnit rv:${term} ;
      ${charter.admittedSeatClasses.map(value => `rv:admittedSeatClass rv:${seatClassTerm[value]} ;`).join(' ')}
      rv:personCountingBasis rv:AccessPrincipalCounting ;
      rv:allocationPolicy rv:${charter.allocation ? 'ExplicitSeatAllocation' : 'AllocationDisabled'} ;
      rv:proxyPolicy rv:${charter.proxy === 'one-hop' ? 'OneHopProxy' : 'ProxyDisabled'} ;
      rv:holderOverridePolicy rv:${charter.holderOverride ? 'HolderOverrideAllowed' : 'HolderOverrideDenied'} ;
      rv:proxyRoutingPolicy rv:FrozenAtOpening ; rv:quorumThreshold ${charter.quorumThreshold} ;
      rv:abstentionPolicy rv:${charter.abstention === 'counts' ? 'AbstentionCountsForQuorum' : 'AbstentionExcludedFromQuorum'} ;
      rv:uncastPolicy rv:UncastNotCounted ; rv:passNumerator ${charter.passNumerator} ;
      rv:passDenominator ${charter.passDenominator} ;
      rv:invalidationPolicy rv:${charter.invalidation === 'declared' ? 'DeclaredInvalidationDecision' : 'NoBallotInvalidation'} .
    ${iri(question)} a rv:PollQuestionRevision ; rv:poll ${iri(poll)} ;
      rv:question ${langText(intent.question.text, intent.question.language)} ;
      rv:questionDigest ${lit(digestOf({ question: intent.question, options: intent.options }))} ;
      rv:optionCount ${options.length} ; rv:operation ${iri(operation)} ; rv:revisedAt ${dateTime(at)} .
    ${options.map(option => `${iri(option.iri)} a rv:PollOption ; rv:questionRevision ${iri(question)} ;
      rv:optionKey ${lit(option.key)} ; rv:optionRole rv:${optionRoleTerm[option.role]} ;
      rv:label ${langText(option.label, intent.question.language)} .`).join('\n')}
    ${iri(snapshot)} a rv:ElectorateSnapshot ; rv:poll ${iri(poll)} ; rv:electorateCharter ${iri(revision)} ;
      rv:entitlementCount ${entitlements.length} ; rv:issuedUnits ${issued} ;
      rv:snapshotDigest ${lit(digestOf(entitlements.map(item => [item.slot, item.holder, item.seatClass, item.units]).sort()))} ;
      rv:operation ${iri(operation)} ; rv:preparedAt ${dateTime(at)} .
    ${intent.proposal ? `${iri(proposalRevision!)} a rv:ProposalRevision ;
      rv:proposal ${iri(intent.proposal.proposal)} ; rv:ruleRevision ${iri(charter.ruleRevision)} ;
      rv:effectDigest ${lit(intent.proposal.effectDigest)} ;
      rv:effectTarget ${iri(intent.proposal.effectTarget)} ;
      rv:effectCapability ${lit(intent.proposal.effectCapability)} ;
      rv:expectedTargetState ${lit(intent.proposal.expectedTargetState)} ;
      rv:operation ${iri(operation)} ; rv:revisedAt ${dateTime(at)} .` : ''}
    ${entitlements.map(item => `${iri(item.iri)} a rv:SourceEntitlement, rv:VotingSeat ;
      rv:electorateSnapshot ${iri(snapshot)} ; rv:poll ${iri(poll)} ; rv:holder ${iri(item.holder)} ;
      rv:seatClass rv:${seatClassTerm[item.seatClass]} ; rv:countingSlot ${iri(item.slot)} ;
      rv:issuedUnits ${item.units} ; rv:operation ${iri(operation)} .`).join('\n')}`)}`;
  const where = `FILTER NOT EXISTS { ${G(CURRENT, `${iri(poll)} ?p0 ?o0`)} }
    FILTER NOT EXISTS { ${G(CURRENT, `${iri(component)} ?p1 ?o1`)} }
    ${intent.proposal ? `FILTER NOT EXISTS { ${G(CURRENT, `${iri(intent.proposal.proposal)} ?p2 ?o2`)} }` : ''}`;
  const validations = [
    ...await profileValidations(env.fuseki, 'charter-revision-v1', [
      { shape: `${DEF}charter-revision-v1/charter-shape`, focus: [component], graphs },
      { shape: `${DEF}charter-revision-v1/electorate-revision-shape`, focus: [revision], graphs }]),
    ...await profileValidations(env.fuseki, 'poll-snapshot-v1', [
      { shape: `${DEF}poll-snapshot-v1/poll-shape`, focus: [poll], graphs },
      { shape: `${DEF}poll-snapshot-v1/question-shape`, focus: [question], graphs },
      { shape: `${DEF}poll-snapshot-v1/option-shape`, focus: options.map(option => option.iri), graphs },
      { shape: `${DEF}poll-snapshot-v1/snapshot-shape`, focus: [snapshot], graphs },
      { shape: `${DEF}poll-snapshot-v1/entitlement-shape`, focus: entitlements.map(item => item.iri), graphs }]),
    ...(intent.proposal ? await profileValidations(env.fuseki, 'proposal-v1', [
      { shape: `${DEF}proposal-v1/proposal-shape`, focus: [intent.proposal.proposal], graphs },
      { shape: `${DEF}proposal-v1/revision-shape`, focus: [proposalRevision!], graphs }]) : []),
  ];
  return executeVoteCommand(env, { admission, validations, insert, where, component: poll, revision: snapshot,
    operation, event: 'PollPreparedEvent' });
}

// ----------------------------------------------------------- holder-charter.set

export interface HolderCharterIntent {
  poll: string;
  entitlement: string;
  holder: string;
  expectedHead: string | null;
  ruleRevision: string;
  rule: MandateRule;
  threshold: number | null;
  aggregation: Aggregation;
}

export async function checkHolderCharter(env: WorkActivationEnvironment, intent: HolderCharterIntent) {
  if ((intent.rule === 'k-of-n') !== (intent.threshold !== null)
    || (intent.threshold !== null && !intIn(intent.threshold, 1, 64))) {
    throw new VoteRejected('invalid_approval_threshold');
  }
  const poll = await readPoll(env, intent.poll);
  if (poll.state !== 'draft') throw new VoteRejected('poll_not_draft');
  const seat = await readSeat(env, intent.poll, intent.entitlement);
  if (seat.kind !== 'root' || seat.holder !== intent.holder) throw new VoteRejected('not_seat_holder');
  const current = await readHolderCharter(env, intent.poll, intent.entitlement);
  if ((current?.revision ?? null) !== intent.expectedHead) throw new VoteStale('holder charter head is stale');
  return { poll, seat };
}

export function holderCharterDigest(intent: HolderCharterIntent): string {
  return digestOf({ poll: intent.poll, entitlement: intent.entitlement, rule: intent.rule,
    threshold: intent.threshold, aggregation: intent.aggregation, ruleRevision: intent.ruleRevision });
}

export async function dispatchHolderCharter(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: HolderCharterIntent): Promise<boolean> {
  const component = holderCharterComponent(intent.poll, intent.entitlement);
  const revision = newId();
  const operation = operationIri();
  const prior = intent.expectedHead;
  const insert = `${G(CURRENT, `${iri(component)} a rv:VotingCharter ; rv:governingBody ${iri(intent.holder)} ;
      rv:charterKind rv:HolderCharter ; rv:charterHead ${iri(revision)} ; rv:poll ${iri(intent.poll)} ;
      rv:sourceEntitlement ${iri(intent.entitlement)} .`)}
    ${G(REVISIONS, `${iri(revision)} a rv:VotingCharterRevision, rv:HolderCharterRevision ;
      rv:charter ${iri(component)} ; ${prior ? `rv:predecessor ${iri(prior)} ;` : ''}
      rv:ruleRevision ${iri(intent.ruleRevision)} ; rv:charterDigest ${lit(holderCharterDigest(intent))} ;
      rv:operation ${iri(operation)} ; rv:revisedAt ${dateTime(now())} ;
      rv:mandateRule rv:${ruleTerm[intent.rule]} ;
      ${intent.threshold !== null ? `rv:approvalThreshold ${intent.threshold} ;` : ''}
      rv:aggregationMode rv:${intent.aggregation === 'proportional' ? 'ProportionalSplit' : 'WholeBallot'} .`)}`;
  const where = `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollDraft .`)}
    ${G(REVISIONS, `${iri(intent.entitlement)} a rv:SourceEntitlement ; rv:poll ${iri(intent.poll)} ;
      rv:holder ${iri(intent.holder)} .`)}
    ${prior ? G(CURRENT, `${iri(component)} rv:charterHead ${iri(prior)} .`)
    : `FILTER NOT EXISTS { ${G(CURRENT, `${iri(component)} ?p ?o`)} }`}`;
  const validations = await profileValidations(env.fuseki, 'charter-revision-v1', [
    { shape: `${DEF}charter-revision-v1/charter-shape`, focus: [component], graphs },
    { shape: `${DEF}charter-revision-v1/holder-revision-shape`, focus: [revision], graphs }]);
  return executeVoteCommand(env, { admission, validations, insert, where, component, revision, operation,
    remove: prior ? G(CURRENT, `${iri(component)} rv:charterHead ${iri(prior)} .`) : undefined,
    event: 'HolderCharterChangedEvent' });
}

// ----------------------------------------------------------- allocation.activate

export interface AllocationIntent {
  poll: string;
  rootEntitlement: string;
  holder: string;
  leaves: { holder: string; seatClass: SeatClass; units: number }[];
}

export interface PlannedLeaf { holder: string; seatClass: SeatClass; units: number; slot: string; residual: boolean }

/** Conserve the root's exact units: deduplicate one identity reached twice, keep the residual with the root holder. */
export function planAllocation(poll: PollView, root: SeatView, intent: AllocationIntent,
  slots: readonly string[]): PlannedLeaf[] {
  if (!poll.charter.allocation) throw new VoteRejected('allocation_disabled');
  if (poll.state !== 'draft') throw new VoteRejected('poll_not_draft');
  if (root.kind !== 'root' || root.holder !== intent.holder) throw new VoteRejected('not_seat_holder');
  if (!root.counted) throw new VoteStale('root entitlement is already allocated');
  const admitted = new Set(poll.charter.admittedSeatClasses);
  const bySlot = new Map<string, PlannedLeaf>();
  intent.leaves.forEach((leaf, index) => {
    if (!intIn(leaf.units, 1, 1_000_000)) throw new VoteRejected('invalid_leaf_units');
    if (!admitted.has(leaf.seatClass)) throw new VoteRejected('seat_class_not_admitted');
    const slot = slots[index]!;
    if (slot === root.countingSlot) throw new VoteRejected('self_allocation');
    const existing = bySlot.get(slot);
    if (existing && (existing.units !== leaf.units || existing.seatClass !== leaf.seatClass)) {
      throw new VoteRejected('conflicting_leaf');
    }
    if (!existing) bySlot.set(slot, { ...leaf, slot, residual: false });
  });
  const leaves = [...bySlot.values()];
  const allocated = leaves.reduce((sum, leaf) => sum + leaf.units, 0);
  if (!leaves.length || allocated > root.units) throw new VoteRejected('units_not_conserved');
  if (allocated < root.units) {
    leaves.push({ holder: root.holder, seatClass: root.seatClass, units: root.units - allocated,
      slot: root.countingSlot, residual: true });
  }
  if (leaves.length > 1024) throw new VoteRejected('too_many_leaves');
  return leaves;
}

export async function dispatchAllocation(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: AllocationIntent, root: SeatView, leaves: readonly PlannedLeaf[]): Promise<boolean> {
  const plan = newId();
  const activation = voteId('activation', intent.poll, intent.rootEntitlement);
  const operation = operationIri();
  const at = now();
  const placed = leaves.map(leaf => ({ ...leaf, iri: voteId('leaf', plan, leaf.slot) }));
  const allocated = placed.filter(leaf => !leaf.residual).reduce((sum, leaf) => sum + leaf.units, 0);
  const insert = G(REVISIONS, `
    ${iri(plan)} a rv:AllocationPlan ; rv:poll ${iri(intent.poll)} ; rv:rootEntitlement ${iri(intent.rootEntitlement)} ;
      rv:leafCount ${placed.length} ; rv:allocatedUnits ${allocated} ; rv:residualUnits ${root.units - allocated} ;
      rv:planDigest ${lit(digestOf(placed.map(leaf => [leaf.slot, leaf.units, leaf.residual]).sort()))} ;
      rv:operation ${iri(operation)} ; rv:preparedAt ${dateTime(at)} .
    ${placed.map(leaf => `${iri(leaf.iri)} a rv:AllocationLeaf, rv:VotingSeat ; rv:allocationPlan ${iri(plan)} ;
      rv:sourceEntitlement ${iri(intent.rootEntitlement)} ; rv:holder ${iri(leaf.holder)} ;
      rv:seatClass rv:${seatClassTerm[leaf.seatClass]} ; rv:leafKind rv:${leaf.residual ? 'ResidualLeaf' : 'AllocatedLeaf'} ;
      rv:countingSlot ${iri(leaf.slot)} ; rv:leafUnits ${leaf.units} .`).join('\n')}
    ${iri(activation)} a rv:AllocationActivation ; rv:poll ${iri(intent.poll)} ; rv:allocationPlan ${iri(plan)} ;
      rv:rootEntitlement ${iri(intent.rootEntitlement)} ; rv:operation ${iri(operation)} ; rv:activatedAt ${dateTime(at)} .`);
  const where = `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollDraft .`)}
    ${G(REVISIONS, `${iri(intent.rootEntitlement)} a rv:SourceEntitlement ; rv:poll ${iri(intent.poll)} ;
      rv:holder ${iri(intent.holder)} ; rv:issuedUnits ${root.units} .`)}
    FILTER NOT EXISTS { ${G(REVISIONS, `?active a rv:AllocationActivation ; rv:poll ${iri(intent.poll)} ;
      rv:rootEntitlement ${iri(intent.rootEntitlement)} .`)} }
    FILTER NOT EXISTS { ${G(CURRENT, `?route a rv:ProxyRoute ; rv:poll ${iri(intent.poll)} ;
      rv:seat ${iri(intent.rootEntitlement)} ; rv:routeHead ?routeHead .`)}
      ${G(REVISIONS, `?routeHead rv:routeState rv:RouteActive .`)} }
    FILTER NOT EXISTS { ${G(REVISIONS, `VALUES ?newSlot { ${placed.map(leaf => iri(leaf.slot)).join(' ')} }
      ?existing rv:countingSlot ?newSlot .
      FILTER(?existing != ${iri(intent.rootEntitlement)})`)} }`;
  const validations = await profileValidations(env.fuseki, 'poll-allocation-v1', [
    { shape: `${DEF}poll-allocation-v1/plan-shape`, focus: [plan], graphs },
    { shape: `${DEF}poll-allocation-v1/leaf-shape`, focus: placed.map(leaf => leaf.iri), graphs },
    { shape: `${DEF}poll-allocation-v1/activation-shape`, focus: [activation], graphs }]);
  return executeVoteCommand(env, { admission, validations, insert, where, component: plan, revision: activation,
    operation, event: 'AllocationActivatedEvent' });
}

// ------------------------------------------------------------- poll.open / close

interface FrozenSeats { activations: string[]; seatCount: number; countedUnits: number }

/** Counted seats at opening: unallocated roots plus leaves of activated plans. O(entitlements). */
async function frozenSeats(env: WorkActivationEnvironment, poll: string): Promise<FrozenSeats> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind (COUNT(?seat) AS ?n) (SUM(?units) AS ?u)
    (GROUP_CONCAT(DISTINCT STR(?activation); separator=" ") AS ?activations) WHERE { GRAPH ${iri(REVISIONS)} {
      { ?seat a rv:SourceEntitlement ; rv:poll ${iri(poll)} ; rv:issuedUnits ?units .
        FILTER NOT EXISTS { ?any a rv:AllocationActivation ; rv:poll ${iri(poll)} ; rv:rootEntitlement ?seat }
        BIND("root" AS ?kind) }
      UNION
      { ?activation a rv:AllocationActivation ; rv:poll ${iri(poll)} ; rv:allocationPlan ?plan .
        ?seat a rv:AllocationLeaf ; rv:allocationPlan ?plan ; rv:leafUnits ?units . BIND("leaf" AS ?kind) } } }
    GROUP BY ?kind`);
  let seatCount = 0, countedUnits = 0;
  const activations: string[] = [];
  for (const row of result.results?.bindings ?? []) {
    seatCount += Number(row.n?.value ?? '0');
    countedUnits += Number(row.u?.value ?? '0');
    if (row.kind?.value === 'leaf' && row.activations?.value) activations.push(...row.activations.value.split(' '));
  }
  return { activations: activations.sort(), seatCount, countedUnits };
}

export interface PollLifecycleIntent { poll: string; closesAt?: string }

// ------------------------------------------------------------- proxy routes

export interface ProxyIntent { poll: string; seat: string; holder: string; proxy: string;
  expectedHead: string | null }

export async function checkProxyRoute(env: WorkActivationEnvironment, intent: ProxyIntent,
  operation: 'proxy.designate' | 'proxy.revoke') {
  const poll = await readPoll(env, intent.poll);
  if (poll.charter.proxy !== 'one-hop') throw new VoteRejected('proxy_not_chartered');
  if (operation === 'proxy.designate' && poll.state !== 'draft') throw new VoteRejected('poll_not_draft');
  if (operation === 'proxy.revoke' && !['draft', 'open'].includes(poll.state)) {
    throw new VoteRejected('poll_not_active');
  }
  const seat = await readSeat(env, intent.poll, intent.seat);
  if (!seat.counted || seat.holder !== intent.holder || intent.proxy === intent.holder) {
    throw new VoteRejected('invalid_proxy_seat');
  }
  const route = await readProxyRoute(env, intent.poll, intent.seat);
  if ((route?.revision ?? null) !== intent.expectedHead) throw new VoteStale('proxy route head changed');
  if (operation === 'proxy.designate' && route) throw new VoteRejected('proxy_route_already_exists');
  if (operation === 'proxy.revoke' && (route?.state !== 'active' || route.proxy !== intent.proxy)) {
    throw new VoteRejected('proxy_route_not_active');
  }
  if (operation === 'proxy.designate') {
    const routes = await activeProxyRoutes(env, intent.poll);
    if (routes.some(item => item.proxy === intent.holder || item.holder === intent.proxy)) {
      throw new VoteRejected('proxy_chain_or_cycle');
    }
  }
  return { poll, seat, route };
}

export async function dispatchProxyRoute(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: ProxyIntent, operationKind: 'proxy.designate' | 'proxy.revoke', poll: PollView,
  seat: SeatView): Promise<boolean> {
  const route = proxyRouteComponent(intent.poll, intent.seat);
  const revision = newId(), operation = operationIri();
  const designate = operationKind === 'proxy.designate';
  const insert = `${designate ? G(CURRENT, `${iri(route)} a rv:ProxyRoute ; rv:poll ${iri(intent.poll)} ;
    rv:seat ${iri(intent.seat)} ; rv:sourceEntitlement ${iri(seat.sourceEntitlement)} ;
    rv:proxyHolder ${iri(intent.proxy)} ; rv:routeHead ${iri(revision)} .`)
    : G(CURRENT, `${iri(route)} rv:routeHead ${iri(revision)} .`)}
    ${G(REVISIONS, `${iri(revision)} a rv:ProxyRouteRevision ; rv:proxyRoute ${iri(route)} ;
      ${intent.expectedHead ? `rv:predecessor ${iri(intent.expectedHead)} ;` : ''}
      rv:routeState rv:${designate ? 'RouteActive' : 'RouteRevoked'} ; rv:proxyHopLimit 1 ;
      rv:redelegation rv:RedelegationForbidden ; rv:electorateCharter ${iri(poll.electorateCharter)} ;
      rv:operation ${iri(operation)} ; rv:revisedAt ${dateTime(now())} .`)}`;
  const existingGuard = designate
    ? `FILTER NOT EXISTS { ${G(CURRENT, `${iri(route)} ?p ?o .`)} }
       FILTER NOT EXISTS { ${G(CURRENT, `?incoming a rv:ProxyRoute ; rv:poll ${iri(intent.poll)} ;
         rv:proxyHolder ${iri(intent.holder)} ; rv:routeHead ?incomingHead .`)}
         ${G(REVISIONS, `?incomingHead rv:routeState rv:RouteActive .`)} }
       FILTER NOT EXISTS { ${G(CURRENT, `?outgoing a rv:ProxyRoute ; rv:poll ${iri(intent.poll)} ;
         rv:seat ?outgoingSeat ; rv:routeHead ?outgoingHead .`)}
         ${G(REVISIONS, `?outgoingHead rv:routeState rv:RouteActive .
           ?outgoingSeat rv:holder ${iri(intent.proxy)} .`)} }`
    : `${G(CURRENT, `${iri(route)} a rv:ProxyRoute ; rv:poll ${iri(intent.poll)} ;
        rv:seat ${iri(intent.seat)} ; rv:proxyHolder ${iri(intent.proxy)} ;
        rv:routeHead ${iri(intent.expectedHead!)} .`)}
       ${G(REVISIONS, `${iri(intent.expectedHead!)} rv:routeState rv:RouteActive .`)}`;
  const countedGuard = seat.kind === 'root'
    ? `FILTER NOT EXISTS { ${G(REVISIONS, `?allocation a rv:AllocationActivation ;
        rv:poll ${iri(intent.poll)} ; rv:rootEntitlement ${iri(intent.seat)} .`)} }`
    : G(REVISIONS, `?allocation a rv:AllocationActivation ; rv:poll ${iri(intent.poll)} ;
        rv:allocationPlan ${iri(seat.plan!)} .`);
  const where = `${G(CURRENT, `${iri(intent.poll)} rv:pollState ${designate ? 'rv:PollDraft' : '?pollState'} ;
      rv:electorateCharter ${iri(poll.electorateCharter)} .`)}
    ${designate ? '' : 'FILTER(?pollState IN (rv:PollDraft, rv:PollOpen))'}
    ${G(REVISIONS, `${iri(poll.electorateCharter)} rv:proxyPolicy rv:OneHopProxy .
      ${iri(intent.seat)} rv:holder ${iri(intent.holder)} .`)}
    ${countedGuard} ${existingGuard}`;
  const validations = await profileValidations(env.fuseki, 'ballot-proxy-v1', [
    { shape: `${DEF}ballot-proxy-v1/route-shape`, focus: [route], graphs },
    { shape: `${DEF}ballot-proxy-v1/revision-shape`, focus: [revision], graphs }]);
  return executeVoteCommand(env, { admission, validations, insert, where, component: route,
    revision, operation, event: designate ? 'ProxyDesignatedEvent' : 'ProxyRevokedEvent',
    remove: designate ? undefined : G(CURRENT, `${iri(route)} rv:routeHead ${iri(intent.expectedHead!)} .`) });
}

export async function dispatchOpenPoll(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: PollLifecycleIntent, poll: PollView): Promise<boolean> {
  if (poll.state !== 'draft' || !poll.snapshot || poll.issuedUnits === null) throw new VoteRejected('poll_not_draft');
  const seats = await frozenSeats(env, intent.poll);
  const routes = await activeProxyRoutes(env, intent.poll);
  if (routes.length && poll.charter.proxy !== 'one-hop') throw new VoteRejected('proxy_not_chartered');
  // Conservation: every issued unit is counted exactly once, by a root or by its leaves.
  if (seats.countedUnits !== poll.issuedUnits) throw new VoteRejected('units_not_conserved');
  const opening = newId();
  const operation = operationIri();
  const at = now();
  const closesAt = intent.closesAt ?? new Date(Date.now() + 86_400_000).toISOString();
  const insert = `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollOpen ; rv:pollOpening ${iri(opening)} .`)}
    ${G(REVISIONS, `${iri(opening)} a rv:PollOpening ; rv:poll ${iri(intent.poll)} ;
      rv:questionRevision ${iri(poll.question)} ; rv:electorateCharter ${iri(poll.electorateCharter)} ;
      rv:electorateSnapshot ${iri(poll.snapshot)} ;
      rv:allocationManifestDigest ${lit(digestOf(seats.activations))} ;
      rv:proxyRouteManifestDigest ${lit(digestOf(routes.map(route =>
        [route.route, route.revision, route.holder, route.proxy]).sort()))} ;
      ${routes.map(route => `rv:frozenProxyRoute ${iri(route.revision)} ;`).join(' ')}
      rv:seatCount ${seats.seatCount} ;
      rv:countedUnits ${seats.countedUnits} ;
      rv:openingDigest ${lit(digestOf({ poll: intent.poll, charter: poll.electorateCharter, question: poll.question,
        snapshot: poll.snapshot, activations: seats.activations,
        routes: routes.map(route => [route.route, route.revision]).sort(),
        seats: seats.seatCount, units: seats.countedUnits }))} ;
      rv:closesAt ${dateTime(closesAt)} ; rv:openedAt ${dateTime(at)} ; rv:operation ${iri(operation)} .`)}`;
  const listed = seats.activations.map(iri).join(', ');
  const routeHeads = routes.map(route => iri(route.revision)).join(', ');
  const where = `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollDraft ; rv:electorateSnapshot ${iri(poll.snapshot)} ;
      rv:questionHead ${iri(poll.question)} ; rv:electorateCharter ${iri(poll.electorateCharter)} .`)}
    FILTER NOT EXISTS { ${G(REVISIONS, `?activation a rv:AllocationActivation ; rv:poll ${iri(intent.poll)} .
      ${listed ? `FILTER(?activation NOT IN (${listed}))` : ''}`)} }
    ${routes.map(route => `${G(CURRENT, `${iri(route.route)} rv:routeHead ${iri(route.revision)} .`)}
      ${G(REVISIONS, `${iri(route.revision)} rv:routeState rv:RouteActive .`)}`).join('\n')}
    FILTER NOT EXISTS { ${G(CURRENT, `?newRoute a rv:ProxyRoute ; rv:poll ${iri(intent.poll)} ;
      rv:routeHead ?newHead .`)} ${G(REVISIONS, `?newHead rv:routeState rv:RouteActive .`)}
      ${routeHeads ? `FILTER(?newHead NOT IN (${routeHeads}))` : ''} }`;
  const validations = await profileValidations(env.fuseki, 'poll-snapshot-v1', [
    { shape: `${DEF}poll-snapshot-v1/poll-shape`, focus: [intent.poll], graphs },
    { shape: `${DEF}poll-snapshot-v1/opening-shape`, focus: [opening], graphs }]);
  return executeVoteCommand(env, { admission, validations, insert, where, component: intent.poll,
    revision: opening, operation, event: 'PollOpenedEvent',
    remove: G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollDraft .`) });
}

export async function dispatchClosePoll(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: PollLifecycleIntent, poll: PollView): Promise<boolean> {
  if (poll.state !== 'open' || !poll.opening) throw new VoteRejected('poll_not_open');
  const operation = operationIri();
  const closure = voteId('closure', intent.poll);
  const insert = G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollClosed ; rv:closedAt ${dateTime(now())} .`);
  const where = G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollOpen ; rv:pollOpening ${iri(poll.opening)} .`);
  const validations = await profileValidations(env.fuseki, 'poll-snapshot-v1', [
    { shape: `${DEF}poll-snapshot-v1/poll-shape`, focus: [intent.poll], graphs }]);
  return executeVoteCommand(env, { admission, validations, insert, where, component: intent.poll,
    revision: closure, operation, event: 'PollClosedEvent',
    remove: G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollOpen .`) });
}

/** Finalization reads immutable closed-poll heads; quorum and outcome use the frozen charter. */
export async function dispatchFinalizePoll(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: PollLifecycleIntent, poll: PollView): Promise<boolean> {
  if (poll.state !== 'closed' || !poll.opening || !poll.snapshot) throw new VoteRejected('poll_not_closed');
  const tally = await readTally(env, intent.poll);
  const abstainSeats = tally.options.filter(option => option.role === 'abstain')
    .reduce((sum, option) => sum + option.seats, 0);
  const bySeats = poll.charter.countingUnit !== 'WeightUnits';
  const participation = bySeats ? tally.castSeats - (poll.charter.abstention === 'AbstentionExcludedFromQuorum'
    ? abstainSeats : 0) : tally.castUnits - (poll.charter.abstention === 'AbstentionExcludedFromQuorum'
    ? tally.abstainUnits : 0);
  const quorumMet = participation >= poll.charter.quorumThreshold;
  const considered = tally.options.filter(option => option.role !== 'abstain');
  const top = Math.max(0, ...considered.map(option => option.units));
  const winners = considered.filter(option => option.units === top);
  const winner = top > 0 && winners.length === 1 ? winners[0]! : null;
  const expressed = considered.reduce((sum, option) => sum + option.units, 0);
  const passed = winner && winner.role !== 'reject'
    && winner.units * poll.charter.passDenominator >= expressed * poll.charter.passNumerator;
  const outcome = !quorumMet ? 'ResolutionNoQuorum' : passed ? 'ResolutionAdopted' : 'ResolutionRejected';
  const resolution = newId();
  const operation = operationIri();
  const at = now();
  const proposalState = outcome === 'ResolutionAdopted' ? 'ProposalAdopted' : 'ProposalRejected';
  const optionTallies = tally.options.map(option => ({ ...option, option: poll.options.find(item => item.key === option.key)!.option,
    iri: voteId('option-tally', resolution, option.key) }));
  const insert = `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollFinalized ;
    rv:pollResolution ${iri(resolution)} .
    ${poll.proposal ? `${iri(poll.proposal)} rv:proposalState rv:${proposalState} .` : ''}`)}
    ${G(REVISIONS, `${iri(resolution)} a rv:PollResolution ; rv:poll ${iri(intent.poll)} ;
      rv:pollOpening ${iri(poll.opening)} ; rv:electorateCharter ${iri(poll.electorateCharter)} ;
      rv:electorateSnapshot ${iri(poll.snapshot)} ;
      rv:tallyDigest ${lit(digestOf({ tally, charter: poll.charter.digest }))} ;
      rv:countedSeats ${tally.castSeats} ; rv:castUnits ${tally.castUnits} ;
      rv:abstainUnits ${tally.abstainUnits} ; rv:uncastUnits ${tally.uncastUnits} ;
      rv:quorumOutcome rv:${quorumMet ? 'QuorumMet' : 'QuorumNotMet'} ;
      rv:resolutionOutcome rv:${outcome} ;
      ${poll.proposalRevision ? `rv:proposalRevision ${iri(poll.proposalRevision)} ;
        rv:effectDigest ?effectDigest ;` : ''}
      ${outcome === 'ResolutionAdopted'
        ? `rv:winningOption ${iri(poll.options.find(option => option.key === winner!.key)!.option)} ;` : ''}
      rv:operation ${iri(operation)} ; rv:finalizedAt ${dateTime(at)} .
    ${optionTallies.map(option => `${iri(option.iri)} a rv:OptionTally ; rv:pollResolution ${iri(resolution)} ;
      rv:option ${iri(option.option)} ; rv:tallyUnits ${option.units} ; rv:tallySeats ${option.seats} .`).join('\n')}`)}`;
  const where = `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollClosed ;
    rv:pollOpening ${iri(poll.opening)} ; rv:electorateSnapshot ${iri(poll.snapshot)} ;
    rv:electorateCharter ${iri(poll.electorateCharter)} .`)}
    FILTER NOT EXISTS { ${G(CURRENT, `${iri(intent.poll)} rv:pollResolution ?prior .`)} }
    ${poll.proposal && poll.proposalRevision
      ? `${G(CURRENT, `${iri(poll.proposal)} rv:proposalState rv:ProposalOpen ;
        rv:proposalHead ${iri(poll.proposalRevision)} .`)}
        ${G(REVISIONS, `${iri(poll.proposalRevision)} rv:proposal ${iri(poll.proposal)} ;
          rv:ruleRevision ${iri(poll.charter.ruleRevision)} ; rv:effectDigest ?effectDigest .`)}` : ''}`;
  const validations = await profileValidations(env.fuseki, 'poll-resolution-v1', [
    { shape: `${DEF}poll-resolution-v1/resolution-shape`, focus: [resolution], graphs },
    { shape: `${DEF}poll-resolution-v1/tally-shape`, focus: optionTallies.map(option => option.iri), graphs }]);
  validations.push(...await profileValidations(env.fuseki, 'poll-snapshot-v1', [
    { shape: `${DEF}poll-snapshot-v1/poll-shape`, focus: [intent.poll], graphs }]));
  if (poll.proposal) validations.push(...await profileValidations(env.fuseki, 'proposal-v1', [
    { shape: `${DEF}proposal-v1/proposal-shape`, focus: [poll.proposal], graphs }]));
  return executeVoteCommand(env, { admission, validations, insert, where, component: intent.poll,
    revision: resolution, operation, event: 'PollFinalizedEvent',
    remove: G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollClosed .
      ${poll.proposal ? `${iri(poll.proposal)} rv:proposalState rv:ProposalOpen .` : ''}`) });
}

// ------------------------------------------------------------ ballots / approvals

export interface BallotCandidate {
  expectedHead: string | null;
  availability: 'cast' | 'withdrawn';
  shares: { option: string; units: number }[];
  internalPoll: string | null;
}

export interface BallotIntent extends BallotCandidate {
  poll: string;
  seat: string;
  holder: string;
  proxySubject?: string;
  proxyRoute?: string;
  approvals: string[];
}

export interface BallotContext {
  poll: PollView;
  seat: SeatView;
  charter: HolderCharterView | null;
  rule: MandateRule;
  aggregation: Aggregation;
  policyRevision: string | null;
  candidateDigest: string;
  castRoute: 'HolderCast' | 'ProxyCast' | 'HolderOverride';
  proxyRoute: string | null;
  proxyHolder: string | null;
  shares: { option: string; key: string; units: number }[];
}

/** Largest-remainder split of the seat's units by an internal tally; ties go to the lower key. */
export function proportionalShares(units: number, tally: readonly { key: string; units: number }[]) {
  const total = tally.reduce((sum, item) => sum + item.units, 0);
  if (!total) throw new VoteRejected('internal_decision_empty');
  const quotas = tally.map(item => ({ key: item.key, whole: Math.floor(item.units * units / total),
    remainder: (item.units * units) % total }));
  let left = units - quotas.reduce((sum, item) => sum + item.whole, 0);
  for (const item of [...quotas].sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key))) {
    if (left-- <= 0) break;
    item.whole += 1;
  }
  return quotas.filter(item => item.whole > 0).map(item => ({ option: item.key, units: item.whole }))
    .sort((a, b) => a.option.localeCompare(b.option));
}

/** The only shares an internal-decision holder may cast: derived from its closed internal poll. */
async function internalDecision(env: WorkActivationEnvironment, internalPoll: string, holder: string,
  seat: SeatView, aggregation: Aggregation) {
  const internal = await readPoll(env, internalPoll);
  const resolution = await readResolution(env, internalPoll);
  if (internal.body !== holder || internal.state !== 'finalized' || resolution?.outcome !== 'adopted') {
    throw new VoteRejected('internal_decision_not_final');
  }
  const tally = (await readTally(env, internalPoll)).options.filter(option => option.role !== 'abstain');
  if (aggregation === 'proportional') return proportionalShares(seat.units, tally);
  const best = Math.max(...tally.map(item => item.units));
  const winners = tally.filter(item => item.units === best);
  if (!best) throw new VoteRejected('internal_decision_empty');
  if (winners.length !== 1) throw new VoteRejected('internal_decision_tied');
  if (internal.options.find(option => option.key === winners[0]!.key)?.option !== resolution.winningOption) {
    throw new VoteRejected('internal_decision_mismatch');
  }
  return [{ option: winners[0]!.key, units: seat.units }];
}

/** Bounded reads plus every rule that needs no admission: seat, charter, aggregation and conservation. */
export async function checkBallot(env: WorkActivationEnvironment, intent: BallotCandidate & {
  poll: string; seat: string; holder: string; proxySubject?: string; proxyRoute?: string },
  policy: VotePolicyHead | null): Promise<BallotContext> {
  const poll = await readPoll(env, intent.poll);
  if (poll.state !== 'open' || !poll.opening) throw new VoteRejected('poll_not_open');
  const route = await readProxyRoute(env, intent.poll, intent.seat);
  if (intent.proxySubject && (route?.state !== 'active' || route.proxy !== intent.proxySubject
    || route.revision !== intent.proxyRoute || poll.charter.proxy !== 'one-hop')) {
    throw new VoteRejected('proxy_route_not_active');
  }
  if (!intent.proxySubject && intent.proxyRoute) throw new VoteRejected('proxy_subject_required');
  if (!intent.proxySubject && route?.state === 'active' && !poll.charter.holderOverride) {
    throw new VoteRejected('holder_override_not_chartered');
  }
  const castRoute = intent.proxySubject ? 'ProxyCast' : route?.state === 'active'
    ? 'HolderOverride' : 'HolderCast';
  const routeRevision = route?.state === 'active' ? route.revision : null;
  const seat = await readSeat(env, intent.poll, intent.seat);
  if (!seat.counted) throw new VoteRejected('seat_not_counted');
  if (seat.holder !== intent.holder) throw new VoteRejected('not_seat_holder');
  const charter = await readHolderCharter(env, intent.poll, seat.sourceEntitlement);
  const rule = charter?.rule ?? 'any-admitted';
  const aggregation = charter?.aggregation ?? 'whole';
  const head = await readBallot(env, intent.poll, intent.seat);
  if ((head?.revision ?? null) !== intent.expectedHead) throw new VoteStale('ballot head is stale');
  const options = new Map(poll.options.map(option => [option.key, option.option]));
  let shares: BallotContext['shares'] = [];
  if (intent.availability === 'withdrawn') {
    if (intent.shares.length || !head || head.availability !== 'cast' || intent.internalPoll) {
      throw new VoteRejected('nothing_to_withdraw');
    }
  } else {
    const keys = new Set(intent.shares.map(share => share.option));
    if (!intent.shares.length || keys.size !== intent.shares.length
      || intent.shares.some(share => !options.has(share.option) || !intIn(share.units, 1, 1_000_000))) {
      throw new VoteRejected('invalid_shares');
    }
    if (intent.shares.reduce((sum, share) => sum + share.units, 0) !== seat.units) {
      throw new VoteRejected('units_not_conserved');
    }
    if (aggregation === 'whole' && intent.shares.length !== 1) throw new VoteRejected('whole_ballot_required');
    if (rule === 'internal-decision') {
      if (!intent.internalPoll) throw new VoteRejected('internal_decision_required');
      const derived = await internalDecision(env, intent.internalPoll, seat.holder, seat, aggregation);
      const requested = [...intent.shares].sort((a, b) => a.option.localeCompare(b.option));
      if (JSON.stringify(derived) !== JSON.stringify(requested)) throw new VoteRejected('internal_decision_mismatch');
    } else if (intent.internalPoll) throw new VoteRejected('internal_decision_not_chartered');
    shares = intent.shares.map(share => ({ option: options.get(share.option)!, key: share.option, units: share.units }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  let policyRevision: string | null = null;
  if (rule === 'k-of-n' || rule === 'designated') {
    if (!policy || policy.holderCharterRevision !== charter!.revision) throw new VoteRejected('policy_charter_mismatch');
    policyRevision = `urn:rezics:vote-policy:${policy.id}:${policy.revision}`;
  }
  const candidateDigest = digestOf({ poll: intent.poll, seat: intent.seat, opening: poll.opening,
    holderCharter: charter?.revision ?? null, expectedHead: intent.expectedHead, availability: intent.availability,
    shares: shares.map(share => [share.key, share.units]), internalPoll: intent.internalPoll, policyRevision,
    castRoute, proxyRoute: routeRevision });
  return { poll, seat, charter, rule, aggregation, policyRevision, candidateDigest, shares,
    castRoute, proxyRoute: routeRevision, proxyHolder: route?.state === 'active' ? route.proxy : null };
}

/** Guards that keep the frozen seat, head and holder charter exactly as read. */
function seatGuards(intent: { poll: string; seat: string; expectedHead: string | null },
  context: BallotContext, ballot: string): string {
  const { seat, charter, poll } = context;
  const seatGuard = seat.kind === 'root'
    ? `${G(REVISIONS, `${iri(seat.seat)} a rv:SourceEntitlement ; rv:poll ${iri(intent.poll)} ;
        rv:issuedUnits ${seat.units} ; rv:holder ${iri(seat.holder)} .`)}
      FILTER NOT EXISTS { ${G(REVISIONS, `?activation a rv:AllocationActivation ; rv:poll ${iri(intent.poll)} ;
        rv:rootEntitlement ${iri(seat.seat)} .`)} }`
    : G(REVISIONS, `${iri(seat.seat)} a rv:AllocationLeaf ; rv:allocationPlan ${iri(seat.plan!)} ;
        rv:leafUnits ${seat.units} ; rv:holder ${iri(seat.holder)} .
      ?activation a rv:AllocationActivation ; rv:poll ${iri(intent.poll)} ; rv:allocationPlan ${iri(seat.plan!)} .`);
  const component = holderCharterComponent(intent.poll, seat.sourceEntitlement);
  const charterGuard = charter ? G(CURRENT, `${iri(component)} rv:charterHead ${iri(charter.revision)} .`)
    : `FILTER NOT EXISTS { ${G(CURRENT, `${iri(component)} ?pc ?oc`)} }`;
  const headGuard = intent.expectedHead
    ? G(CURRENT, `${iri(ballot)} rv:ballotHead ${iri(intent.expectedHead)} .`)
    : `FILTER NOT EXISTS { ${G(CURRENT, `${iri(ballot)} ?pb ?ob`)} }`;
  return `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollOpen ; rv:pollOpening ${iri(poll.opening!)} .`)}
    ${seatGuard} ${charterGuard} ${headGuard}`;
}

export async function dispatchBallot(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: BallotIntent, context: BallotContext): Promise<boolean> {
  const ballot = ballotComponent(intent.poll, intent.seat);
  const revision = newId();
  const operation = operationIri();
  const shares = context.shares.map(share => ({ ...share, iri: voteId('share', revision, share.option) }));
  const units = intent.availability === 'cast' ? context.seat.units : 0;
  const prior = intent.expectedHead;
  const insert = `${G(CURRENT, `${iri(ballot)} a rv:Ballot ; rv:poll ${iri(intent.poll)} ; rv:seat ${iri(intent.seat)} ;
      rv:sourceEntitlement ${iri(context.seat.sourceEntitlement)} ; rv:ballotHead ${iri(revision)} .`)}
    ${G(REVISIONS, `${iri(revision)} a rv:BallotRevision ; rv:ballot ${iri(ballot)} ;
      ${prior ? `rv:predecessor ${iri(prior)} ;` : ''} rv:pollOpening ${iri(context.poll.opening!)} ;
      ${context.charter ? `rv:holderCharter ${iri(context.charter.revision)} ;` : ''}
      rv:ballotAvailability rv:${intent.availability === 'cast' ? 'BallotCast' : 'BallotWithdrawn'} ;
      rv:castRoute rv:${context.castRoute} ;
      ${context.proxyRoute ? `rv:proxyRoute ${iri(context.proxyRoute)} ;` : ''}
      ${intent.approvals.map(approval => `rv:mandateApproval ${iri(approval)} ;`).join(' ')}
      ${intent.internalPoll ? `rv:internalPoll ${iri(intent.internalPoll)} ;` : ''}
      ${shares.map(share => `rv:ballotShare ${iri(share.iri)} ;`).join(' ')}
      rv:ballotDigest ${lit(context.candidateDigest)} ; rv:countedUnits ${units} ;
      rv:operation ${iri(operation)} ; rv:submittedAt ${dateTime(now())} .
      ${shares.map(share => `${iri(share.iri)} a rv:BallotShare ; rv:ballotRevision ${iri(revision)} ;
        rv:option ${iri(share.option)} ; rv:shareUnits ${share.units} .`).join('\n')}`)}`;
  const approvalGuards = intent.approvals.map((approval, index) => G(REVISIONS,
    `${iri(approval)} a rv:MandateApproval ; rv:seat ${iri(intent.seat)} ; rv:candidateDigest ${lit(context.candidateDigest)} ;
      rv:approverSlot ?slot${index} .`)).join('\n');
  const distinct = intent.approvals.length > 1
    ? `FILTER(${intent.approvals.flatMap((_, i) => intent.approvals.slice(i + 1).map((__, j) => `?slot${i} != ?slot${i + j + 1}`)).join(' && ')})` : '';
  const internalGuard = intent.internalPoll
    ? G(CURRENT, `${iri(intent.internalPoll)} rv:pollState rv:PollFinalized ; rv:pollResolution ?internalResolution .`) : '';
  const route = proxyRouteComponent(intent.poll, intent.seat);
  const routeGuard = context.proxyRoute
    ? `${G(CURRENT, `${iri(route)} rv:routeHead ${iri(context.proxyRoute)} ;
        rv:proxyHolder ${iri(context.proxyHolder!)} .`)}
        ${G(REVISIONS, `${iri(context.proxyRoute)} rv:routeState rv:RouteActive .
          ${iri(context.poll.opening!)} rv:frozenProxyRoute ${iri(context.proxyRoute)} .`)}`
    : `FILTER NOT EXISTS { ${G(CURRENT, `${iri(route)} rv:routeHead ?activeRoute .`)}
        ${G(REVISIONS, `?activeRoute rv:routeState rv:RouteActive .`)} }`;
  const where = `${seatGuards(intent, context, ballot)} ${approvalGuards} ${distinct} ${internalGuard}
    ${routeGuard}`;
  const validations = await profileValidations(env.fuseki, 'ballot-v1', [
    { shape: `${DEF}ballot-v1/ballot-shape`, focus: [ballot], graphs },
    { shape: `${DEF}ballot-v1/revision-shape`, focus: [revision], graphs },
    ...(shares.length ? [{ shape: `${DEF}ballot-v1/share-shape`, focus: shares.map(share => share.iri), graphs }] : [])]);
  return executeVoteCommand(env, { admission, validations, insert, where, component: ballot, revision, operation,
    event: 'BallotChangedEvent', remove: prior ? G(CURRENT, `${iri(ballot)} rv:ballotHead ${iri(prior)} .`) : undefined });
}

export const approvalIri = (candidateDigest: string, approverSlot: string) =>
  voteId('approval', candidateDigest, approverSlot);

export async function dispatchApproval(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: { poll: string; seat: string; expectedHead: string | null }, context: BallotContext,
  approverSlot: string): Promise<boolean> {
  const approval = approvalIri(context.candidateDigest, approverSlot);
  const operation = operationIri();
  const ballot = ballotComponent(intent.poll, intent.seat);
  const insert = G(REVISIONS, `${iri(approval)} a rv:MandateApproval ; rv:poll ${iri(intent.poll)} ;
      rv:seat ${iri(intent.seat)} ; rv:pollOpening ${iri(context.poll.opening!)} ;
      rv:holderCharter ${iri(context.charter!.revision)} ; rv:mandatePolicyRevision ${iri(context.policyRevision!)} ;
      rv:candidateDigest ${lit(context.candidateDigest)} ;
      ${intent.expectedHead ? `rv:expectedBallotRevision ${iri(intent.expectedHead)} ;` : ''}
      rv:approverSlot ${iri(approverSlot)} ; rv:operation ${iri(operation)} ; rv:approvedAt ${dateTime(now())} .`);
  const validations = await profileValidations(env.fuseki, 'ballot-mandate-approval-v1', [
    { shape: `${DEF}ballot-mandate-approval-v1/approval-shape`, focus: [approval], graphs }]);
  const where = `${seatGuards(intent, context, ballot)}
    FILTER NOT EXISTS { ${G(REVISIONS, `${iri(approval)} a rv:MandateApproval .`)} }`;
  return executeVoteCommand(env, { admission, validations, insert, where,
    component: intent.seat, revision: approval, operation, event: 'MandateApprovalRecordedEvent' });
}

// ---------------------------------------------------------- ballot.invalidate

export interface InvalidateBallotIntent {
  poll: string; seat: string; holder: string; expectedHead: string;
  ruleRevision: string; evidenceDigest: string;
}

/** A separate body-granted decision removes one current contribution, retaining its cast revision. */
export async function dispatchInvalidateBallot(env: WorkActivationEnvironment, admission: VoteAdmission,
  intent: InvalidateBallotIntent, poll: PollView): Promise<boolean> {
  const ballot = ballotComponent(intent.poll, intent.seat);
  const decision = newId(), revision = newId(), operation = operationIri(), at = now();
  const insert = `${G(CURRENT, `${iri(ballot)} rv:ballotHead ${iri(revision)} .`)}
    ${G(REVISIONS, `${iri(decision)} a rv:BallotInvalidation ; rv:poll ${iri(intent.poll)} ;
      rv:ballot ${iri(ballot)} ; rv:invalidatedRevision ${iri(intent.expectedHead)} ;
      rv:electorateCharter ${iri(poll.electorateCharter)} ; rv:ruleRevision ${iri(intent.ruleRevision)} ;
      rv:evidenceDigest ${lit(intent.evidenceDigest)} ; rv:operation ${iri(operation)} ;
      rv:decidedAt ${dateTime(at)} .
      ${iri(revision)} a rv:BallotRevision ; rv:ballot ${iri(ballot)} ;
      rv:predecessor ${iri(intent.expectedHead)} ; rv:pollOpening ${iri(poll.opening!)} ;
      rv:ballotAvailability rv:BallotInvalidated ; rv:castRoute ?priorRoute ;
      rv:invalidationDecision ${iri(decision)} ; rv:ballotDigest ${lit(digestOf(intent))} ;
      rv:countedUnits 0 ; rv:operation ${iri(operation)} ; rv:submittedAt ${dateTime(at)} .`)}`;
  const where = `${G(CURRENT, `${iri(intent.poll)} rv:pollState rv:PollOpen ;
      rv:pollOpening ${iri(poll.opening!)} ; rv:electorateCharter ${iri(poll.electorateCharter)} .
      ${iri(ballot)} a rv:Ballot ; rv:poll ${iri(intent.poll)} ; rv:seat ${iri(intent.seat)} ;
        rv:ballotHead ${iri(intent.expectedHead)} .`)}
    ${G(REVISIONS, `${iri(poll.electorateCharter)} rv:invalidationPolicy rv:DeclaredInvalidationDecision ;
      rv:ruleRevision ${iri(intent.ruleRevision)} .
      ${iri(intent.expectedHead)} a rv:BallotRevision ; rv:ballot ${iri(ballot)} ;
        rv:ballotAvailability rv:BallotCast ; rv:castRoute ?priorRoute .`)}`;
  const validations = await profileValidations(env.fuseki, 'poll-resolution-v1', [
    { shape: `${DEF}poll-resolution-v1/invalidation-shape`, focus: [decision], graphs }]);
  validations.push(...await profileValidations(env.fuseki, 'ballot-v1', [
    { shape: `${DEF}ballot-v1/ballot-shape`, focus: [ballot], graphs },
    { shape: `${DEF}ballot-v1/revision-shape`, focus: [revision], graphs }]));
  return executeVoteCommand(env, { admission, validations, insert, where, component: ballot,
    revision, operation, event: 'BallotInvalidatedEvent',
    remove: G(CURRENT, `${iri(ballot)} rv:ballotHead ${iri(intent.expectedHead)} .`) });
}

/** Classify an unmatched guard from a fresh read: a changed head is stale, anything else a typed rejection. */
export async function classifyBallotGuard(env: WorkActivationEnvironment, intent: {
  poll: string; seat: string; expectedHead: string | null }): Promise<'stale-head' | string> {
  const poll = await readPoll(env, intent.poll);
  if (poll.state !== 'open') return 'poll_not_open';
  const head = await readBallot(env, intent.poll, intent.seat);
  if ((head?.revision ?? null) !== intent.expectedHead) return 'stale-head';
  return 'ballot_guard_failed';
}
