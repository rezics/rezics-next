export type GrowthSqlKind = 'statement' | 'control' | 'begin' | 'commit' | 'rollback' | 'rollback-to';

function isIdentifierPart(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x80 || /[A-Za-z0-9_$]/.test(character);
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

/** Classify only leading SQL tokens; comments and quoted or identifier lookalikes are not commands. */
export function classifyGrowthSql(sql: string): GrowthSqlKind {
  const [first, second, third] = leadingWords(sql);
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
