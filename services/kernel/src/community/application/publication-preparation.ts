import type {
  CommunityPublicationPreparationInput,
  CommunityPublicationPreparationObservation,
  CommunityPublicationPreparationPort,
} from '../contract/index.ts';

/** Current selected-work inspection is read-only and retains its actual source components. */
export function readPublicationPreparation(
  port: CommunityPublicationPreparationPort,
  input: CommunityPublicationPreparationInput,
): Promise<CommunityPublicationPreparationObservation | null> {
  return port.read(input);
}
