// Main's union-merged composition roots (.gitattributes merge=union). One list: goalctl merge and
// import de-duplication both read it. `normalize-app.ts` is not used: it rebuilds function signatures
// and dropped `mountedReads` after the G-629 rebase (ee678f81, 2026-10-01).
export const COMPOSITION_ROOTS = [
  'services/main/src/app.ts',
  'services/main/src/index.ts',
  'services/main/src/composition.ts',
  'services/main/src/routes/dependencies.ts',
] as const;
