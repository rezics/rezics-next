import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { hostedId, hostedKey, hostedOwnerViewer, type HostedOwnerViewer } from './hosted-contract';

type Advance = ReturnType<KernelClient['hostedCatalogues']>['$advanceLegacyPublicBaseline']['post'];
export type BaselineBody = Parameters<Advance>[0];
export type BaselineProgress = NonNullable<Awaited<ReturnType<Advance>>['data']>;
export type BaselineVersion = Pick<BaselineBody, 'expectedRevisionId' | 'expectedPublicationId'>;
export type BaselineRequest = {
  catalogueId: string;
  expectedViewer: HostedOwnerViewer;
  idempotencyKey: string;
  body: BaselineBody;
};

const frontier = v.strictObject({ afterOrdinal: v.pipe(v.number(), v.safeInteger(), v.minValue(-1)) });
const cursorId = v.union([hostedId, v.literal('00000000-0000-0000-0000-000000000000')]);
const receivingCursor = v.strictObject({
  phase: v.picklist(['occurrences', 'nodes', 'roots', 'complete']),
  occurrenceAfterOrdinal: v.pipe(v.string(), v.regex(/^(?:0|[1-9][0-9]{0,15})$/)),
  nodeAfterKind: v.picklist(['', 'chapters', 'preorder', 'siblings']),
  nodeAfterId: cursorId,
  rootNullDone: v.boolean(),
  rootAfterParentId: cursorId,
});
const version = { expectedRevisionId: hostedId, expectedPublicationId: hostedId };
export const baselineBody = v.variant('step', [
  v.strictObject({ ...version, step: v.literal('startBuild') }),
  v.strictObject({ ...version, step: v.literal('build'), frontier }),
  v.strictObject({ ...version, step: v.literal('seal'), frontier }),
  v.strictObject({ ...version, step: v.literal('receive'), frontier }),
  v.strictObject({ ...version, step: v.literal('apply'), cursor: receivingCursor }),
  v.strictObject({ ...version, step: v.literal('complete') }),
]) satisfies v.GenericSchema<BaselineBody>;
export const baselineRequest = v.strictObject({
  catalogueId: hostedId,
  expectedViewer: hostedOwnerViewer,
  idempotencyKey: hostedKey,
  body: baselineBody,
}) satisfies v.GenericSchema<BaselineRequest>;
export const baselineProgress = v.pipe(
  v.strictObject({
    catalogueId: hostedId,
    sourcePublicationId: hostedId,
    expectedPlacementCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    nextStep: v.picklist(['build', 'seal', 'receive', 'apply', 'complete', 'done']),
    buildFrontier: v.nullable(frontier),
    sealFromFrontier: v.nullable(frontier),
    receivingCursor: v.nullable(receivingCursor),
  }),
  // A malformed HTTP receipt must not turn an absent frontier into a new command.
  v.check((value) => {
    switch (value.nextStep) {
      case 'build':
        return value.buildFrontier !== null;
      case 'seal':
      case 'receive':
        return value.sealFromFrontier !== null;
      case 'apply':
        return value.receivingCursor !== null;
      default:
        return true;
    }
  }),
) satisfies v.GenericSchema<BaselineProgress>;

/** Native nextStep is the only authority for continuation and completion. */
export function baselineNextBody(
  { expectedRevisionId, expectedPublicationId }: BaselineVersion,
  progress: BaselineProgress | null,
): BaselineBody | null {
  const version = { expectedRevisionId, expectedPublicationId };
  if (!progress) return { ...version, step: 'startBuild' };
  switch (progress.nextStep) {
    case 'build':
      return { ...version, step: 'build', frontier: progress.buildFrontier! };
    case 'seal':
      return { ...version, step: 'seal', frontier: progress.sealFromFrontier! };
    case 'receive':
      return { ...version, step: 'receive', frontier: progress.sealFromFrontier! };
    case 'apply':
      return { ...version, step: 'apply', cursor: progress.receivingCursor! };
    case 'complete':
      return { ...version, step: 'complete' };
    case 'done':
      return null;
  }
}
