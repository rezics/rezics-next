export const personas = [
  'visitor',
  'stranger',
  'member',
  'owner',
  'moderator',
  'operator',
] as const;
export type Persona = (typeof personas)[number];
export type OutcomeCell =
  | { state: 'proved' | 'pending'; test: string; file?: string }
  | { state: 'notApplicable'; reason: string };
export interface RowOutcomes {
  rowId: string;
  cells: Partial<Record<Persona, OutcomeCell>>;
  rights?: { basis: string; credit: string };
}

function nonempty(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty`);
  return value;
}

export function proved(test: string, file?: string): OutcomeCell {
  return {
    state: 'proved',
    test: nonempty(test, 'Outcome test'),
    ...(file === undefined ? {} : { file: nonempty(file, 'Outcome file') }),
  };
}

export function pending(test: string, file?: string): OutcomeCell {
  return {
    state: 'pending',
    test: nonempty(test, 'Outcome test'),
    ...(file === undefined ? {} : { file: nonempty(file, 'Outcome file') }),
  };
}

export function notApplicable(reason: string): OutcomeCell {
  return { state: 'notApplicable', reason: nonempty(reason, 'Not-applicable reason') };
}

export function rowOutcomes(
  id: string,
  cells: RowOutcomes['cells'],
  options: Pick<RowOutcomes, 'rights'> = {},
): RowOutcomes {
  nonempty(id, 'Outcome row ID');
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) throw new Error(`Invalid outcome row ID: ${id}`);
  const normalized: RowOutcomes['cells'] = {};
  for (const [persona, cell] of Object.entries(cells)) {
    if (!personas.includes(persona as Persona))
      throw new Error(`Unknown outcome persona: ${persona}`);
    if (cell === undefined) continue;
    if (cell.state === 'notApplicable') nonempty(cell.reason, 'Not-applicable reason');
    else if (cell.state === 'proved' || cell.state === 'pending') {
      nonempty(cell.test, 'Outcome test');
      if (cell.file !== undefined) nonempty(cell.file, 'Outcome file');
    } else throw new Error(`Invalid outcome state for ${id} / ${persona}`);
    normalized[persona as Persona] =
      cell.state === 'notApplicable'
        ? { ...cell }
        : { ...cell, file: cell.file ?? `tests/qa/integration/outcomes/${id}.test.ts` };
  }
  if (options.rights) {
    nonempty(options.rights.basis, 'Rights basis');
    nonempty(options.rights.credit, 'Rights credit');
  }
  return {
    rowId: id,
    cells: normalized,
    ...(options.rights ? { rights: { ...options.rights } } : {}),
  };
}

export function outcomeTitle(declaration: RowOutcomes, persona: Persona): string {
  const cell = declaration.cells[persona];
  if (!cell || cell.state === 'notApplicable')
    throw new Error(`No outcome test for ${declaration.rowId} / ${persona}`);
  return `${declaration.rowId} / ${persona}: ${cell.test}`;
}
