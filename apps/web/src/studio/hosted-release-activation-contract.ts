import * as v from 'valibot';
import type { StudioResult } from './contract';
import {
  hostedId,
  hostedKey,
  hostedOwnerViewer,
  type HostedBookNative,
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
/** The server-function HTTP boundary admits the command envelope; native authority stays with Content. */
export const activationRequest = v.strictObject({
  kind: v.picklist(['start', 'advance', 'activate']),
  catalogueId: hostedId,
  stageId: hostedId,
  /** A response comparison operand, never a writable native authority assertion. */
  candidateGenerationId: hostedId,
  expectedViewer: hostedOwnerViewer,
  idempotencyKey: hostedKey,
  /** The stage is a path operand. Every activation command has the native strict empty body. */
  body: v.strictObject({}),
});
export type ActivationRequest = Readonly<v.InferOutput<typeof activationRequest>>;
export type ActivationKind = ActivationRequest['kind'];
export type ActivationCommand = (
  input: ActivationRequest,
  signal: AbortSignal,
  csrfToken: string,
) => Promise<StudioResult<ActivationProgress>>;

/** The generated server transport and illustrative consumers share this operation boundary. */
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
