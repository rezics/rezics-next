export {
  readPersonalScoreCurrentness,
  readPersonalScoreQuestion,
  unavailablePersonalScoreCurrentness,
  type PersonalScoreCurrentness,
} from '../rating/personal-score.ts';

/** Map a native shelf-score unavailable binding to the Library visit it should surface. */
export function personalScoreUnavailableKind(binding: string): 'preparation' | 'currentness' | 'other' {
  if (binding.includes('libraryShelfScorePreparation')) return 'preparation';
  if (
    binding.includes('identity fence') ||
    binding.includes('score identity') ||
    binding.includes('score currentness') ||
    binding.includes('voter standing')
  )
    return 'currentness';
  return 'other';
}
