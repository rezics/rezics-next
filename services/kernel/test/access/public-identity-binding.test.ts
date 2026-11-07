import { expect, test } from 'bun:test';
import type { IdentitySemanticPort } from '../../src/access/contract/index.ts';
import { GrantDeniedError as PublicGrantDenied } from '../../src/access/resource-access-errors.ts';
import { GrantDeniedError as CommandGrantDenied } from '../../src/access/grant-commands.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import type { VoteObservation } from '../../src/rating/index.ts';

test('Access grant denial keeps one public error identity', () => {
  expect(new PublicGrantDenied()).toBeInstanceOf(CommandGrantDenied);
  expect(new PublicGrantDenied().name).toBe('GrantDeniedError');
});

test('Access unavailability is the owner public error', () => {
  expect(new AccessUnavailableError('deadline').name).toBe('AccessUnavailableError');
});

test('missing identity subject binding stays unavailable', () => {
  const identity: IdentitySemanticPort = {
    accountAgentId: (id) => id,
    async accountAgentsForSubjects() {
      return new Map();
    },
    async readOriginalAccountAgentIdentity() {
      return null;
    },
    async withReadTransaction(_pool, body) {
      return body({ query: async () => ({ rows: [], rowCount: 0 }) });
    },
  };
  expect(identity.readPublicSubject).toBeUndefined();
});

test('Rating vote observation type is the public contract', () => {
  const observation: VoteObservation = {
    subjectId: '11111111-1111-4111-8111-111111111111',
    question: {
      id: 'q',
      revision: 1,
      grain: 'work',
      meaning: 'like',
      scale: { min: 0, max: 20, displayStep: 1 },
    },
  };
  expect(observation.question.revision).toBe(1);
});
