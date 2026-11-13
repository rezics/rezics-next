import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { StudioResult } from './contract';
import { hostedFailure } from './hosted-native';
import {
  releaseProgress,
  type ReleaseProgress,
  type ReleaseRequest,
  type ReleaseStartBody,
  type ReleaseSelectionBatch,
} from './hosted-release-preparation-contract';

type Result = { status: number; data?: unknown; error?: unknown };
type Options = {
  headers: Record<string, string>;
  fetch: { signal: AbortSignal; cache: 'no-store'; redirect: 'manual' };
};
type Method<Body> = { post(body: Body, options: Options): Promise<Result> };
/** Mounted routes missing from client emission; Eden's existing proxy supplies these methods unchanged. */
type PreparationClient = ReturnType<KernelClient['hostedCatalogues']> & {
  $prepareRelease: Method<ReleaseStartBody>;
  publicationPreparations(locator: { stageId: string }): {
    $appendSelectionBatch: Method<ReleaseSelectionBatch>;
    $freezeSelection: Method<Record<string, never>>;
    $advance: Method<{ stepId: string }>;
    $progress: Method<Record<string, never>>;
    $seal: Method<Record<string, never>>;
    $cancel: Method<Record<string, never>>;
  };
};
export type ReleaseCommand = (
  input: ReleaseRequest,
  signal: AbortSignal,
  csrfToken: string,
) => Promise<StudioResult<ReleaseProgress>>;
export const releaseUnknown = () =>
  hostedFailure('uncertain', 'The preparation result is unknown. Retry the same command.');

function hasPinnedBinding(progress: ReleaseProgress): boolean {
  return (
    typeof progress.stage.sourceRevisionId === 'string' &&
    progress.stage.sourceRevisionId === progress.stage.expectedHeadRevisionId &&
    Object.prototype.hasOwnProperty.call(progress.stage, 'expectedPublicationId')
  );
}

export function createReleaseCommand(client: KernelClient): ReleaseCommand {
  return async (input, signal) => {
    const book = client.hostedCatalogues({ id: input.catalogueId }) as PreparationClient;
    const options: Options = {
      headers: { 'idempotency-key': JSON.stringify(input.idempotencyKey) },
      fetch: { signal, cache: 'no-store', redirect: 'manual' },
    };
    let response: Result;
    try {
      if (input.kind === 'start') response = await book.$prepareRelease.post(input.body, options);
      else {
        const stage = book.publicationPreparations({ stageId: input.stageId });
        switch (input.kind) {
          case 'append':
            response = await stage.$appendSelectionBatch.post(input.body, options);
            break;
          case 'freeze':
            response = await stage.$freezeSelection.post(input.body, options);
            break;
          case 'advance':
            response = await stage.$advance.post(input.body, options);
            break;
          case 'progress':
            response = await stage.$progress.post(input.body, options);
            break;
          case 'seal':
            response = await stage.$seal.post(input.body, options);
            break;
          case 'cancel':
            response = await stage.$cancel.post(input.body, options);
            break;
        }
      }
    } catch {
      return releaseUnknown();
    }
    if (response.status === 412)
      return hostedFailure('stale', 'The reviewed source or preparation is no longer current.');
    if (response.status === 401 || response.status === 403)
      return hostedFailure('denied', 'This author session cannot prepare the Book.');
    if (response.status === 404)
      return hostedFailure(
        'unavailable',
        'This private preparation is unavailable under the current author admission.',
      );
    if ([400, 409, 413, 422].includes(response.status))
      return hostedFailure('invalid', 'The preparation command was rejected.');
    if (response.status !== (input.kind === 'start' ? 202 : 200) || response.error) return releaseUnknown();
    const parsed = v.safeParse(releaseProgress, response.data);
    // A cross-stage or malformed HTTP reply cannot acknowledge a command or enable sealing.
    if (
      !parsed.success ||
      parsed.output.catalogueId !== input.catalogueId ||
      parsed.output.stageId !== input.stageId ||
      parsed.output.stage.locator.catalogueId !== input.catalogueId ||
      parsed.output.stage.locator.stageId !== input.stageId ||
      (input.kind === 'start' && input.body.stageId !== input.stageId)
    )
      return releaseUnknown();
    const expectedMode =
      input.kind === 'start'
        ? input.body.mode
        : input.kind === 'append' || input.kind === 'freeze'
          ? 'selection'
          : input.expectedMode;
    // A wrong-mode response or missing batch acknowledgement cannot resolve an append.
    if (
      (expectedMode && parsed.output.stage.mode !== expectedMode) ||
      (input.kind === 'append' &&
        (!parsed.output.batch || parsed.output.batch.itemCount !== input.body.occurrenceIds.length))
    )
      return releaseUnknown();
    if (parsed.output.stage.mode !== 'selection' || hasPinnedBinding(parsed.output))
      return { ok: true, value: parsed.output };

    // Old command receipts remain replayable. A new private progress read supplies only their immutable binding.
    const stage = book.publicationPreparations({ stageId: input.stageId });
    let current: Result;
    try {
      current = await stage.$progress.post(
        {},
        {
          headers: { 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
          fetch: options.fetch,
        },
      );
    } catch {
      return releaseUnknown();
    }
    if (current.status !== 200 || current.error) return releaseUnknown();
    const fresh = v.safeParse(releaseProgress, current.data);
    if (
      !fresh.success ||
      fresh.output.catalogueId !== input.catalogueId ||
      fresh.output.stageId !== input.stageId ||
      fresh.output.stage.locator.catalogueId !== input.catalogueId ||
      fresh.output.stage.locator.stageId !== input.stageId ||
      fresh.output.stage.mode !== (expectedMode ?? parsed.output.stage.mode) ||
      !hasPinnedBinding(fresh.output)
    )
      return releaseUnknown();
    return {
      ok: true,
      value: {
        ...parsed.output,
        stage: {
          ...parsed.output.stage,
          sourceRevisionId: fresh.output.stage.sourceRevisionId,
          expectedHeadRevisionId: fresh.output.stage.expectedHeadRevisionId,
          expectedPublicationId: fresh.output.stage.expectedPublicationId,
        },
      },
    };
  };
}
