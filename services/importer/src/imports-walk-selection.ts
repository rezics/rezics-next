export type WalkSelection = { scope: 'operators' | 'catalogue' | 'all'; reopenSeed: boolean };

export function parseWalkSelection(args: readonly string[]): WalkSelection {
  const [flag, scope, ...rest] = args;
  const selectedScope =
    flag === '--scope' && (scope === 'operators' || scope === 'catalogue' || scope === 'all') ? scope : undefined;
  const flags = selectedScope ? rest : args;
  const reopenSeed = flags.length === 1 && flags[0] === '--reopen-seed';
  if ((flags.length > 0 && !reopenSeed) || (selectedScope === 'operators' && reopenSeed))
    throw new Error(
      'Usage: imports-public-journey.ts --reviewed-bootstrap | [--scope operators|catalogue|all] [--reopen-seed (catalogue or all)]',
    );
  return { scope: selectedScope ?? 'all', reopenSeed };
}

export function reviewedWalkProbe(args: readonly string[]) {
  const [flag] = args;
  if (args.length === 1 && (flag === '--reviewed-bootstrap' || flag === '--reviewed-source-scheme')) return flag;
}
