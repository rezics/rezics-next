import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The pinned TS 7 compiler is native; the already installed TS 6 compatibility
// package exposes the source parser used here (also required by Astro).
import ts from 'typescript-6';
import { migrationDirectories, migrationRecords } from '../ops/migrate.ts';

export interface SqlSource {
  file: string;
  text: string;
}
export interface RelationReference {
  file: string;
  line: number;
  relation: string;
}
interface Token {
  text: string;
  offset: number;
  quoted?: boolean;
  string?: boolean;
}

// A SQL lexer keeps comments, values and function calls out of relation positions.
// Dollar bodies remain visible: owner migrations put DDL in DO blocks.
function tokens(sql: string): Token[] {
  const result: Token[] = [];
  const pattern =
    /--[^\n]*|\/\*[\s\S]*?\*\/|\$[a-z_0-9]*\$|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9$]*|[^\s]/gi;
  for (const match of sql.matchAll(pattern)) {
    const raw = match[0];
    if (raw.startsWith('--') || raw.startsWith('/*') || /^\$[a-z_0-9]*\$$/i.test(raw)) continue;
    result.push({
      text: raw.startsWith('"')
        ? raw.slice(1, -1).replaceAll('""', '"')
        : raw.startsWith("'")
          ? raw.slice(1, -1).replaceAll("''", "'")
          : raw.toLowerCase(),
      offset: match.index,
      quoted: raw.startsWith('"'),
      string: raw.startsWith("'"),
    });
  }
  return result;
}

function word(token: Token | undefined, text: string): boolean {
  return token?.text === text && !token.string && !token.quoted;
}
function identifier(token: Token | undefined): boolean {
  return !!token && !token.string && (token.quoted || /^[a-z_][a-z_0-9$]*$/.test(token.text));
}
function qualified(input: Token[], at: number): string | undefined {
  return identifier(input[at]) &&
    word(input[at + 1], '.') &&
    identifier(input[at + 2]) &&
    !input[at].text.includes('?') &&
    !input[at + 2].text.includes('?') &&
    !input[at + 2].text.includes('${') &&
    !(input[at + 2].text.endsWith('$') && word(input[at + 3], '{')) &&
    !(
      word(input[at + 3], '?') &&
      input[at + 3].offset === input[at + 2].offset + input[at + 2].text.length
    )
    ? `${input[at].text}.${input[at + 2].text}`
    : undefined;
}
function afterModifiers(input: Token[], at: number): number {
  while (
    ['if', 'not', 'exists', 'only', 'concurrently'].some((modifier) => word(input[at], modifier))
  )
    at++;
  return at;
}

function splitArguments(input: Token[]): Token[][] {
  const result: Token[][] = [[]];
  let depth = 0;
  for (const token of input) {
    if (word(token, '(') || word(token, '[')) depth++;
    if (word(token, ')') || word(token, ']')) depth--;
    if (word(token, ',') && depth === 0) result.push([]);
    else result.at(-1)!.push(token);
  }
  return result;
}

/** Expand the finite FOREACH/format DDL idiom used by vocabulary renames.
 * Unsupported topology-changing dynamic DDL fails closed, never retaining stale names. */
function dynamicDdl(source: SqlSource): { start: number; end: number; sql: string }[] {
  const result: { start: number; end: number; sql: string }[] = [];
  const input = tokens(source.text);
  const arrays = new Map<string, string[]>();
  for (let i = 0; i < input.length; i++) {
    if (!word(input[i], 'foreach') || !identifier(input[i + 1])) continue;
    let end = i + 2;
    while (end < input.length && !word(input[end], 'loop')) end++;
    const values = input
      .slice(i + 2, end)
      .filter((token) => token.string)
      .map((token) => token.text);
    if (values.length) arrays.set(input[i + 1].text, values);
  }
  for (let i = 0; i < input.length; i++) {
    if (!word(input[i], 'execute')) continue;
    let end = i + 1;
    while (end < input.length && !word(input[end], ';')) end++;
    const body = input.slice(i + 1, end);
    const format = body.find((token) => token.string)?.text;
    const combined = body
      .filter((token) => token.string)
      .map((token) => token.text)
      .join('');
    if (
      !format ||
      !/^(?:create\s+(?:table|view|materialized\s+view|sequence)|drop\s+(?:table|view|sequence|schema)|alter\s+(?:table|view|sequence)\b[\s\S]*\b(?:rename\s+to|set\s+schema))/i.test(
        combined,
      )
    )
      continue;
    const fail = () => {
      throw new Error(`${source.file}: unsupported dynamic relation DDL: ${format}`);
    };
    if (body.length === 1 && body[0].string) {
      result.push({
        start: input[i].offset,
        end: (input[end]?.offset ?? source.text.length - 1) + 1,
        sql: format + ';',
      });
      continue;
    }
    if (!word(body[0], 'format') || !word(body[1], '(') || !word(body.at(-1), ')')) fail();
    const args = splitArguments(body.slice(2, -1));
    const variables = [...arrays.keys()].filter((key) =>
      args.slice(1).some((arg) => arg.some((token) => !token.string && token.text === key)),
    );
    if (variables.length > 1) fail();
    const statements: string[] = [];
    for (const value of variables.length ? arrays.get(variables[0])! : ['']) {
      const evaluate = (arg: Token[]): string => {
        if (arg.length === 1 && arg[0].string) return arg[0].text;
        if (arg.length === 1 && variables.includes(arg[0].text)) return value;
        if (word(arg[0], 'replace') && word(arg[1], '(') && word(arg.at(-1), ')')) {
          const parts = splitArguments(arg.slice(2, -1));
          if (parts.length === 3)
            return evaluate(parts[0]).split(evaluate(parts[1])).join(evaluate(parts[2]));
        }
        fail();
        return '';
      };
      let next = 1;
      statements.push(
        format.replace(
          /%%|%(?:(\d+)\$)?([Is])/g,
          (placeholder, position: string | undefined, kind: string) => {
            if (placeholder === '%%') return '%';
            const arg = args[position ? Number(position) : next++];
            if (!arg) {
              fail();
              return '';
            }
            const rendered = evaluate(arg);
            return kind === 'I' ? `"${rendered.replaceAll('"', '""')}"` : rendered;
          },
        ),
      );
    }
    result.push({
      start: input[i].offset,
      end: (input[end]?.offset ?? source.text.length - 1) + 1,
      sql: statements.join('; ') + ';',
    });
  }
  return result;
}

export function migratedRelations(sources: SqlSource[]): Set<string> {
  const relations = new Set<string>();
  for (const source of sources) {
    // Expand dynamic statements at their original position, before following DDL.
    let expanded = source.text;
    for (const statement of dynamicDdl(source).reverse()) {
      expanded = expanded.slice(0, statement.start) + statement.sql + expanded.slice(statement.end);
    }
    const input = tokens(expanded);
    for (let i = 0; i < input.length; i++) {
      const operation = input[i];
      if (!['create', 'alter', 'drop'].some((value) => word(operation, value))) continue;
      let kind = i + 1;
      if (word(input[kind], 'or') && word(input[kind + 1], 'replace')) kind += 2;
      if (word(input[kind], 'unique') || word(input[kind], 'materialized')) kind++;
      if (
        !['table', 'view', 'sequence', 'index', 'schema'].some((value) => word(input[kind], value))
      )
        continue;
      const at = afterModifiers(input, kind + 1);
      if (word(input[kind], 'schema')) {
        if (word(operation, 'drop'))
          for (const relation of relations) {
            if (relation.startsWith(`${input[at]?.text}.`)) relations.delete(relation);
          }
        continue;
      }
      let name = qualified(input, at);
      if (
        !name &&
        word(input[kind], 'index') &&
        word(operation, 'create') &&
        identifier(input[at])
      ) {
        let on = at + 1;
        while (on < input.length && !word(input[on], 'on') && !word(input[on], ';')) on++;
        const table = qualified(input, afterModifiers(input, on + 1));
        if (table) name = `${table.split('.')[0]}.${input[at].text}`;
      }
      if (!name) continue;
      if (word(operation, 'create')) relations.add(name);
      if (word(operation, 'drop')) {
        relations.delete(name);
        // Comma-separated DROP TABLE lists.
        let atNext = at + 3;
        while (word(input[atNext], ',') && qualified(input, atNext + 1)) {
          relations.delete(qualified(input, atNext + 1)!);
          atNext += 4;
        }
      }
      if (word(operation, 'alter')) {
        const rename = at + 3;
        if (
          word(input[rename], 'rename') &&
          word(input[rename + 1], 'to') &&
          identifier(input[rename + 2])
        ) {
          relations.delete(name);
          relations.add(`${name.split('.')[0]}.${input[rename + 2].text}`);
        }
        if (
          word(input[rename], 'set') &&
          word(input[rename + 1], 'schema') &&
          identifier(input[rename + 2])
        ) {
          relations.delete(name);
          relations.add(`${input[rename + 2].text}.${name.split('.')[1]}`);
        }
      }
    }
  }
  return relations;
}

export function migrationSources(root: string): SqlSource[] {
  return (Object.keys(migrationDirectories) as (keyof typeof migrationDirectories)[]).flatMap(
    (owner) =>
      migrationRecords(root, owner).map(({ name }) => ({
        file: name,
        text: readFileSync(join(root, name), 'utf8'),
      })),
  );
}

/** Keep empty and subsequently dropped owner schemas in the audit domain. */
export function migrationSchemas(sources: SqlSource[]): Set<string> {
  const schemas = new Set<string>(['public']);
  for (const source of sources) {
    const input = tokens(source.text);
    for (let i = 0; i < input.length; i++) {
      if (word(input[i], 'create') && word(input[i + 1], 'schema')) {
        const at = afterModifiers(input, i + 2);
        if (identifier(input[at])) schemas.add(input[at].text);
      }
    }
  }
  return schemas;
}

function sqlReferences(
  sql: string,
  schemas: Set<string>,
  relationConstant = false,
): { relation: string; offset: number }[] {
  const input = tokens(sql);
  const result: { relation: string; offset: number }[] = [];
  const add = (at: number, allowColumns = false) => {
    const relation = qualified(input, at);
    if (relation && schemas.has(input[at].text) && (allowColumns || !word(input[at + 3], '(')))
      result.push({ relation, offset: input[at].offset });
  };
  // Relation constants also feed dynamic queries and regclass parameters.
  if (relationConstant && input.length === 3) add(0);
  let statementStart = 0;
  for (let i = 0; i < input.length; i++) {
    if (word(input[i], ';')) statementStart = i + 1;
    const statement = word(input[i], 'on') ? input.slice(statementStart, i) : [];
    if (
      word(input[i], 'on') &&
      (statement.some((token) => word(token, 'grant') || word(token, 'revoke')) ||
        (statement.some((token) => word(token, 'create')) &&
          statement.some((token) => word(token, 'index') || word(token, 'trigger'))))
    ) {
      add(afterModifiers(input, i + 1), true);
    }
    if (
      [
        'from',
        'join',
        'update',
        'into',
        'references',
        'table',
        'view',
        'sequence',
        'truncate',
        'copy',
        'analyze',
        'vacuum',
        'index',
      ].some((value) => word(input[i], value))
    ) {
      let at = afterModifiers(input, i + 1);
      if (word(input[at], 'table')) at = afterModifiers(input, at + 1);
      add(at, !word(input[i], 'from') && !word(input[i], 'join'));
      // FROM/TRUNCATE relation lists; aliasing is handled without scanning columns.
      at += 3;
      if (word(input[at], 'as')) at += 2;
      else if (
        identifier(input[at]) &&
        !['where', 'set', 'join', 'order', 'group', 'limit'].includes(input[at].text)
      )
        at++;
      while (word(input[at], ',') && qualified(input, at + 1)) {
        add(at + 1);
        at += 4;
      }
    }
    if (
      input[i].string &&
      schemas.has(input[i].text.split('.')[0]) &&
      ((word(input[i + 1], ':') && word(input[i + 2], ':') && word(input[i + 3], 'regclass')) ||
        (word(input[i - 1], '(') &&
          ['to_regclass', 'nextval', 'currval', 'setval'].some((value) =>
            word(input[i - 2], value),
          )))
    ) {
      const name = qualified(tokens(input[i].text), 0);
      if (name) result.push({ relation: name, offset: input[i].offset + 1 });
    }
  }
  return result;
}

function stringAlternatives(node: ts.Expression): { text: string; node: ts.Expression }[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [{ text: node.text, node }];
  if (ts.isConditionalExpression(node))
    return [...stringAlternatives(node.whenTrue), ...stringAlternatives(node.whenFalse)];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return stringAlternatives(node.expression);
  return [];
}

/** Parse source literals, not comments or arbitrary schema.column expressions.
 * Interpolation holes keep surrounding SQL visible; separately visited literals
 * catch qualified relation constants used to build dynamic queries. */
export function sourceRelations(source: SqlSource, schemas: Set<string>): RelationReference[] {
  // Quotes may be escaped in source, and SQL permits whitespace around the dot.
  if (![...schemas].some((schema) => source.text.includes(schema))) return [];
  const ast = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    source.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: RelationReference[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const named =
        (ts.isVariableDeclaration(parent) &&
          /(?:table|relation)(?:name)?$/i.test(parent.name.getText(ast))) ||
        (ts.isPropertyAssignment(parent) && /^table$/i.test(parent.name.getText(ast)));
      for (const ref of sqlReferences(node.text, schemas, named))
        result.push({
          file: source.file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast) + 1 + ref.offset).line + 1,
          relation: ref.relation,
        });
    } else if (ts.isTemplateExpression(node)) {
      // Raw positions retain source line numbers, including multiline interpolations.
      const start = node.getStart(ast) + 1;
      let sql = source.text.slice(start, node.end - 1);
      for (const span of node.templateSpans) {
        const holeStart = span.expression.getFullStart() - start - 2;
        const holeEnd = span.literal.getStart(ast) - start + 1;
        sql =
          sql.slice(0, holeStart) +
          sql.slice(holeStart, holeEnd).replace(/[^\n]/g, '?') +
          sql.slice(holeEnd);
      }
      for (const span of node.templateSpans) {
        const holeStart = span.expression.getFullStart() - start - 2;
        const holeEnd = span.literal.getStart(ast) - start + 1;
        const prefix = /("[a-z_][a-z_0-9]*"|[a-z_][a-z_0-9]*)\.$/i.exec(sql.slice(0, holeStart));
        const at = prefix ? holeStart - prefix[0].length : -1;
        for (const value of stringAlternatives(span.expression)) {
          for (const ref of sqlReferences(
            sql.slice(0, holeStart) + value.text + sql.slice(holeEnd),
            schemas,
          )) {
            if (
              ref.offset === at ||
              (ref.offset >= holeStart && ref.offset < holeStart + value.text.length)
            )
              result.push({
                file: source.file,
                line:
                  ast.getLineAndCharacterOfPosition(
                    ref.offset === at ? start + at : value.node.getStart(ast) + 1,
                  ).line + 1,
                relation: ref.relation,
              });
          }
        }
      }
      // Prevent a hole from joining identifiers on either side.
      for (const ref of sqlReferences(sql, schemas))
        result.push({
          file: source.file,
          line: ast.getLineAndCharacterOfPosition(start + ref.offset).line + 1,
          relation: ref.relation,
        });
      // Visit expressions only; template chunks have already been read as one SQL string.
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

export function missingRelations(
  sources: SqlSource[],
  relations: Set<string>,
  schemas: Set<string>,
): RelationReference[] {
  return sources
    .flatMap((source) => sourceRelations(source, schemas))
    .filter((ref) => !relations.has(ref.relation));
}

/** Test-only, exact-name declarations keep historical schemas and negative
 * probes explicit. Production sources cannot exempt a missing relation. */
export function relationExemptions(source: SqlSource): Map<string, string> {
  const result = new Map<string, string>();
  if (!source.text.includes('sql-relations-allow:')) return result;
  const ast = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    for (const range of ts.getLeadingCommentRanges(source.text, node.pos) ?? []) {
      const comment = source.text.slice(range.pos, range.end);
      if (!comment.includes('sql-relations-allow:')) continue;
      const match =
        /^\/\/ sql-relations-allow: ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*) -- (\S.*)$/i.exec(comment);
      if (!match || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(source.file)) {
        throw new Error(
          `${source.file}: sql-relations-allow requires a test file, exact relation and reason`,
        );
      }
      result.set(match[1], match[2]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

/** Bookkeeping DDL is created by migration runners before their SQL inventory. */
export function sourceSqlLiterals(source: SqlSource): SqlSource[] {
  const ast = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true);
  const result: SqlSource[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      result.push({ file: source.file, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

export function repositorySqlSources(root: string): SqlSource[] {
  return ['services', 'scripts', 'tests'].flatMap((directory) =>
    [
      ...new Bun.Glob('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}').scanSync({
        cwd: join(root, directory),
        onlyFiles: true,
      }),
    ]
      .filter(
        (file) => !file.split('/').some((part) => ['node_modules', '.temp', 'dist'].includes(part)),
      )
      .map((file) => ({
        file: `${directory}/${file}`,
        text: readFileSync(join(root, directory, file), 'utf8'),
      })),
  );
}
