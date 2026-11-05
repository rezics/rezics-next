export function scoreOrderReadState(detail: string | undefined): 'preparing' | 'score-unavailable' | undefined {
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
