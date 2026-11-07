export type ScoreOrderReadState = 'preparing' | 'score-unavailable';

export type { PersonalScoreWriteCommand, PersonalScoreWriteResult } from './score-write';
export {
  classifyPersonalScoreWriteProblem,
  personalScoreDiscoveryWrite,
  personalScoreWriteCommand,
  personalScoreWriteNotice,
} from './score-write';

export function scoreOrderReadState(detail: string | undefined): ScoreOrderReadState | undefined {
  if (!detail) return undefined;
  if (detail.includes('libraryShelfScorePreparation')) return 'preparing';
  if (
    detail.includes('identity fence') ||
    detail.includes('score identity') ||
    detail.includes('score currentness') ||
    detail.includes('voter standing')
  )
    return 'score-unavailable';
  return undefined;
}
