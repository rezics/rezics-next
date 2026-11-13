import * as v from 'valibot';
import type { StudioResult } from './contract';
import {
  hostedId,
  type HostedBookNative,
  type HostedOwnerViewer,
  type HostedPublicationPointNative,
} from './hosted-contract';
import type { HostedReleaseReaderAdmission } from './hosted-release-reader-link';

const count = v.pipe(v.string(), v.regex(/^(0|[1-9][0-9]*)$/));
/** Content's native progress, without a browser authority projection or a publication claim from readiness. */
export const activationProgress = v.strictObject({
  catalogueId: hostedId,
  stageId: hostedId,
  state: v.picklist(['checking', 'ready', 'restart', 'activated']),
  passId: hostedId,
  checkedTargetCount: count,
  totalTargetCount: count,
  candidateGenerationId: hostedId,
  publicationId: v.nullable(hostedId),
  restartRequired: v.boolean(),
});
export type ActivationProgress = v.InferOutput<typeof activationProgress>;
export type ActivationKind = 'start' | 'advance' | 'activate';
export type ActivationRequest = Readonly<{
  kind: ActivationKind;
  catalogueId: string;
  stageId: string;
  /** A response comparison operand, never a writable native authority assertion. */
  candidateGenerationId: string;
  expectedViewer: HostedOwnerViewer;
  idempotencyKey: string;
  /** The native commands digest exactly this intent. Restart is an explicit advance, with a fresh key. */
  body: Readonly<{ stageId: string }>;
}>;
export type ActivationCommand = (
  input: ActivationRequest,
  signal: AbortSignal,
  csrfToken: string,
) => Promise<StudioResult<ActivationProgress>>;

/** A future generated transport binds these native operations. No URL or proxy method is guessed here. */
export type ActivationOperation = (
  input: Omit<ActivationRequest, 'kind'>,
  signal: AbortSignal,
  csrfToken: string,
) => Promise<StudioResult<unknown>>;
export type ActivationReads = Pick<HostedBookNative, 'readOwn'> &
  Pick<HostedPublicationPointNative, 'readMetadata'> & { admitPublic: HostedReleaseReaderAdmission };
export type HostedReleaseActivationOperations = ActivationReads & {
  startHostedPublicationActivation: ActivationOperation;
  advanceHostedPublicationActivationAuthority: ActivationOperation;
  activateHostedPublicationCandidate: ActivationOperation;
};
export type HostedReleaseActivationTransport = ActivationReads & { command: ActivationCommand };
