import * as v from 'valibot';
import {
  activationProgress,
  type ActivationCommand,
  type HostedReleaseActivationOperations,
  type HostedReleaseActivationTransport,
} from './hosted-release-activation-contract';

export const activationUnknown = () => ({
  ok: false as const,
  error: { kind: 'uncertain' as const, message: 'The activation command result is unknown. Replay the same intent.' },
});

/** Only the operation boundary parses external replies. Other modules consume the admitted native types. */
export function createHostedReleaseActivationTransport(
  operations: HostedReleaseActivationOperations,
): HostedReleaseActivationTransport {
  const command: ActivationCommand = async ({ kind, ...input }, signal, csrfToken) => {
    const operation = {
      start: operations.startHostedPublicationActivation,
      advance: operations.advanceHostedPublicationActivationAuthority,
      activate: operations.activateHostedPublicationCandidate,
    }[kind];
    let result;
    try {
      result = await operation(input, signal, csrfToken);
    } catch (error) {
      // Fetch can lose a committed reply. Programmer errors still throw.
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError'))
        return activationUnknown();
      throw error;
    }
    if (!result.ok) return result;
    const parsed = v.safeParse(activationProgress, result.value);
    // A foreign stage/generation or incoherent progress cannot acknowledge this exact command.
    if (
      !parsed.success ||
      parsed.output.catalogueId !== input.catalogueId ||
      parsed.output.stageId !== input.stageId ||
      parsed.output.candidateGenerationId !== input.candidateGenerationId
    )
      return activationUnknown();
    const value = parsed.output;
    if (
      BigInt(value.checkedTargetCount) > BigInt(value.totalTargetCount) ||
      value.restartRequired !== (value.state === 'restart') ||
      (value.state === 'activated' ? value.publicationId === null : value.publicationId !== null) ||
      (['ready', 'activated'].includes(value.state) && value.checkedTargetCount !== value.totalTargetCount)
    )
      return activationUnknown();
    return { ok: true, value };
  };
  return {
    command,
    readOwn: (...args) => operations.readOwn(...args),
    readMetadata: (...args) => operations.readMetadata(...args),
    admitPublic: (...args) => operations.admitPublic(...args),
  };
}
