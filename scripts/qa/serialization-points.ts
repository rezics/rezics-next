import { readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import ts from 'typescript-6';
import { compareMigrationPaths } from '../lib/migration-order.ts';
import type { SqlSource } from './sql-relations.ts';

export type SerializationClass =
  | 'post-commit sequencer'
  | 'builder fold'
  | 'operator/startup'
  | 'recovery fence'
  | 'rate gate'
  | 'external log head'
  | 'per-object management revision'
  | 'projection checkpoint (background)';

export interface SerializationAllowance {
  relation?: string;
  key?: string;
  class: SerializationClass;
  reason: string;
  // Exact files: approving a background writer must not approve a new route.
  writers: string[];
}

const access = 'services/main/migrations/access/';
const content = 'services/content/migrations/';
const main = 'services/main/src/';
export const serializationAllowlist: SerializationAllowance[] = [
  {
    key: 'platform-grant-continuity',
    class: 'per-object management revision',
    reason:
      'The platform grant authority is one governance unit; simultaneous removals must retain its permanent holder.',
    writers: [access + '1290_platform_grants.sql'],
  },
  {
    relation: 'pkg.go_sumdb_head',
    class: 'external log head',
    reason:
      'The Go checksum database is one external transparency log whose tree heads must be verified in order.',
    writers: [content + '014_go_sumdb_trust.sql', main + 'modules/package/go-sumdb-trust.ts'],
  },
  {
    key: 'access:group-inventory',
    class: 'per-object management revision',
    reason: 'Group inventory management revision, not admission authority.',
    writers: [access + '1210_authority_domains.sql', main + 'modules/access/groups.ts'],
  },
  {
    relation: 'content.owner_control',
    class: 'post-commit sequencer',
    reason:
      'Committed receipts are ordered by the background sealer; rebuild promotion pins its owner cut.',
    writers: [
      'services/content/src/core.ts',
      'services/content/src/projection-cursor.ts',
      content + '001_core.sql',
      content + '791_content_event_sequencer.sql',
    ],
  },
  {
    relation: 'reader.also_enjoyed_source_fence',
    class: 'builder fold',
    reason:
      'Shelf triggers append change signals; the builder alone folds their committed horizon.',
    writers: [
      content + '415_also_enjoyed_shelf_source.sql',
      content + '602_library_shelf_sort.sql',
      content + '800_also_enjoyed_shelf_change_log.sql',
      content + '830_also_enjoyed_privacy_changes.sql',
    ],
  },
  {
    relation: 'reading_position.generation',
    class: 'builder fold',
    reason: 'Reading writes append change signals; the snapshot folds their committed horizon.',
    writers: [
      content + '727_reading_position.sql',
      content + '810_reading_position_change_signal.sql',
      // The restore epoch is bumped only by scripts/ops/restore.ts through this function.
      content + '840_reading_position_fence.sql',
    ],
  },
  {
    relation: 'access.discovery_source_fence',
    class: 'builder fold',
    reason: 'Discovery writes append change signals; builders fold the revision separately.',
    writers: [
      access + '315_discovery_projection.sql',
      access + '1044_discovery_scheduling.sql',
      access + '1060_discovery_rating_repairs.sql',
      access + '1160_source_fence_change_log.sql',
      access + '1180_discovery_source_keys.sql',
    ],
  },
  {
    relation: 'access.also_enjoyed_source_fence',
    class: 'builder fold',
    reason: 'Recommendation inputs append change signals; builders fold their committed horizon.',
    writers: [
      access + '785_also_enjoyed_generation.sql',
      access + '1160_source_fence_change_log.sql',
      access + '1200_also_enjoyed_refresh.sql',
    ],
  },
  {
    relation: 'access.reader_review_rank_head',
    class: 'post-commit sequencer',
    reason: 'The review rank sealer orders committed changes independently of review writes.',
    writers: [access + '623_review_rankings.sql', access + '1170_review_rank_sequencer.sql'],
  },
  {
    relation: 'access.editorial_event_clock',
    class: 'post-commit sequencer',
    reason: 'The editorial sealer orders committed events independently of editorial writes.',
    writers: [access + '882_editorial_events.sql', access + '1171_editorial_event_sequencer.sql'],
  },
  {
    relation: 'access.site_moderation_position',
    class: 'builder fold',
    reason: 'Moderation changes append signals whose committed horizon is folded for readers.',
    writers: [access + '932_safety_queue.sql', access + '1172_ordered_read_change_signals.sql'],
  },
  {
    relation: 'access.realm_count_position',
    class: 'builder fold',
    reason:
      'Realm membership changes append signals whose committed horizon is folded for readers.',
    writers: [
      access + '395_realm_member_publication.sql',
      access + '1172_ordered_read_change_signals.sql',
    ],
  },
  {
    relation: 'access.realm_growth_position',
    class: 'builder fold',
    reason: 'Realm growth changes append signals whose committed horizon is folded for readers.',
    writers: [access + '860_realm_growth_day.sql', access + '1172_ordered_read_change_signals.sql'],
  },
  {
    relation: 'access.notification_producer_head',
    class: 'projection checkpoint (background)',
    reason: 'Historical producer head was removed by the insert-log migration.',
    writers: [
      access + '495_notification_producer_log.sql',
      access + '1130_notification_producer_insert_log.sql',
    ],
  },
  ...[
    ['access.feed_checkpoint', '405_home_feed.sql', 'modules/feed/store.ts'],
    ['access.read_ranking_checkpoint', '475_read_rankings.sql', 'modules/rankings/projection.ts'],
    [
      'access.serial_stats_checkpoint',
      '476_serial_statistics.sql',
      'modules/work/serial-projection.ts',
    ],
    [
      'access.realm_directory_position',
      '396_realm_directory.sql',
      'modules/realm-directory/index.ts',
    ],
    [
      'access.discovery_refresh_catalog',
      '380_discovery_refresh.sql',
      'modules/discovery/refresh-store.ts',
    ],
  ].map(([relation, migration, writer]): SerializationAllowance => ({
    relation,
    class: 'projection checkpoint (background)',
    reason: 'Only the background projection advances its durable cursor.',
    writers: [
      access + migration,
      main + writer,
      // The upgrade seeds scan frontiers from the already-completed coverage.
      ...(relation === 'access.read_ranking_checkpoint'
        ? [access + '1399_read_rankings.sql'] : []),
      ...(relation === 'access.realm_directory_position'
        ? [
            access + '1161_realm_directory_refresh.sql',
            access + '1241_realm_directory_incremental_copy.sql',
          ]
        : []),
    ],
  })),
  {
    relation: 'source.author_name_epoch',
    class: 'recovery fence',
    reason:
      'Only a restore advances the author-name fence epoch; author writes append change rows.',
    writers: [content + '850_source_author_name_fence.sql'],
  },
  {
    relation: 'access.relationship_recovery_cursor',
    class: 'recovery fence',
    reason: 'Recovery walkers alone advance the restored relationship inventory cursor.',
    writers: [
      access + '1014_relationship_follows.sql',
      main + 'modules/follows/recovery.ts',
      main + 'modules/library/follows.ts',
    ],
  },
  {
    relation: 'access.recovery_fence',
    class: 'recovery fence',
    reason:
      'Recovery and initial administrator bootstrap pin the owner; ordinary admission only shares this row.',
    writers: [
      access + '003_recovery_fence.sql',
      main + 'modules/access/admission.ts',
      main + 'modules/access/platform-administrator.ts',
    ],
  },
  {
    relation: 'relay.current_authority_coverage',
    class: 'recovery fence',
    reason: 'Background retained authority capture advances the pointer used to authorize restore.',
    writers: ['services/main/migrations/relay/014_current_authority_coverage.sql'],
  },
  {
    relation: 'access.storage_format',
    class: 'operator/startup',
    reason: 'Only the storage format upgrade operator changes the installed version.',
    writers: [access + '180_storage_format.sql', main + 'operations/format-upgrade.ts'],
  },
  {
    relation: 'access.operational_bounds_activation',
    class: 'operator/startup',
    reason: 'Only the operator activates the installed bounds profile.',
    writers: [access + '170_operational_bounds.sql', main + 'operations/bounds.ts'],
  },
  {
    relation: 'access.baseline_member_policy',
    class: 'operator/startup',
    reason: 'The installed baseline policy is immutable after migration.',
    writers: [access + '350_baseline_member.sql'],
  },
  {
    relation: 'access.platform_administrator',
    class: 'operator/startup',
    reason:
      'Historical designation is transferred to immutable grant episodes in 1290 and dropped in 1291.',
    writers: [access + '983_platform_administrator.sql', access + '1290_platform_grants.sql'],
  },
  {
    relation: 'public.rezics_account_operator_bootstrap',
    class: 'operator/startup',
    reason: 'Startup records a one-time operator bootstrap marker.',
    writers: ['services/account/migrations/026_operators.sql', 'services/account/src/operators.ts'],
  },
  {
    key: 'rezics-content-schema',
    class: 'operator/startup',
    reason: 'Startup serializes installation of Content migrations.',
    writers: ['services/content/src/migrate.ts'],
  },
  {
    key: 'rezics_signing_key',
    class: 'operator/startup',
    reason: 'One-time key creation per rotation, not per request.',
    writers: [
      'services/account/migrations/004_signing_key_generations.sql',
      'services/account/src/signing-keys.ts',
    ],
  },
  {
    key: 'account-operator-roles',
    class: 'operator/startup',
    reason: 'Operator administration and bootstrap preserve continuity of the last Account owner.',
    writers: [
      'services/account/migrations/026_operators.sql',
      'services/account/src/operators.ts',
      'services/account/src/admin.ts',
      'services/account/src/admin-actions.ts',
    ],
  },
  {
    key: 'library-shelves-602',
    class: 'operator/startup',
    reason: 'The resumable operator backfill has one cursor and one active runner.',
    writers: [main + 'modules/library/backfill.ts'],
  },
  {
    key: 'rezics-relay-authority-coverage',
    class: 'recovery fence',
    reason: 'Background authority capture serializes the retained restore pointer.',
    writers: ['services/main/migrations/relay/014_current_authority_coverage.sql'],
  },
  {
    key: 'rezics-relay-erasure-epoch',
    class: 'recovery fence',
    reason:
      'Restore release pins the deletion journal allocator while verifying retained evidence.',
    writers: [
      'services/main/migrations/relay/010_erasure_journal.sql',
      main + 'modules/erasure/reconcile.ts',
    ],
  },
];

export interface SerializationFinding {
  file: string;
  line: number;
  rule: 'singleton-table' | 'constant-advisory-key' | 'singleton-write' | 'gate-lock-upgrade';
  target: string;
  detail: string;
}
interface Token {
  text: string;
  offset: number;
  literal?: boolean;
  quoted?: boolean;
}

// Dollar bodies stay visible so migration functions are audited too.
function lex(sql: string): Token[] {
  const result: Token[] = [];
  for (const match of sql.matchAll(
    /--[^\n]*|\/\*[\s\S]*?\*\/|\$[a-z_0-9]*\$|'(?:''|[^'])*'|"(?:""|[^"])*"|\$\d+|\d+(?:\.\d+)?|[a-z_][a-z_0-9$]*|[^\s]/gi,
  )) {
    const raw = match[0];
    if (raw.startsWith('--') || raw.startsWith('/*') || /^\$[a-z_0-9]*\$$/i.test(raw)) continue;
    result.push({
      text: raw.startsWith("'")
        ? raw.slice(1, -1).replaceAll("''", "'")
        : raw.startsWith('"')
          ? raw.slice(1, -1).replaceAll('""', '"')
          : raw.toLowerCase(),
      offset: match.index,
      literal: raw.startsWith("'"),
      quoted: raw.startsWith('"'),
    });
  }
  return result;
}
const word = (token: Token | undefined, value: string) =>
  !!token && !token.literal && !token.quoted && token.text === value;
const identifier = (token: Token | undefined) =>
  !!token && !token.literal && (token.quoted || /^[a-z_][a-z_0-9$]*$/.test(token.text));
function relationAt(input: Token[], at: number): { name: string; end: number } | undefined {
  while (['if', 'not', 'exists', 'only'].some((value) => word(input[at], value))) at++;
  if (!identifier(input[at])) return;
  if (word(input[at + 1], '.') && identifier(input[at + 2]))
    return { name: `${input[at].text}.${input[at + 2].text}`, end: at + 3 };
  return { name: `public.${input[at].text}`, end: at + 1 };
}
function close(input: Token[], at: number): number {
  let depth = 0;
  for (let i = at; i < input.length; i++) {
    if (word(input[i], '(')) depth++;
    if (word(input[i], ')') && --depth === 0) return i;
  }
  return input.length;
}
function parts(input: Token[]): Token[][] {
  const result: Token[][] = [[]];
  let depth = 0;
  for (const token of input) {
    if (word(token, '(')) depth++;
    if (word(token, ')')) depth--;
    if (word(token, ',') && depth === 0) result.push([]);
    else result.at(-1)!.push(token);
  }
  return result;
}
const rendered = (input: Token[]) =>
  input.map((token) => (token.literal ? JSON.stringify(token.text) : token.text)).join(' ');
function fixedCheck(input: Token[], column: string, boolean: boolean): boolean {
  for (let i = 0; i < input.length; i++) {
    if (!word(input[i], 'check') || !word(input[i + 1], '(')) continue;
    let body = input.slice(i + 2, close(input, i + 1));
    while (word(body[0], '(') && close(body, 0) === body.length - 1) body = body.slice(1, -1);
    if (
      boolean &&
      ((body.length === 1 && body[0].text === column) ||
        (body.length === 2 && word(body[0], 'not') && body[1].text === column))
    )
      return true;
    if (
      body.length === 3 &&
      body[0].text === column &&
      word(body[1], '=') &&
      (body[2].literal || /^(true|false|\d+)$/.test(body[2].text))
    )
      return true;
    if (
      body.length === 3 &&
      body[0].text === column &&
      word(body[1], 'is') &&
      /^(true|false)$/.test(body[2]?.text ?? '')
    )
      return true;
  }
  return false;
}

export function singletonTables(
  migrations: SqlSource[],
): Map<string, { file: string; line: number }[]> {
  const result = new Map<string, { file: string; line: number }[]>();
  for (const source of migrations) {
    const input = lex(source.text);
    const add = (name: string, offset: number) =>
      result.set(name, [
        ...(result.get(name) ?? []),
        { file: source.file, line: source.text.slice(0, offset).split('\n').length },
      ]);
    for (let i = 0; i < input.length; i++) {
      if (word(input[i], 'drop') && word(input[i + 1], 'table')) {
        let table = relationAt(input, i + 2);
        while (table) {
          result.delete(table.name);
          table = word(input[table.end], ',') ? relationAt(input, table.end + 1) : undefined;
        }
      }
      if (word(input[i], 'create') && word(input[i + 1], 'table')) {
        const relation = relationAt(input, i + 2);
        if (!relation || !word(input[relation.end], '(')) continue;
        const body = input.slice(relation.end + 1, close(input, relation.end));
        const columns = parts(body);
        const fixed = new Set(
          columns
            .filter(
              (column) =>
                identifier(column[0]) &&
                fixedCheck(
                  body,
                  column[0].text,
                  word(column[1], 'boolean') || word(column[1], 'bool'),
                ),
            )
            .map((column) => column[0].text),
        );
        const singleton = columns.some((column) => {
          for (let j = 0; j < column.length; j++) {
            const key =
              word(column[j], 'primary') && word(column[j + 1], 'key')
                ? j + 2
                : word(column[j], 'unique')
                  ? j + 1
                  : -1;
            if (key < 0) continue;
            const names = word(column[key], '(')
              ? column
                  .slice(key + 1, close(column, key))
                  .filter(identifier)
                  .map((token) => token.text)
              : [column[0].text];
            if (names.length && names.every((name) => fixed.has(name))) return true;
          }
          return false;
        });
        if (singleton) add(relation.name, input[i].offset);
      }
      if (word(input[i], 'create') && word(input[i + 1], 'unique') && word(input[i + 2], 'index')) {
        let on = i + 3;
        while (on < input.length && !word(input[on], 'on') && !word(input[on], ';')) on++;
        const relation = relationAt(input, on + 1);
        if (!relation || !word(input[relation.end], '(')) continue;
        const end = close(input, relation.end);
        const body = input.slice(relation.end + 1, end);
        // A partial unique index caps a subset (e.g. one active signing key),
        // not the relation's cardinality or all of its writers.
        if (
          !word(input[end + 1], 'where') &&
          body.length &&
          body.every((token) => token.literal || /^(true|false|\d+|[(),])$/.test(token.text))
        )
          add(relation.name, input[i].offset);
      }
    }
  }
  return result;
}

interface Condition {
  expression: string;
  truth: boolean;
}
interface SqlFragment extends SqlSource {
  line: number;
  node?: ts.Node;
  ast?: ts.SourceFile;
  parameters?: ts.Expression[];
  conditions?: Condition[];
  bindings?: Map<string, string>;
}

function initializer(node: ts.Node, name: string): ts.Expression | undefined {
  let scope: ts.Node | undefined = node;
  while (scope) {
    const declarations: ts.VariableDeclaration[] = [];
    const visit = (child: ts.Node) => {
      if (ts.isVariableDeclaration(child) && child.name.getText() === name && child.initializer)
        declarations.push(child);
      if (child !== scope && ts.isFunctionLike(child)) return;
      ts.forEachChild(child, visit);
    };
    visit(scope);
    const declaration = declarations.find((candidate) => candidate.getStart() < node.getStart());
    if (declaration) return declaration.initializer;
    scope = scope.parent;
  }
  return undefined;
}
function expressionValue(node: ts.Expression, depth = 0): { text: string; constant: boolean } {
  if (depth > 8) return { text: node.getText(), constant: false };
  if (ts.isStringLiteralLike(node)) return { text: node.text, constant: true };
  if (
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  )
    return { text: node.getText(), constant: true };
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = expressionValue(node.operand, depth + 1);
    if (operand.constant && /^\d+(?:\.\d+)?$/.test(operand.text))
      return {
        text: `${node.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${operand.text}`,
        constant: true,
      };
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return expressionValue(node.expression, depth + 1);
  if (ts.isIdentifier(node)) {
    const value = initializer(node, node.text);
    if (value) return expressionValue(value, depth + 1);
  }
  if (ts.isTemplateExpression(node)) {
    const values = node.templateSpans.map((span) => expressionValue(span.expression, depth + 1));
    return {
      text:
        node.head.text +
        node.templateSpans
          .map(
            (span, i) =>
              (values[i].constant ? values[i].text : `@{${values[i].text}}`) + span.literal.text,
          )
          .join(''),
      constant: values.every((value) => value.constant),
    };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionValue(node.left, depth + 1),
      right = expressionValue(node.right, depth + 1);
    return { text: left.text + right.text, constant: left.constant && right.constant };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((element) =>
      expressionValue(element as ts.Expression, depth + 1),
    );
    return {
      text: JSON.stringify(values.map((value) => value.text)),
      constant: values.every((value) => value.constant),
    };
  }
  if (
    ts.isCallExpression(node) &&
    /^(JSON\.stringify|String|Number|BigInt)$/.test(node.expression.getText()) &&
    node.arguments.length === 1
  )
    return expressionValue(node.arguments[0], depth + 1);
  return { text: node.getText().replace(/\s+/g, ''), constant: false };
}
function symbolValue(node: ts.Expression): string {
  const value = expressionValue(node);
  return value.constant && !/^(true|false|-?\d+(?:\.\d+)?)$/.test(value.text)
    ? JSON.stringify(value.text)
    : value.text;
}
function substituteSymbols(
  value: string,
  bindings: Map<string, string>,
  parentheses = false,
): string {
  return value.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?<![.\w])[a-z_$][a-z_0-9$]*/gi,
    (name) => {
      if (!bindings.has(name)) return name;
      return parentheses ? `(${bindings.get(name)})` : bindings.get(name)!;
    },
  );
}
function sqlVariants(node: ts.Expression, depth = 0): { text: string; conditions: Condition[] }[] {
  if (depth > 8) return [];
  if (ts.isConditionalExpression(node))
    return [true, false].flatMap((truth) =>
      sqlVariants(truth ? node.whenTrue : node.whenFalse, depth + 1).map((value) => ({
        text: value.text,
        conditions: [
          ...value.conditions,
          { expression: expressionValue(node.condition).text, truth },
        ],
      })),
    );
  if (ts.isIdentifier(node)) {
    const value = initializer(node, node.text);
    return value ? sqlVariants(value, depth + 1) : [];
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return sqlVariants(node.expression, depth + 1);
  if (ts.isTemplateExpression(node)) {
    let variants = [{ text: node.head.text, conditions: [] as Condition[] }];
    for (const span of node.templateSpans) {
      const values = sqlVariants(span.expression, depth + 1);
      const alternatives = values.length ? values : [{ text: '__dynamic__', conditions: [] }];
      variants = variants.flatMap((prefix) =>
        alternatives.map((value) => ({
          text: prefix.text + value.text + span.literal.text,
          conditions: [...prefix.conditions, ...value.conditions],
        })),
      );
      if (variants.length > 32)
        return [
          {
            text: expressionValue(node).text.replace(/@\{[^}]*\}/g, '__dynamic__'),
            conditions: [],
          },
        ];
    }
    return variants;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlVariants(node.left, depth + 1),
      right = sqlVariants(node.right, depth + 1);
    return (left.length ? left : [{ text: '__dynamic__', conditions: [] }]).flatMap((a) =>
      (right.length ? right : [{ text: '__dynamic__', conditions: [] }]).map((b) => ({
        text: a.text + b.text,
        conditions: [...a.conditions, ...b.conditions],
      })),
    );
  }
  const value = expressionValue(node);
  return value.constant ? [{ text: value.text, conditions: [] }] : [];
}
function sourceFragments(source: SqlSource): SqlFragment[] {
  const ast = ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    /x$/.test(source.file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: SqlFragment[] = [{ file: source.file, text: '', line: 1, ast }];
  const add = (node: ts.Expression, parameters?: ts.Expression[]) => {
    for (const value of sqlVariants(node))
      result.push({
        file: source.file,
        ...value,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        node,
        ast,
        parameters,
      });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(query|execute)$/.test(node.expression.name.text) &&
      node.arguments[0]
    ) {
      const argument = node.arguments[1];
      const parameters =
        argument && ts.isIdentifier(argument) ? initializer(argument, argument.text) : argument;
      add(
        node.arguments[0],
        parameters && ts.isArrayLiteralExpression(parameters)
          ? ([...parameters.elements] as ts.Expression[])
          : undefined,
      );
    }
    // SQL constants also reach adapters indirectly. Ignore TS comments entirely.
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      if (!ts.isCallExpression(node.parent) || node.parent.arguments[0] !== node) add(node);
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

interface Effect {
  kind: 'share' | 'write' | 'exclusive' | 'boundary';
  relation: string;
  key: string;
  line: number;
  file?: string;
  conditions?: Condition[];
  lock?: 'FOR SHARE' | 'FOR KEY SHARE';
}
function sqlEffects(fragment: SqlFragment): Effect[] {
  const input = lex(fragment.text);
  const effects: Effect[] = [];
  let start = 0;
  for (let end = 0; end <= input.length; end++) {
    if (end < input.length && !word(input[end], ';')) continue;
    const statement = input.slice(start, end);
    start = end + 1;
    const line = (offset: number) =>
      fragment.line + fragment.text.slice(0, offset).split('\n').length - 1;
    const rowKey = (alias?: string) => {
      for (let i = 0; i < statement.length; i++) {
        if (
          statement[i].text !== 'id' ||
          (alias && word(statement[i - 1], '.') && statement[i - 2]?.text !== alias) ||
          !word(statement[i + 1], '=')
        )
          continue;
        const value = statement[i + 2];
        if (!value) break;
        if (fragment.bindings?.has(value.text)) return fragment.bindings.get(value.text)!;
        if (/^\$\d+$/.test(value.text)) {
          const parameter = fragment.parameters?.[Number(value.text.slice(1)) - 1];
          return parameter ? symbolValue(parameter) : value.text;
        }
        return word(statement[i + 3], '.') ||
          (identifier(value) && !/^(true|false)$/.test(value.text))
          ? '*'
          : value.literal
            ? JSON.stringify(value.text)
            : value.text;
      }
      return '*';
    };
    for (let i = 0; i < statement.length; i++) {
      if (
        word(statement[i], 'commit') ||
        word(statement[i], 'rollback') ||
        word(statement[i], 'begin')
      )
        effects.push({ kind: 'boundary', relation: '', key: '', line: line(statement[i].offset) });
      if (
        word(statement[i], 'update') &&
        !['for', 'key', 'no', 'do', 'or', 'before', 'after', 'of'].includes(
          statement[i - 1]?.text ?? '',
        )
      ) {
        const relation = relationAt(statement, i + 1);
        let set = relation?.end ?? -1;
        if (word(statement[set], 'as')) set++;
        if (identifier(statement[set]) && word(statement[set + 1], 'set')) set++;
        if (relation && word(statement[set], 'set'))
          effects.push({
            kind: 'write',
            relation: relation.name,
            key: rowKey(),
            line: line(statement[i].offset),
          });
      }
      if (word(statement[i], 'insert') && word(statement[i + 1], 'into')) {
        const relation = relationAt(statement, i + 2);
        if (
          relation &&
          statement.some(
            (token, at) =>
              word(token, 'conflict') && statement.slice(at).some((next) => word(next, 'update')),
          )
        )
          effects.push({
            kind: 'write',
            relation: relation.name,
            key: '*',
            line: line(statement[i].offset),
          });
      }
      if (!word(statement[i], 'for')) continue;
      const keyShare = word(statement[i + 1], 'key') && word(statement[i + 2], 'share');
      const kind =
        word(statement[i + 1], 'share') || keyShare
          ? 'share'
          : word(statement[i + 1], 'update') ||
              (word(statement[i + 1], 'no') &&
                word(statement[i + 2], 'key') &&
                word(statement[i + 3], 'update'))
            ? 'exclusive'
            : undefined;
      if (!kind) continue;
      let of = i + (word(statement[i + 1], 'no') ? 4 : keyShare ? 3 : 2);
      const aliases = new Set<string>();
      if (word(statement[of], 'of')) {
        of++;
        do {
          if (identifier(statement[of])) aliases.add(statement[of++].text);
          else break;
        } while (word(statement[of], ',') && ++of);
      }
      for (let j = 0; j < i; j++) {
        const comma =
          word(statement[j], ',') &&
          word(statement[j + 2], '.') &&
          statement.slice(0, j).some((token) => word(token, 'from')) &&
          !statement.slice(0, j).some((token) => word(token, 'where'));
        if (!word(statement[j], 'from') && !word(statement[j], 'join') && !comma) continue;
        const relation = relationAt(statement, j + 1);
        if (!relation || word(statement[relation.end], '(')) continue;
        let aliasAt = relation.end;
        if (word(statement[aliasAt], 'as')) aliasAt++;
        const alias =
          identifier(statement[aliasAt]) &&
          !['where', 'join', 'cross', 'left', 'right', 'inner', 'on', 'order', 'for'].includes(
            statement[aliasAt].text,
          )
            ? statement[aliasAt].text
            : relation.name.split('.')[1];
        if (!aliases.size || aliases.has(alias))
          effects.push({
            kind,
            lock: kind === 'share' ? (keyShare ? 'FOR KEY SHARE' : 'FOR SHARE') : undefined,
            relation: relation.name,
            key: rowKey(alias),
            line: line(statement[i].offset),
          });
      }
    }
  }
  return effects;
}

function advisoryKeys(fragment: SqlFragment): { key: string; line: number }[] {
  const input = lex(fragment.text),
    result: { key: string; line: number }[] = [];
  for (let i = 0; i < input.length; i++) {
    if (!/^pg_(?:try_)?advisory_(?:xact_)?lock$/.test(input[i].text) || !word(input[i + 1], '('))
      continue;
    const body = input.slice(i + 2, close(input, i + 1));
    const replaced = body.map((token) => {
      if (!/^\$\d+$/.test(token.text)) return token;
      const parameter = fragment.parameters?.[Number(token.text.slice(1)) - 1];
      const value = parameter && expressionValue(parameter);
      return value?.constant ? { ...token, literal: true, text: value.text } : token;
    });
    if (
      !replaced.length ||
      replaced.some(
        (token, at) =>
          !token.literal &&
          !/^(\d+(?:\.\d+)?|[(),:+*/|.-]|true|false|bigint|integer|int|text)$/.test(token.text) &&
          !(word(replaced[at + 1], '(') && /^(hashtext|hashtextextended|abs)$/.test(token.text)),
      )
    )
      continue;
    const literals = replaced.filter((token) => token.literal);
    result.push({
      key: literals.length === 1 ? literals[0].text : rendered(replaced),
      line: fragment.line + fragment.text.slice(0, input[i].offset).split('\n').length - 1,
    });
  }
  return result;
}

interface FunctionTrace {
  id: string;
  file: string;
  name?: string;
  className?: string;
  parameters: string[];
  defaults: Map<string, string>;
  events: (
    | { effect: Effect; offset: number }
    | { call: string; args: string[]; offset: number; conditions: Condition[] }
  )[];
}

function pathConditions(node: ts.Node): Condition[] {
  const result: Condition[] = [];
  let child = node;
  for (
    let parent = node.parent;
    parent && !ts.isFunctionLike(parent);
    child = parent, parent = parent.parent
  ) {
    if (
      ts.isIfStatement(parent) &&
      (parent.thenStatement === child || parent.elseStatement === child)
    )
      result.push({
        expression: expressionValue(parent.expression).text,
        truth: parent.thenStatement === child,
      });
    if (
      ts.isConditionalExpression(parent) &&
      (parent.whenTrue === child || parent.whenFalse === child)
    )
      result.push({
        expression: expressionValue(parent.condition).text,
        truth: parent.whenTrue === child,
      });
  }
  return result;
}

// Solve the small boolean formulas used to choose SHARE versus UPDATE. Atomic
// comparisons stay symbolic; disjoint branches must never invent an upgrade.
function compatible(conditions: Condition[]): boolean {
  const atoms = new Set<string>();
  const formula = (expression: string): ((values: Map<string, boolean>) => boolean) => {
    const ast = ts.createSourceFile(
      'condition.ts',
      `(${expression})`,
      ts.ScriptTarget.Latest,
      true,
    );
    const statement = ast.statements[0];
    const visit = (node: ts.Expression): ((values: Map<string, boolean>) => boolean) => {
      if (ts.isParenthesizedExpression(node)) return visit(node.expression);
      if (node.kind === ts.SyntaxKind.TrueKeyword) return () => true;
      if (node.kind === ts.SyntaxKind.FalseKeyword) return () => false;
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        const operand = visit(node.operand);
        return (values) => !operand(values);
      }
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      ) {
        const left = visit(node.left),
          right = visit(node.right);
        return node.operatorToken.kind === ts.SyntaxKind.BarBarToken
          ? (values) => left(values) || right(values)
          : (values) => left(values) && right(values);
      }
      const atom = node.getText(ast).replace(/\s+/g, '');
      atoms.add(atom);
      return (values) => values.get(atom)!;
    };
    if (statement && ts.isExpressionStatement(statement)) return visit(statement.expression);
    atoms.add(expression);
    return (values) => values.get(expression)!;
  };
  const formulas = conditions.map((condition) => ({
    test: formula(condition.expression),
    truth: condition.truth,
  }));
  if (atoms.size > 10) return true; // Unknown complexity fails conservatively.
  const names = [...atoms];
  for (let bits = 0; bits < 2 ** names.length; bits++) {
    const values = new Map(names.map((name, i) => [name, !!(bits & (1 << i))]));
    if (formulas.every((item) => item.test(values) === item.truth)) return true;
  }
  return false;
}

function gateEffectFindings(
  effects: Effect[],
  file: string,
  name?: string,
): SerializationFinding[] {
  const findings: SerializationFinding[] = [];
  const shares: Effect[] = [];
  const exclusive: Effect[] = [];
  const order = new Map<Effect, number>();
  let step = 0;
  for (const effect of effects) {
    order.set(effect, step++);
    if (!compatible(effect.conditions ?? [])) continue;
    if (effect.kind === 'boundary') {
      shares.length = 0;
      exclusive.length = 0;
    }
    if (effect.kind === 'exclusive') exclusive.push(effect);
    if (effect.kind === 'share' && /(?:^|[._])gate$/.test(effect.relation)) shares.push(effect);
    if (effect.kind !== 'write') continue;
    const share = shares.find(
      (prior) =>
        prior.relation === effect.relation &&
        (prior.key === effect.key || prior.key === '*' || effect.key === '*') &&
        compatible([...(prior.conditions ?? []), ...(effect.conditions ?? [])]),
    );
    if (
      share &&
      effect.key !== '*' &&
      exclusive.some(
        (prior) =>
          prior.relation === effect.relation &&
          prior.key === effect.key &&
          order.get(prior)! < order.get(share)! &&
          (prior.conditions ?? []).every(
            (condition) =>
              !compatible([
                ...(share.conditions ?? []),
                ...(effect.conditions ?? []),
                { ...condition, truth: !condition.truth },
              ]),
          ),
      )
    )
      continue;
    if (share)
      findings.push({
        file: effect.file ?? file,
        line: effect.line,
        rule: 'gate-lock-upgrade',
        target: effect.relation,
        detail: `${share.lock ?? 'FOR SHARE'} at ${share.file ?? file}:${share.line} precedes UPDATE of the same gate (${effect.key})${name ? ` via ${file}#${name}` : ''}; no exemption is permitted`,
      });
  }
  return findings;
}

/** Use migration-head function and trigger definitions, not superseded trigger
 * bodies. A write can update a gate without spelling UPDATE in TypeScript. */
function databaseEffects(migrations: SqlSource[]): (fragment: SqlFragment) => Effect[] {
  const functions = new Map<string, { fragment: SqlFragment; parameters: string[] }>();
  const triggers = new Map<
    string,
    { relation: string; function: string; operations: Set<string>; phase: number; name: string }
  >();
  for (const source of migrations) {
    const input = lex(source.text);
    for (let i = 0; i < input.length; i++) {
      if (word(input[i], 'drop') && word(input[i + 1], 'function')) {
        const name = relationAt(input, i + 2);
        if (name) functions.delete(name.name);
      }
      if (word(input[i], 'drop') && word(input[i + 1], 'trigger')) {
        let at = i + 2;
        while (['if', 'exists'].some((value) => word(input[at], value))) at++;
        const name = input[at]?.text;
        while (at < input.length && !word(input[at], 'on') && !word(input[at], ';')) at++;
        const relation = relationAt(input, at + 1);
        if (relation) triggers.delete(`${relation.name}#${name}`);
      }
      if (!word(input[i], 'create')) continue;
      let kind = i + 1;
      if (word(input[kind], 'or') && word(input[kind + 1], 'replace')) kind += 2;
      if (word(input[kind], 'function')) {
        const name = relationAt(input, kind + 1);
        if (!name || !word(input[name.end], '(')) continue;
        const end = close(input, name.end);
        let at = end + 1;
        while (at < input.length && !word(input[at], 'as') && !word(input[at], ';')) at++;
        if (!word(input[at], 'as')) continue;
        const match = /^as\s+(\$[a-z_0-9]*\$)([\s\S]*?)\1/i.exec(
          source.text.slice(input[at].offset),
        );
        if (!match) continue;
        const offset = input[at].offset + match[0].indexOf(match[2]);
        functions.set(name.name, {
          fragment: {
            file: source.file,
            text: match[2],
            line: source.text.slice(0, offset).split('\n').length,
          },
          parameters: parts(input.slice(name.end + 1, end)).map((part) => part[0]?.text ?? ''),
        });
        const bodyEnd = input[at].offset + match[0].length;
        while (i + 1 < input.length && input[i + 1].offset < bodyEnd) i++;
        continue;
      }
      if (word(input[kind], 'constraint')) kind++;
      if (!word(input[kind], 'trigger')) continue;
      const trigger = input[kind + 1]?.text;
      let on = kind + 2;
      while (on < input.length && !word(input[on], 'on') && !word(input[on], ';')) on++;
      const relation = relationAt(input, on + 1);
      if (!relation) continue;
      let execute = relation.end;
      while (
        execute < input.length &&
        !word(input[execute], 'execute') &&
        !word(input[execute], ';')
      )
        execute++;
      const func = relationAt(input, execute + 2);
      if (func && word(input[execute], 'execute'))
        triggers.set(`${relation.name}#${trigger}`, {
          relation: relation.name,
          function: func.name,
          name: trigger,
          phase: input.slice(kind + 2, on).some((token) => word(token, 'before'))
            ? input.slice(relation.end, execute).some((token) => word(token, 'row'))
              ? 1
              : 0
            : input.slice(relation.end, execute).some((token) => word(token, 'row'))
              ? 2
              : 3,
          operations: new Set(
            input
              .slice(kind + 2, on)
              .filter((token) => ['insert', 'update', 'delete'].some((value) => word(token, value)))
              .map((token) => token.text),
          ),
        });
    }
  }
  const expand = (fragment: SqlFragment, chain: Set<string>): Effect[] => {
    const input = lex(fragment.text);
    if (input.some((token) => word(token, ';'))) {
      let start = 0;
      const result: Effect[] = [];
      for (const end of [
        ...input.filter((token) => word(token, ';')).map((token) => token.offset),
        fragment.text.length,
      ]) {
        const text = fragment.text.slice(start, end);
        if (text.trim())
          result.push(
            ...expand(
              {
                ...fragment,
                text,
                line: fragment.line + fragment.text.slice(0, start).split('\n').length - 1,
              },
              chain,
            ),
          );
        start = end + 1;
      }
      return result;
    }
    const result = sqlEffects(fragment);
    const before: Effect[] = [];
    const invoke = (name: string, arguments_: Token[][] = []): Effect[] => {
      if (chain.has(name)) return [];
      const definition = functions.get(name);
      if (!definition) return [];
      const bindings = new Map<string, string>();
      for (let i = 0; i < arguments_.length; i++) {
        const argument = arguments_[i];
        if (argument.length !== 1) continue;
        const token = argument[0];
        const parameter = /^\$\d+$/.test(token.text)
          ? fragment.parameters?.[Number(token.text.slice(1)) - 1]
          : undefined;
        const value = parameter
          ? symbolValue(parameter)
          : (fragment.bindings?.get(token.text) ??
            (token.literal ? JSON.stringify(token.text) : token.text));
        bindings.set(definition.parameters[i], value);
        bindings.set(`$${i + 1}`, value);
      }
      return expand({ ...definition.fragment, bindings }, new Set(chain).add(name))
        .filter((effect) => effect.kind !== 'boundary')
        .map((effect) => ({ ...effect, file: effect.file ?? definition.fragment.file }));
    };
    for (let i = 0; i < input.length; i++) {
      const name = relationAt(input, i);
      if (name && functions.has(name.name) && word(input[name.end], '(')) {
        result.push(...invoke(name.name, parts(input.slice(name.end + 1, close(input, name.end)))));
        i = close(input, name.end);
      }
      const operation = ['insert', 'update', 'delete'].find((value) => word(input[i], value));
      if (!operation || word(input[i - 1], 'for') || word(input[i - 1], 'do')) continue;
      const relation = relationAt(input, i + (operation === 'update' ? 1 : 2));
      if (!relation) continue;
      // PostgreSQL runs BEFORE statement/row triggers before AFTER row/statement
      // triggers, then sorts equal-kind triggers by name. Migration order is not
      // execution order: an AFTER bump can depend on a later-defined BEFORE lock.
      for (const trigger of [...triggers.values()]
        .filter(
          (trigger) => trigger.relation === relation.name && trigger.operations.has(operation),
        )
        .sort((left, right) => left.phase - right.phase || left.name.localeCompare(right.name))) {
        const target = trigger.phase < 2 ? before : result;
        target.push(...invoke(trigger.function));
      }
    }
    return [...before, ...result];
  };
  return (fragment) => expand(fragment, new Set());
}

/** Follow named/imported helpers and inline transaction callbacks. This is a
 * conservative effect analysis, not a proof of arbitrary JavaScript: computed
 * dispatch and runtime SQL remain outside the literal SQL guard's domain. */
function gateUpgrades(
  sources: SqlSource[],
  byFile: Map<string, SqlFragment[]>,
  effects: (fragment: SqlFragment) => Effect[],
): SerializationFinding[] {
  const traces = new Map<string, FunctionTrace>();
  const named = new Map<string, string>();
  const imports = new Map<string, Map<string, string>>();
  const functionNodes = new Map<ts.Node, string>();
  const owner = (node: ts.Node | undefined): ts.Node | undefined => {
    while (node && !ts.isFunctionLike(node) && !ts.isSourceFile(node)) node = node.parent;
    return node;
  };
  for (const source of sources) {
    const fragments = byFile.get(source.file) ?? [];
    const ast = fragments[0]?.ast;
    if (!ast) continue;
    const moduleId = `${source.file}:module`;
    functionNodes.set(ast, moduleId);
    traces.set(moduleId, {
      id: moduleId,
      file: source.file,
      name: '<module>',
      parameters: [],
      defaults: new Map(),
      events: [],
    });
    const fileImports = new Map<string, string>();
    imports.set(source.file, fileImports);
    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith('.')
      ) {
        const module = posix.normalize(
          posix.join(posix.dirname(source.file), node.moduleSpecifier.text),
        );
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements)
            fileImports.set(
              binding.name.text,
              `${module}#${binding.propertyName?.text ?? binding.name.text}`,
            );
      }
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const parent = node.parent;
        const name =
          'name' in node && node.name
            ? node.name.getText(ast)
            : ts.isVariableDeclaration(parent)
              ? parent.name.getText(ast)
              : undefined;
        const className =
          ts.isClassDeclaration(parent) || ts.isClassExpression(parent)
            ? parent.name?.text
            : undefined;
        const id = `${source.file}:${node.getStart(ast)}`;
        functionNodes.set(node, id);
        traces.set(id, {
          id,
          file: source.file,
          name,
          className,
          parameters: node.parameters.map((parameter) => parameter.name.getText(ast)),
          defaults: new Map(
            node.parameters.flatMap((parameter) =>
              parameter.initializer
                ? [
                    [parameter.name.getText(ast), expressionValue(parameter.initializer).text] as [
                      string,
                      string,
                    ],
                  ]
                : [],
            ),
          ),
          events: [],
        });
        if (name) named.set(`${source.file}#${className ? className + '.' : ''}${name}`, id);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    // Module-level SQL constants are checked for serialization above, but only
    // their invocation belongs to a transaction's effect trace.
    for (const fragment of fragments) {
      if (
        !fragment.node ||
        !ts.isCallExpression(fragment.node.parent) ||
        fragment.node.parent.arguments[0] !== fragment.node
      )
        continue;
      const id = functionNodes.get(owner(fragment.node)!);
      if (!id) continue;
      for (const effect of effects(fragment))
        traces.get(id)!.events.push({
          effect: {
            ...effect,
            file: effect.file ?? source.file,
            conditions: [...(fragment.conditions ?? []), ...pathConditions(fragment.node)],
          },
          offset: fragment.node.getStart(ast),
        });
    }
    const calls = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const id = functionNodes.get(owner(node.parent)!);
        const trace = id && traces.get(id);
        if (trace) {
          const expression = node.expression;
          let container: ts.Node | undefined = node.parent;
          while (container && !ts.isClassDeclaration(container) && !ts.isClassExpression(container))
            container = container.parent;
          const className =
            container && (ts.isClassDeclaration(container) || ts.isClassExpression(container))
              ? container.name?.text
              : undefined;
          const call = ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression) &&
                expression.expression.kind === ts.SyntaxKind.ThisKeyword
              ? `${className ?? ''}.${expression.name.text}`
              : undefined;
          // A transaction callback executes where the helper calls its run/work
          // parameter, after BEGIN and the initial exclusive fences.
          if (call)
            trace.events.push({
              call,
              args: node.arguments.map(
                (argument) => functionNodes.get(argument) ?? symbolValue(argument),
              ),
              offset: node.end,
              conditions: pathConditions(node),
            });
        }
      }
      ts.forEachChild(node, calls);
    };
    calls(ast);
  }
  const embeddedCallbacks = new Set<string>();
  for (const trace of traces.values())
    for (const event of trace.events) {
      if ('effect' in event) continue;
      const imported = imports.get(trace.file)?.get(event.call);
      if (named.has(`${trace.file}#${event.call}`) || (imported && named.has(imported))) {
        for (const arg of event.args) if (traces.has(arg)) embeddedCallbacks.add(arg);
      }
    }
  const importedSymbols = new Map<string, Map<string, string>>();
  const constant = (file: string, name: string, seen = new Set<string>()): string | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return;
    const next = new Set(seen).add(key);
    const imported = imports.get(file)?.get(name);
    if (imported) {
      const separator = imported.lastIndexOf('#');
      return constant(imported.slice(0, separator), imported.slice(separator + 1), next);
    }
    const ast = byFile.get(file)?.[0]?.ast;
    if (!ast) return;
    let value: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
        const resolved = expressionValue(node.initializer);
        if (resolved.constant) value = symbolValue(node.initializer);
        else if (ts.isIdentifier(node.initializer))
          value = constant(file, node.initializer.text, next);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return value;
  };
  for (const [file, names] of imports) {
    const values = new Map<string, string>();
    for (const name of names.keys()) {
      const value = constant(file, name);
      if (value !== undefined) values.set(name, value);
    }
    importedSymbols.set(file, values);
  }
  const expand = (
    trace: FunctionTrace,
    chain: Set<string>,
    bindings = new Map<string, string>(),
    path: Condition[] = [],
  ): Effect[] => {
    if (chain.has(trace.id)) return [];
    const nextChain = new Set(chain).add(trace.id);
    const symbols = new Map([...(importedSymbols.get(trace.file) ?? []), ...bindings]);
    const substitute = (value: string) =>
      traces.has(value) ? value : substituteSymbols(value, symbols);
    const conditions = (input: Condition[]) => [
      ...path,
      ...input.map((condition) => ({
        ...condition,
        expression: substituteSymbols(condition.expression, symbols, true),
      })),
    ];
    const result: Effect[] = [];
    for (const event of trace.events.sort((a, b) => a.offset - b.offset)) {
      if ('effect' in event) {
        result.push({
          ...event.effect,
          key: substitute(event.effect.key),
          conditions: conditions(event.effect.conditions ?? []),
        });
        continue;
      }
      const call = bindings.get(event.call) ?? event.call;
      const local = named.get(`${trace.file}#${call}`);
      const imported = imports.get(trace.file)?.get(event.call);
      const target =
        traces.get(call) ?? traces.get(local ?? (imported ? named.get(imported) : undefined) ?? '');
      if (!target) continue;
      const args = event.args.map(substitute);
      // Inline callbacks retain the enclosing transaction's captured keys.
      const bound = new Map([...bindings, ...target.defaults]);
      for (let i = 0; i < target.parameters.length; i++)
        if (args[i]) bound.set(target.parameters[i], args[i]);
      result.push(...expand(target, nextChain, bound, conditions(event.conditions)));
    }
    return result;
  };
  const findings: SerializationFinding[] = [];
  for (const trace of traces.values()) {
    if (embeddedCallbacks.has(trace.id)) continue;
    findings.push(
      ...gateEffectFindings(expand(trace, new Set()), trace.file, trace.name ?? 'callback'),
    );
  }
  return findings;
}

/** SQL lexer + TS AST, with exact writer exemptions rather than text comments. */
export function serializationFindings(
  migrations: SqlSource[],
  sources: SqlSource[],
  allowlist: SerializationAllowance[] = serializationAllowlist,
): SerializationFinding[] {
  for (const entry of allowlist) {
    if (
      !!entry.relation === !!entry.key ||
      !entry.reason.trim() ||
      /[\r\n]/.test(entry.reason) ||
      !entry.writers.length
    )
      throw new Error(
        'Serialization allowance requires one relation or key, writers and a one-line reason',
      );
  }
  const singletons = singletonTables(migrations),
    findings: SerializationFinding[] = [];
  const byFile = new Map<string, SqlFragment[]>();
  const allowed = (target: string, file: string, key = false) =>
    allowlist.some(
      (entry) => (key ? entry.key : entry.relation) === target && entry.writers.includes(file),
    );
  for (const [target, definitions] of singletons)
    for (const definition of definitions)
      if (!allowed(target, definition.file))
        findings.push({
          ...definition,
          rule: 'singleton-table',
          target,
          detail: 'One-row design needs a classified reason and explicit writers',
        });
  for (const source of [...migrations, ...sources]) {
    const fragments = source.file.endsWith('.sql')
      ? [{ ...source, line: 1 }]
      : sourceFragments(source);
    if (!source.file.endsWith('.sql')) byFile.set(source.file, fragments);
    for (const fragment of fragments) {
      for (const lock of advisoryKeys(fragment))
        if (!allowed(lock.key, source.file, true))
          findings.push({
            file: source.file,
            line: lock.line,
            rule: 'constant-advisory-key',
            target: lock.key,
            detail: 'Advisory key has no per-object value',
          });
      for (const effect of sqlEffects(fragment))
        if (
          (effect.kind === 'write' || effect.kind === 'exclusive') &&
          singletons.has(effect.relation) &&
          !allowed(effect.relation, source.file)
        )
          findings.push({
            file: source.file,
            line: effect.line,
            rule: 'singleton-write',
            target: effect.relation,
            detail:
              'Singleton UPDATE/upsert or exclusive row lock needs an explicit writer allowance',
          });
    }
    // Each migration function has its own transaction fragment. Never combine
    // two different function definitions in the same historical migration.
    if (source.file.endsWith('.sql'))
      for (const body of source.text.matchAll(/(?:AS|DO)\s+(\$[a-z_0-9]*\$)([\s\S]*?)\1/gi)) {
        const effects = sqlEffects({
          file: source.file,
          text: body[2],
          line: source.text.slice(0, body.index! + body[0].indexOf(body[2])).split('\n').length,
        });
        findings.push(...gateEffectFindings(effects, source.file));
      }
  }
  findings.push(...gateUpgrades(sources, byFile, databaseEffects(migrations)));
  return [
    ...new Map(
      findings.map((finding) => [
        `${finding.file}:${finding.line}:${finding.rule}:${finding.target}`,
        finding,
      ]),
    ).values(),
  ];
}

export function repositorySerializationSources(root: string): SqlSource[] {
  return [
    ...new Bun.Glob('*/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}').scanSync({
      cwd: join(root, 'services'),
      onlyFiles: true,
    }),
  ]
    .filter(
      (file) => !file.split('/').some((part) => ['node_modules', '.temp', 'dist'].includes(part)),
    )
    .sort()
    .map((file) => ({
      file: `services/${file}`,
      text: readFileSync(join(root, 'services', file), 'utf8'),
    }));
}
export function repositorySerializationMigrations(root: string): SqlSource[] {
  // New services are audited before somebody remembers to register their owner.
  return [
    ...new Bun.Glob('*/migrations/**/*.sql').scanSync({
      cwd: join(root, 'services'),
      onlyFiles: true,
    }),
  ]
    .sort(compareMigrationPaths)
    .map((file) => ({
      file: `services/${file}`,
      text: readFileSync(join(root, 'services', file), 'utf8'),
    }));
}
if (import.meta.main) {
  const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
  const findings = serializationFindings(
    repositorySerializationMigrations(root),
    repositorySerializationSources(root),
  );
  for (const finding of findings)
    console.error(
      `${finding.file}:${finding.line}: ${finding.rule}: ${finding.target}: ${finding.detail}`,
    );
  if (findings.length) process.exitCode = 1;
}
