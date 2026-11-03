import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { resourceAuthorization } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, principalCommandIdentity, runCommand } from '../command/command.ts';
import realmRead from '../community/realm-read.sql';
import type { Access, Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import insert from './question-authoring-insert.sql';

export const QUESTION_CREATED = 'com.rezics.rating.question.created.v1';
export type QuestionGrain = 'work' | 'release' | 'episode' | 'character';
export type RealmQuestionInput = Readonly<{
  realmId: string;
  meaning: string;
  label: string;
  grain: QuestionGrain;
  scale: Readonly<{ min: number; max: number; displayStep: number }>;
}>;

export class QuestionDefinitionInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid rating question field: ${field}`);
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= maximum && !value.includes('\0');
}

/** This envelope is the installed vote SQL/event capability, not a scale codec.
 * Scale delivery owns expanding it across persistence, events and aggregates. */
export function validateQuestionDefinition(input: RealmQuestionInput): void {
  if (!input || typeof input !== 'object' || routeOf(input.realmId) === null)
    throw new QuestionDefinitionInvalidError('realmId');
  if (!boundedText(input.label, 200)) throw new QuestionDefinitionInvalidError('label');
  if (!boundedText(input.meaning, 2000)) throw new QuestionDefinitionInvalidError('meaning');
  if (!['work', 'release', 'episode', 'character'].includes(input.grain))
    throw new QuestionDefinitionInvalidError('grain');
  const scale = input.scale;
  if (
    !scale ||
    !Number.isSafeInteger(scale.min) ||
    !Number.isSafeInteger(scale.max) ||
    !Number.isSafeInteger(scale.displayStep) ||
    scale.min < 0 ||
    scale.max > 20 ||
    scale.max <= scale.min ||
    scale.displayStep < 1 ||
    (scale.max - scale.min) % scale.displayStep !== 0
  )
    throw new QuestionDefinitionInvalidError('scale');
}

/** One Realm-home command, receipt and event. The current native manage decision
 * precedes receipt lookup on every attempt, including an exact replay. */
export async function createRealmRatingQuestion(
  deps: { pool: Pool; access: Access; clock?: KernelClock },
  actor: Actor,
  input: RealmQuestionInput,
  context: { deadline: number; idempotencyKey: string },
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  validateQuestionDefinition(input);
  // Copy the complete definition so mutation cannot change the digest or body during preparation.
  const body = {
    realmId: input.realmId,
    meaning: input.meaning,
    label: input.label,
    grain: input.grain,
    scale: { min: input.scale.min, max: input.scale.max, displayStep: input.scale.displayStep },
  };
  const route = routeOf(body.realmId)!;
  const identity = principalCommandIdentity(actor);
  const kind = 'rating.question.create';
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'realm:manage',
    anchor: {
      resource: { route, id: body.realmId },
      async validate(client, time) {
        return !!(await realmRead.run(client, { route, id: body.realmId, at: authoritativeTimeValue(time) }));
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: {
        kind,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, kind, body])!)
          .digest(),
      },
      authorization,
    },
    async (tx) => {
      const id = newId(route);
      await insert.run(tx, {
        id,
        owner_id: actor.accountId,
        realm_id: body.realmId,
        meaning: body.meaning,
        label: body.label,
        grain: body.grain,
        minimum_units: body.scale.min,
        maximum_units: body.scale.max,
        step_units: body.scale.displayStep,
      });
      return {
        value: {
          id,
          realmId: body.realmId,
          meaning: body.meaning,
          revision: 1,
          lifecycle: { state: 'active', revision: 1 },
          label: body.label,
          canonicalLabel: body.label,
          labelRevision: 1,
          grain: body.grain,
          scale: body.scale,
        },
        events: [
          {
            type: QUESTION_CREATED,
            subject: id,
            data: { questionId: id, realmId: body.realmId, ownerId: actor.accountId, revision: 1 },
          },
        ],
      };
    },
  );
}
