// Main's union-merged composition roots (.gitattributes merge=union). One list: goalctl merge and
// import de-duplication both read it.
export const COMPOSITION_ROOTS = [
  'services/main/src/app.ts',
  'services/main/src/index.ts',
  'services/main/src/composition.ts',
  'services/main/src/routes/dependencies.ts',
] as const;
