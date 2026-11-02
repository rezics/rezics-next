export type GrowthSqlKind = 'statement' | 'control' | 'begin' | 'commit' | 'rollback' | 'rollback-to';

const MULTI_COMMAND_CONTROL =
  'multi-command SQL cannot be classified from its leading control keyword';

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

/** Classify only leading SQL tokens; comments and quoted or identifier lookalikes are not commands. */
export function classifyGrowthSql(sql: string): GrowthSqlKind {
  const [first, second, third] = leadingWords(sql);
  const kind = kindFromLeadingWords(first, second, third);
  if (kind !== 'statement' && hasFurtherExecutableCommand(sql, skipCommand(sql, skipTrivia(sql, 0))))
    throw new TypeError(MULTI_COMMAND_CONTROL);
  return kind;
}
