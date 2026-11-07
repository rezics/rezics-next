export type GrowthSqlKind = 'statement' | 'control' | 'begin' | 'commit' | 'rollback' | 'rollback-to';
export type GrowthSqlOffset = Readonly<{ operand: string; bareZero: boolean }>;

const MULTI_COMMAND_CONTROL = 'multi-command SQL cannot be classified from its leading control keyword';

function isIdentifierPart(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x80 || /[A-Za-z0-9_$]/.test(character);
}

function isDollarTagChar(character: string, first: boolean): boolean {
  const code = character.charCodeAt(0);
  if (code >= 0x80) return true;
  return first ? /[A-Za-z_]/.test(character) : /[A-Za-z0-9_]/.test(character);
}

function skipTrivia(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    if (/\s/.test(sql[index]!)) {
      index++;
      continue;
    }
    if (sql.startsWith('--', index)) {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
      continue;
    }
    if (!sql.startsWith('/*', index)) return index;

    index += 2;
    let depth = 1;
    while (depth > 0 && index < sql.length) {
      if (sql.startsWith('/*', index)) {
        depth++;
        index += 2;
      } else if (sql.startsWith('*/', index)) {
        depth--;
        index += 2;
      } else index++;
    }
    if (depth > 0) throw new TypeError('unterminated leading SQL block comment');
  }
  return index;
}

function skipQuoted(sql: string, start: number, escapeBackslash: boolean): number {
  const quote = sql[start]!;
  let index = start + 1;
  while (index < sql.length) {
    if (escapeBackslash && sql[index] === '\\') {
      index += 2;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index++;
  }
  throw new TypeError(quote === '"' ? 'unterminated SQL quoted identifier' : 'unterminated SQL string');
}

function dollarTag(sql: string, index: number): string | undefined {
  if (sql[index] !== '$') return undefined;
  let end = index + 1;
  if (sql[end] === '$') return '$$';
  if (sql[end] === undefined || !isDollarTagChar(sql[end]!, true)) return undefined;
  end++;
  while (end < sql.length && isDollarTagChar(sql[end]!, false)) end++;
  if (sql[end] !== '$') return undefined;
  return sql.slice(index, end + 1);
}

function skipLiteral(sql: string, index: number): number {
  const escape =
    (sql[index] === 'E' || sql[index] === 'e') &&
    sql[index + 1] === "'" &&
    (index === 0 || !isIdentifierPart(sql[index - 1]!));
  if (escape) return skipQuoted(sql, index + 1, true);
  if (sql[index] === "'" || sql[index] === '"') return skipQuoted(sql, index, false);
  const tag = dollarTag(sql, index);
  if (tag === undefined) return index;
  const end = sql.indexOf(tag, index + tag.length);
  if (end < 0) throw new TypeError('unterminated SQL dollar-quoted string');
  return end + tag.length;
}

function skipCommand(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    const afterTrivia = skipTrivia(sql, index);
    if (afterTrivia !== index) {
      index = afterTrivia;
      continue;
    }
    if (sql[index] === ';') return index + 1;
    const afterLiteral = skipLiteral(sql, index);
    index = afterLiteral === index ? index + 1 : afterLiteral;
  }
  return index;
}

function hasFurtherExecutableCommand(sql: string, index: number): boolean {
  index = skipTrivia(sql, index);
  while (index < sql.length && sql[index] === ';') index = skipTrivia(sql, index + 1);
  return index < sql.length;
}

function leadingWords(sql: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (words.length < 3) {
    index = skipTrivia(sql, index);
    const first = sql[index];
    if (first === undefined) {
      if (words.length === 0) throw new TypeError('SQL statement is empty or contains only comments');
      break;
    }
    if (!/[A-Za-z_]/.test(first) && first.charCodeAt(0) < 0x80) return words;
    const start = index++;
    while (index < sql.length && isIdentifierPart(sql[index]!)) index++;
    words.push(sql.slice(start, index).toUpperCase());
  }
  return words;
}

function kindFromLeadingWords(
  first: string | undefined,
  second: string | undefined,
  third: string | undefined,
): GrowthSqlKind {
  if (first === 'BEGIN' || (first === 'START' && second === 'TRANSACTION')) return 'begin';
  if (first === 'COMMIT' || first === 'END') return 'commit';
  if (first === 'ABORT') return 'rollback';
  if (first === 'ROLLBACK') {
    const toIndex = second === 'WORK' || second === 'TRANSACTION' ? third : second;
    return toIndex === 'TO' ? 'rollback-to' : 'rollback';
  }
  if (first === 'SAVEPOINT' || first === 'RELEASE') return 'control';
  if (first === 'SET' && (second === 'LOCAL' || second === 'TRANSACTION')) return 'control';
  return 'statement';
}

const OFFSET_BOUNDARIES = new Set(['ROW', 'ROWS', 'FETCH', 'LIMIT', 'FOR']);
const OFFSET_CLAUSE_WORDS = new Set([
  'AS',
  'EXCEPT',
  'FETCH',
  'FOR',
  'FROM',
  'GROUP',
  'HAVING',
  'INTERSECT',
  'JOIN',
  'LIMIT',
  'OFFSET',
  'ON',
  'ORDER',
  'RETURNING',
  'UNION',
  'WHERE',
  'WINDOW',
]);
const OFFSET_NON_CLAUSE_PREDECESSORS = new Set([
  'ALL',
  'AND',
  'AS',
  'BETWEEN',
  'BY',
  'CASE',
  'DISTINCT',
  'ELSE',
  'FROM',
  'GROUP',
  'HAVING',
  'IN',
  'IS',
  'JOIN',
  'LIKE',
  'NOT',
  'ON',
  'OR',
  'ORDER',
  'RETURNING',
  'SELECT',
  'SET',
  'THEN',
  'VALUES',
  'WHEN',
  'WHERE',
  'WINDOW',
]);

function wordEnd(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length && isIdentifierPart(sql[index]!)) index++;
  return index;
}

function operandEnd(sql: string, start: number): number {
  const afterLiteral = skipLiteral(sql, start);
  if (afterLiteral !== start) return afterLiteral;
  const first = sql[start];
  if (first === undefined) return start;
  if (isIdentifierPart(first)) return wordEnd(sql, start);
  return start + 1;
}

function zeroHasClauseBoundary(sql: string, start: number): boolean {
  const next = skipTrivia(sql, start);
  if (next === sql.length || sql[next] === ';' || sql[next] === ')' || sql[next] === ',') return true;
  if (!/[A-Za-z_]/.test(sql[next]!)) return false;
  const end = wordEnd(sql, next);
  return OFFSET_BOUNDARIES.has(sql.slice(next, end).toUpperCase());
}

function isLikelyOffsetClause(sql: string, start: number, previousToken: string | undefined): boolean {
  if (
    previousToken === undefined ||
    OFFSET_NON_CLAUSE_PREDECESSORS.has(previousToken) ||
    ['(', ',', '.', ';', '::', '+', '-', '*', '/', '%', '=', '<', '>', '!', '|', '&', '^'].includes(previousToken)
  )
    return false;

  const operand = skipTrivia(sql, start);
  const first = sql[operand];
  if (first === undefined || first === ')' || first === ',' || first === ';') return false;
  if (/[A-Za-z_]/.test(first)) {
    const end = wordEnd(sql, operand);
    if (OFFSET_CLAUSE_WORDS.has(sql.slice(operand, end).toUpperCase())) return false;
  }
  return true;
}

/** Finds executable OFFSET operands without matching comments, string bodies or quoted identifiers. */
export function executableSqlOffsets(sql: string): readonly GrowthSqlOffset[] {
  const offsets: GrowthSqlOffset[] = [];
  let index = 0;
  let previousToken: string | undefined;
  while (index < sql.length) {
    const afterTrivia = skipTrivia(sql, index);
    if (afterTrivia !== index) {
      index = afterTrivia;
      continue;
    }
    const afterLiteral = skipLiteral(sql, index);
    if (afterLiteral !== index) {
      previousToken = '<literal>';
      index = afterLiteral;
      continue;
    }
    const first = sql[index]!;
    if (/[A-Za-z_]/.test(first) || first.charCodeAt(0) >= 0x80) {
      const end = wordEnd(sql, index);
      if (sql.slice(index, end).toUpperCase() === 'OFFSET') {
        const operandStart = skipTrivia(sql, end);
        if (isLikelyOffsetClause(sql, end, previousToken)) {
          const operandFinish = operandEnd(sql, operandStart);
          const operand = sql.slice(operandStart, operandFinish);
          const bareZero = operand === '0' && zeroHasClauseBoundary(sql, operandFinish);
          offsets.push({ operand, bareZero });
        }
      }
      previousToken = sql.slice(index, end).toUpperCase();
      index = end;
      continue;
    }
    if (index + 1 < sql.length && ['::', '||', '->', '>=', '<=', '<>', '!='].includes(sql.slice(index, index + 2))) {
      previousToken = sql.slice(index, index + 2);
      index += 2;
      continue;
    }
    previousToken = first;
    index++;
  }
  return offsets;
}

/** Classify only leading SQL tokens; comments and quoted or identifier lookalikes are not commands. */
export function classifyGrowthSql(sql: string): GrowthSqlKind {
  const [first, second, third] = leadingWords(sql);
  const kind = kindFromLeadingWords(first, second, third);
  if (kind !== 'statement' && hasFurtherExecutableCommand(sql, skipCommand(sql, skipTrivia(sql, 0))))
    throw new TypeError(MULTI_COMMAND_CONTROL);
  return kind;
}
