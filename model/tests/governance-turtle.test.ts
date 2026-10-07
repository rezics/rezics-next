import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';

const definition = 'https://rezics.com/definition/';
const vocabulary = 'https://rezics.com/vocab/';
const ids = [
  'ballot-mandate-approval-v1',
  'ballot-proxy-v1',
  'ballot-v1',
  'charter-revision-v1',
  'poll-allocation-v1',
  'poll-resolution-v1',
  'poll-snapshot-v1',
  'proposal-v1',
] as const;

const originalPins = {
  'ballot-mandate-approval-v1': '0fecd52c8455390decae35d5641030372402236bdad2c5c96cb32c57fdea6647',
  'ballot-proxy-v1': 'f0d2242d2d8026b9f6283c38c1e5db4efb28e2fec203428a49e225c9a40246c7',
  'ballot-v1': '8ef327fb788d4ab18785ca37f3f6ced829f54458a3bc0087681608d0849ffc05',
  'charter-revision-v1': '7d3903702c3767fd57874688413fa8bd1501c5c0ae3abba04e87dd7c80b78169',
  'poll-allocation-v1': 'c277302719c0570563b7889276e106b9a1cee676551b2932299ad7cf03910ae4',
  'poll-resolution-v1': '47413e42bb40731c023a3129dd1c878b335e73ea20bc6e45204cb166bf2a4654',
  'poll-snapshot-v1': 'f9471026df8866e1ce6379325f83fe20f7be7b3b68d160386e5a1319665b8214',
  'proposal-v1': '5fa5082efb1b4215773347902cf82a11dc925ed9bdb4396cc2461006fe8291ce',
} as const;

const focusRoles = {
  'ballot-mandate-approval-v1': ['approval'],
  'ballot-proxy-v1': ['route', 'revision'],
  'ballot-v1': ['ballot', 'revision', 'share'],
  'charter-revision-v1': ['charter', 'electorate-revision', 'holder-revision'],
  'poll-allocation-v1': ['plan', 'leaf', 'activation'],
  'poll-resolution-v1': ['resolution', 'tally', 'invalidation'],
  'poll-snapshot-v1': ['poll', 'question', 'option', 'snapshot', 'entitlement', 'opening'],
  'proposal-v1': ['proposal', 'revision', 'execution'],
} as const;

const canonicalTypes = {
  'ballot-mandate-approval-v1': { approval: ['rv:MandateApproval'] },
  'ballot-proxy-v1': {
    route: ['rv:ProxyRoute'],
    revision: ['rv:ProxyRouteRevision'],
  },
  'ballot-v1': {
    ballot: ['rv:Ballot'],
    revision: ['rv:BallotRevision'],
    share: ['rv:BallotShare'],
  },
  'charter-revision-v1': {
    charter: ['rv:VotingCharter'],
    'electorate-revision': ['rv:ElectorateCharterRevision'],
    'holder-revision': ['rv:HolderCharterRevision'],
  },
  'poll-allocation-v1': {
    plan: ['rv:AllocationPlan'],
    leaf: ['rv:AllocationLeaf'],
    activation: ['rv:AllocationActivation'],
  },
  'poll-resolution-v1': {
    resolution: ['rv:PollResolution'],
    tally: ['rv:OptionTally'],
    invalidation: ['rv:BallotInvalidation'],
  },
  'poll-snapshot-v1': {
    poll: ['rv:Poll'],
    question: ['rv:PollQuestionRevision'],
    option: ['rv:PollOption'],
    snapshot: ['rv:ElectorateSnapshot'],
    entitlement: ['rv:SourceEntitlement'],
    opening: ['rv:PollOpening'],
  },
  'proposal-v1': {
    proposal: ['rv:Proposal'],
    revision: ['rv:ProposalRevision'],
    execution: ['rv:ProposalExecution'],
  },
} as const;

const alternatives = {
  'ballot-mandate-approval-v1': {},
  'ballot-proxy-v1': {},
  'ballot-v1': { revision: 3 },
  'charter-revision-v1': { 'holder-revision': 4 },
  'poll-allocation-v1': {},
  'poll-resolution-v1': { resolution: 3 },
  'poll-snapshot-v1': { poll: 4 },
  'proposal-v1': { proposal: 5 },
} as const;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const profileById = new Map(authoredProfiles.map((profile) => [profile.id, profile]));

test('governance Turtle preserves original source pins, focus roles and canonical metadata', () => {
  const command = commandProfiles(authoredProfiles);
  const published = new Map(command.profiles.map((profile) => [profile.id, profile]));
  const manifestProfiles = command.manifest.profiles as { id: string; binding?: unknown }[];

  for (const id of ids) {
    const profile = profileById.get(id)!;
    const pin = originalPins[id];
    const roles = focusRoles[id];
    const source = readFileSync(new URL(`../definitions/${id}.ttl`, import.meta.url), 'utf8');
    const role = (iri: string) => iri.split('/').at(-1)!.slice(0, -6);

    expect(digest(profileSource(profile))).toBe(pin);
    expect(profileRegistry[id].sha256).toBe(pin);
    expect(published.get(id)?.sha256).toBe(pin);
    expect(published.get(id)?.focusRoles).toEqual(roles);
    expect(profile.shapes.map((shape) => role(shape.iri))).toEqual(roles);
    expect(Object.fromEntries(profile.shapes.flatMap((shape) => shape.canonical
      ? [[role(shape.iri), shape.canonical.types]]
      : []))).toEqual(canonicalTypes[id]);
    expect(Object.fromEntries(profile.shapes.flatMap((shape) => shape.or
      ? [[role(shape.iri), shape.or.length]]
      : []))).toEqual(alternatives[id]);
    expect(profile.binding).toBeUndefined();
    expect(manifestProfiles.find((entry) => entry.id === id)?.binding).toBeUndefined();
    expect(isTurtleProfile(profile)).toBe(true);
    expect(profileSource(profile)).toBe(source);
    expect(command.shapes.get(`shapes/${id}.ttl`)).toBe(source);
  }
});

test('governance state, availability and threshold fixtures preserve focused constraints', () => {
  const operation = `urn:rezics:operation:${'a'.repeat(64)}`;
  const digestValue = 'a'.repeat(64);
  const ballot = {
    '@id': 'urn:governance:ballot-revision',
    'rdf:type': [`${vocabulary}BallotRevision`],
    'rv:ballot': ['urn:governance:ballot'],
    'rv:pollOpening': ['urn:governance:opening'],
    'rv:ballotAvailability': [`${vocabulary}BallotWithdrawn`],
    'rv:castRoute': [`${vocabulary}HolderCast`],
    'rv:ballotDigest': [digestValue],
    'rv:countedUnits': [0],
    'rv:operation': [operation],
    'rv:submittedAt': ['2026-10-07T00:00:00Z'],
  };
  const holderRevision = {
    '@id': 'urn:governance:holder-charter-revision',
    'rdf:type': [`${vocabulary}VotingCharterRevision`, `${vocabulary}HolderCharterRevision`],
    'rv:charter': ['urn:governance:holder-charter'],
    'rv:ruleRevision': ['urn:governance:rule'],
    'rv:charterDigest': [digestValue],
    'rv:operation': [operation],
    'rv:revisedAt': ['2026-10-07T00:00:00Z'],
    'rv:mandateRule': [`${vocabulary}KOfNApproval`],
    'rv:aggregationMode': [`${vocabulary}WholeBallot`],
    'rv:approvalThreshold': [3],
  };
  const draftPoll = {
    '@id': 'urn:governance:poll',
    'rdf:type': [`${vocabulary}Poll`],
    'rv:governingBody': ['urn:governance:body'],
    'rv:electorateCharter': ['urn:governance:electorate-charter'],
    'rv:questionHead': ['urn:governance:question'],
    'rv:pollState': [`${vocabulary}PollDraft`],
  };

  expect(Value.Check(shapeSchemas[`${definition}ballot-v1/revision-shape`], ballot)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}ballot-v1/revision-shape`], {
    ...ballot,
    'rv:ballotShare': ['urn:governance:share'],
  })).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}charter-revision-v1/holder-revision-shape`], holderRevision))
    .toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}charter-revision-v1/holder-revision-shape`], {
    ...holderRevision,
    'rv:approvalThreshold': [65],
  })).toBe(false);
  expect(Value.Check(shapeSchemas[`${definition}poll-snapshot-v1/poll-shape`], draftPoll)).toBe(true);
  expect(Value.Check(shapeSchemas[`${definition}poll-snapshot-v1/poll-shape`], {
    ...draftPoll,
    'rv:pollOpening': ['urn:governance:opening'],
  })).toBe(false);
});
