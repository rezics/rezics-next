import { RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import type { SeatClass } from './access.ts';
import { CURRENT, REVISIONS, VoteUnavailable, voteId } from './graph.ts';

/**
 * Bounded reads of the vote owner. Each function is one SPARQL request against
 * the current and revisions graphs; result sizes are fixed by the poll's option
 * count, one seat, one charter head or the listed approvals (see README costs).
 */

export type PollState = 'draft' | 'open' | 'closed';
export type MandateRule = 'designated' | 'any-admitted' | 'k-of-n' | 'internal-decision';
export type Aggregation = 'whole' | 'proportional';
export type OptionRole = 'approve' | 'reject' | 'abstain' | 'choice';

const local = (value: string | undefined) => value?.startsWith(RV) ? value.slice(RV.length) : undefined;
const states: Record<string, PollState> = { PollDraft: 'draft', PollOpen: 'open', PollClosed: 'closed' };
const classes: Record<string, SeatClass> = { PersonSeat: 'person', OrganizationSeat: 'organization',
  CollectiveMemberSeat: 'collective' };
export const seatClassTerm: Record<SeatClass, string> = { person: 'PersonSeat', organization: 'OrganizationSeat',
  collective: 'CollectiveMemberSeat' };
const rules: Record<string, MandateRule> = { DesignatedRepresentative: 'designated',
  AnyAdmittedRepresentative: 'any-admitted', KOfNApproval: 'k-of-n', InternalDecision: 'internal-decision' };
export const ruleTerm: Record<MandateRule, string> = { designated: 'DesignatedRepresentative',
  'any-admitted': 'AnyAdmittedRepresentative', 'k-of-n': 'KOfNApproval', 'internal-decision': 'InternalDecision' };
const roles: Record<string, OptionRole> = { ApproveOption: 'approve', RejectOption: 'reject',
  AbstainOption: 'abstain', ChoiceOption: 'choice' };
export const optionRoleTerm: Record<OptionRole, string> = { approve: 'ApproveOption', reject: 'RejectOption',
  abstain: 'AbstainOption', choice: 'ChoiceOption' };

export interface PollView {
  poll: string; body: string; state: PollState;
  electorateCharter: string; question: string; snapshot: string | null; opening: string | null;
  issuedUnits: number | null; entitlementCount: number | null;
  seatCount: number | null; countedUnits: number | null; closesAt: string | null;
  charter: { allocation: boolean; admittedSeatClasses: SeatClass[]; unitScale: number;
    countingUnit: string; quorumThreshold: number; abstention: string; digest: string };
  options: { option: string; key: string; role: OptionRole }[];
}

export async function readPoll(env: WorkActivationEnvironment, poll: string): Promise<PollView> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?body ?state ?charter ?question ?snapshot
    ?opening ?issued ?count ?seats ?counted ?closes ?allocation ?scale ?unit ?quorum ?abstention ?digest
    (GROUP_CONCAT(DISTINCT STR(?class); separator=" ") AS ?classes)
    (GROUP_CONCAT(DISTINCT CONCAT(STR(?option), "|", ?key, "|", STR(?role)); separator=" ") AS ?options)
    WHERE {
    GRAPH ${iri(CURRENT)} { ${iri(poll)} a rv:Poll ; rv:governingBody ?body ; rv:pollState ?state ;
      rv:electorateCharter ?charter ; rv:questionHead ?question . }
    GRAPH ${iri(REVISIONS)} {
      ?charter rv:allocationPolicy ?allocation ; rv:unitScale ?scale ; rv:countingUnit ?unit ;
        rv:quorumThreshold ?quorum ; rv:abstentionPolicy ?abstention ; rv:charterDigest ?digest ;
        rv:admittedSeatClass ?class .
      ?option a rv:PollOption ; rv:questionRevision ?question ; rv:optionKey ?key ; rv:optionRole ?role . }
    OPTIONAL { GRAPH ${iri(CURRENT)} { ${iri(poll)} rv:electorateSnapshot ?snapshot }
      GRAPH ${iri(REVISIONS)} { ?snapshot rv:issuedUnits ?issued ; rv:entitlementCount ?count } }
    OPTIONAL { GRAPH ${iri(CURRENT)} { ${iri(poll)} rv:pollOpening ?opening }
      GRAPH ${iri(REVISIONS)} { ?opening rv:seatCount ?seats ; rv:countedUnits ?counted ; rv:closesAt ?closes } }
  } GROUP BY ?body ?state ?charter ?question ?snapshot ?opening ?issued ?count ?seats ?counted ?closes
    ?allocation ?scale ?unit ?quorum ?abstention ?digest`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  const state = states[local(row?.state?.value) ?? ''];
  if (rows.length !== 1 || !row || !state) throw new VoteUnavailable('poll is unavailable');
  const number = (name: string) => row[name] ? Number(row[name]!.value) : null;
  return { poll, body: row.body!.value, state, electorateCharter: row.charter!.value,
    question: row.question!.value, snapshot: row.snapshot?.value ?? null, opening: row.opening?.value ?? null,
    issuedUnits: number('issued'), entitlementCount: number('count'), seatCount: number('seats'),
    countedUnits: number('counted'), closesAt: row.closes?.value ?? null,
    charter: { allocation: local(row.allocation?.value) === 'ExplicitSeatAllocation',
      admittedSeatClasses: row.classes!.value.split(' ').map(value => classes[local(value) ?? '']!).sort(),
      unitScale: Number(row.scale!.value), countingUnit: local(row.unit!.value)!,
      quorumThreshold: Number(row.quorum!.value), abstention: local(row.abstention!.value)!,
      digest: row.digest!.value },
    options: row.options!.value.split(' ').map(entry => {
      const [option, key, role] = entry.split('|');
      return { option: option!, key: key!, role: roles[local(role) ?? '']! };
    }).sort((a, b) => a.key.localeCompare(b.key)) };
}

export interface SeatView {
  seat: string; kind: 'root' | 'leaf'; holder: string; seatClass: SeatClass; units: number;
  sourceEntitlement: string; countingSlot: string; plan: string | null;
  /** True when this seat is the one that counts: an unallocated root or an activated leaf. */
  counted: boolean;
}

export async function readSeat(env: WorkActivationEnvironment, poll: string, seat: string): Promise<SeatView> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind ?holder ?class ?units ?root ?slot
    ?plan ?activation WHERE { GRAPH ${iri(REVISIONS)} {
      { ${iri(seat)} a rv:SourceEntitlement ; rv:poll ${iri(poll)} ; rv:holder ?holder ; rv:seatClass ?class ;
          rv:issuedUnits ?units ; rv:countingSlot ?slot . BIND(${iri(seat)} AS ?root) BIND("root" AS ?kind)
        OPTIONAL { ?activation a rv:AllocationActivation ; rv:poll ${iri(poll)} ; rv:rootEntitlement ${iri(seat)} } }
      UNION
      { ${iri(seat)} a rv:AllocationLeaf ; rv:allocationPlan ?plan ; rv:sourceEntitlement ?root ;
          rv:holder ?holder ; rv:seatClass ?class ; rv:leafUnits ?units ; rv:countingSlot ?slot .
        ?root rv:poll ${iri(poll)} . BIND("leaf" AS ?kind)
        OPTIONAL { ?activation a rv:AllocationActivation ; rv:poll ${iri(poll)} ; rv:allocationPlan ?plan } }
    } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.kind) throw new VoteUnavailable('seat is unavailable');
  const kind = row.kind.value as 'root' | 'leaf';
  return { seat, kind, holder: row.holder!.value, seatClass: classes[local(row.class!.value) ?? '']!,
    units: Number(row.units!.value), sourceEntitlement: row.root!.value, countingSlot: row.slot!.value,
    plan: row.plan?.value ?? null, counted: kind === 'root' ? !row.activation : !!row.activation };
}

export const holderCharterComponent = (poll: string, entitlement: string) =>
  voteId('holder-charter', poll, entitlement);

export interface HolderCharterView {
  charter: string; revision: string; rule: MandateRule; threshold: number | null;
  aggregation: Aggregation; digest: string;
}

/** The holder's casting charter for one entitlement, or the declared default when absent. */
export async function readHolderCharter(env: WorkActivationEnvironment, poll: string,
  entitlement: string): Promise<HolderCharterView | null> {
  const charter = holderCharterComponent(poll, entitlement);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?rule ?threshold ?aggregation
    ?digest WHERE { GRAPH ${iri(CURRENT)} { ${iri(charter)} a rv:VotingCharter ; rv:charterHead ?revision }
    GRAPH ${iri(REVISIONS)} { ?revision a rv:HolderCharterRevision ; rv:mandateRule ?rule ;
      rv:aggregationMode ?aggregation ; rv:charterDigest ?digest .
      OPTIONAL { ?revision rv:approvalThreshold ?threshold } } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1) throw new VoteUnavailable('holder charter is ambiguous');
  return { charter, revision: row.revision!.value, rule: rules[local(row.rule!.value) ?? '']!,
    threshold: row.threshold ? Number(row.threshold.value) : null,
    aggregation: local(row.aggregation!.value) === 'ProportionalSplit' ? 'proportional' : 'whole',
    digest: row.digest!.value };
}

export const ballotComponent = (poll: string, seat: string) => voteId('ballot', poll, seat);

export interface BallotView {
  ballot: string; revision: string; predecessor: string | null;
  availability: 'cast' | 'withdrawn'; countedUnits: number; digest: string;
  shares: { option: string; units: number }[];
}

/** One exact ballot revision, or the current head when `revision` is omitted. */
export async function readBallot(env: WorkActivationEnvironment, poll: string, seat: string,
  revision?: string): Promise<BallotView | null> {
  const ballot = ballotComponent(poll, seat);
  const target = revision ? iri(revision) : '?revision';
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?predecessor ?availability
    ?units ?digest (GROUP_CONCAT(CONCAT(STR(?option), "|", STR(?shareUnits)); separator=" ") AS ?shares) WHERE {
    ${revision ? '' : `GRAPH ${iri(CURRENT)} { ${iri(ballot)} a rv:Ballot ; rv:ballotHead ?revision }`}
    GRAPH ${iri(REVISIONS)} { ${target} a rv:BallotRevision ; rv:ballot ${iri(ballot)} ;
        rv:ballotAvailability ?availability ; rv:countedUnits ?units ; rv:ballotDigest ?digest .
      ${revision ? `BIND(${iri(revision)} AS ?revision)` : ''}
      OPTIONAL { ${target} rv:predecessor ?predecessor }
      OPTIONAL { ?share rv:ballotRevision ${target} ; rv:option ?option ; rv:shareUnits ?shareUnits } }
  } GROUP BY ?revision ?predecessor ?availability ?units ?digest`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length || !rows[0]?.revision) return null;
  const row = rows[0];
  const shares = row.shares?.value ? row.shares.value.split(' ').map(entry => {
    const [option, units] = entry.split('|');
    return { option: option!, units: Number(units) };
  }).sort((a, b) => a.option.localeCompare(b.option)) : [];
  return { ballot, revision: row.revision.value, predecessor: row.predecessor?.value ?? null,
    availability: local(row.availability!.value) === 'BallotCast' ? 'cast' : 'withdrawn',
    countedUnits: Number(row.units!.value), digest: row.digest!.value, shares };
}

/** Distinct approver slots among the listed approvals that bind this exact candidate. */
export async function countApprovals(env: WorkActivationEnvironment, poll: string, seat: string,
  approvals: readonly string[], candidateDigest: string): Promise<number> {
  if (!approvals.length) return 0;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(DISTINCT ?slot) AS ?n) WHERE {
    GRAPH ${iri(REVISIONS)} { VALUES ?approval { ${approvals.map(iri).join(' ')} }
      ?approval a rv:MandateApproval ; rv:poll ${iri(poll)} ; rv:seat ${iri(seat)} ;
        rv:candidateDigest ${JSON.stringify(candidateDigest)} ; rv:approverSlot ?slot } }`);
  return Number(result.results?.bindings[0]?.n?.value ?? '0');
}

export interface TallyView {
  poll: string; state: PollState; seatCount: number; countedUnits: number;
  castSeats: number; castUnits: number; abstainUnits: number; uncastUnits: number;
  options: { key: string; role: OptionRole; units: number; seats: number }[];
}

/** Replayable tally: current ballot heads under the frozen opening; approvals never count. */
export async function readTally(env: WorkActivationEnvironment, poll: string): Promise<TallyView> {
  const view = await readPoll(env, poll);
  if (!view.opening || view.seatCount === null || view.countedUnits === null) {
    throw new VoteUnavailable('poll has not opened');
  }
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?option (SUM(?units) AS ?total)
    (COUNT(DISTINCT ?ballot) AS ?seats) WHERE {
    GRAPH ${iri(CURRENT)} { ?ballot a rv:Ballot ; rv:poll ${iri(poll)} ; rv:ballotHead ?revision }
    GRAPH ${iri(REVISIONS)} { ?revision rv:ballotAvailability rv:BallotCast .
      ?share rv:ballotRevision ?revision ; rv:option ?option ; rv:shareUnits ?units } } GROUP BY ?option`);
  const counted = new Map((result.results?.bindings ?? []).map(row =>
    [row.option!.value, { units: Number(row.total!.value), seats: Number(row.seats!.value) }]));
  const seats = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(?ballot) AS ?n) (SUM(?units) AS ?u)
    WHERE { GRAPH ${iri(CURRENT)} { ?ballot a rv:Ballot ; rv:poll ${iri(poll)} ; rv:ballotHead ?revision }
      GRAPH ${iri(REVISIONS)} { ?revision rv:ballotAvailability rv:BallotCast ; rv:countedUnits ?units } }`);
  const castSeats = Number(seats.results?.bindings[0]?.n?.value ?? '0');
  const castUnits = Number(seats.results?.bindings[0]?.u?.value ?? '0');
  const options = view.options.map(option => ({ key: option.key, role: option.role,
    units: counted.get(option.option)?.units ?? 0, seats: counted.get(option.option)?.seats ?? 0 }));
  const abstainUnits = options.filter(option => option.role === 'abstain').reduce((sum, item) => sum + item.units, 0);
  return { poll, state: view.state, seatCount: view.seatCount, countedUnits: view.countedUnits,
    castSeats, castUnits, abstainUnits, uncastUnits: view.countedUnits - castUnits, options };
}
