import type { ManualSourceIntake, SourceCapture, StagedSourceObservation } from './intake.ts';
import { SourceIntakeInvalid } from './intake.ts';
import { checkedOpenLibraryCapture, openLibraryIdentityValue } from './open-library.ts';
import { BANGUMI_SUBJECT_MAPPING, projectBangumiSubject } from './bangumi-conversion.ts';
import { SourceConversionInvalid } from './open-library-conversion.ts';

/** Provider registrations live at the adapter boundary, never in native owners. */
const captureAdapters = new Map([
  ['open-library-work-acquisition-v1', checkedOpenLibraryCapture],
  ['open-library-author-acquisition-v1', checkedOpenLibraryCapture],
]);
const mappingAdapters = new Map([[BANGUMI_SUBJECT_MAPPING, projectBangumiSubject]]);
const identityAdapters = new Map([['open-library\0work', openLibraryIdentityValue]]);

export function checkedSourceCapture(input: ManualSourceIntake, capture: SourceCapture): void {
  const adapter = captureAdapters.get(capture.profile);
  if (!adapter) throw new SourceIntakeInvalid('source capture has no registered adapter');
  adapter(input, capture);
}

export function projectRegisteredSourceMapping(observation: StagedSourceObservation, mapping: string) {
  const adapter = mappingAdapters.get(mapping);
  if (!adapter) throw new SourceConversionInvalid('source mapping has no verified adapter');
  return adapter(observation);
}

export function decodedProviderIdentity(provider: string, namespace: string, value: unknown): unknown {
  return identityAdapters.get(`${provider}\0${namespace}`)?.(value) ?? value;
}
