import { repositoryFiles } from '../lib/repository-files.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { integrationGateFiles } from './integration-gate-files.ts';

// Integration files that need their own bootstrapped QA project (they replace
// dataset heads, replay outboxes from zero or need a fresh graph). Parallel Goal
// branches append entries; git's union merge driver keeps both sides (see
// .gitattributes), so add a comment line and a path line, never reorder.
export const isolatedIntegrationFileList = [
  // Query cost evidence owns its catalogue and must not inherit another file's population.
  'tests/qa/integration/g-1032-query-cost.test.ts',
  // Studio's native head and disclosure plan probes require an independent owner history.
  'tests/qa/integration/studio-heads.test.ts',
  // Restarts storage owners and retains its own delivery history across process reconstruction.
  'tests/qa/integration/restart-resilience.test.ts',
  // Closure owns its Realm and platform governance fixture for all six personas.
  'tests/qa/integration/classification-context-closure.test.ts',
  // Edit binds exact graph sequences and fresh Access authority; outbox replays from zero and changes lineage.
  'services/main/tests/edit.integration.test.ts',
  'services/main/tests/outbox.integration.test.ts',
  // Question presentations qualify first-administrator authority and independent revision heads on an empty graph.
  'tests/qa/integration/rating-question-presentation.test.ts',
  // G-1044: these complete discovery populations and relay histories belong to each file.
  'tests/qa/integration/g-1016-discovery-refresh.test.ts',
  'tests/qa/integration/g-1029-discovery-ready.test.ts',
  'tests/qa/integration/g-1033-discovery-refresh.test.ts',
  // Discover refresh readiness, retained cursors and rollback likewise own their population and relay history.
  'tests/qa/integration/g-1063-refresh.test.ts',
  // G-1038 retains a command-created catalogue before independent restores.
  'tests/qa/integration/g-1038-catalogue-scale.test.ts',
  // Profile corpus checkpoints retain stopped owner stores for independent restores.
  'tests/qa/integration/profile-corpus-restore.test.ts',
  // Zone navigation checkpoints retain stopped owner stores for independent restores.
  'tests/qa/integration/zone-navigation-growth.test.ts',
  // Seed checkpoints retain one API-built population and restore independent owner stores.
  'tests/qa/integration/work-profile-seed-checkpoints.test.ts',
  // Ranked search compares independently restored public-command populations.
  'tests/qa/integration/search-ranked-growth.test.ts',
  // restores the launch books corpus
  'tests/qa/integration/launch-real-books.test.ts',
  // restores the launch recipes corpus
  'tests/qa/integration/launch-real-recipes.test.ts',
  // M6 replays reference suites that require fresh rating and catalogue inventories.
  'tests/qa/integration/g-856-wiki.test.ts',
  'tests/qa/integration/g-856-editorial.test.ts',
  'tests/qa/integration/g-856-position.test.ts',
  'tests/qa/integration/g-856-readers.test.ts',
  'tests/qa/integration/g-856-sessions.test.ts',
  'tests/qa/integration/g-856-library.test.ts',
  'tests/qa/integration/g-856-discovery.test.ts',
  'tests/qa/integration/g-856-series.test.ts',
  'tests/qa/integration/g-856-zones.test.ts',
  'tests/qa/integration/g-856-catalogue.test.ts',
  // Portable bundle imports assert the complete fresh Access rating inventory.
  'tests/qa/integration/g-854-library-bundle.test.ts',
  // G-724 consumes first-administrator configuration and needs empty owner/graph state.
  'tests/qa/integration/g-724-bootstrap.test.ts',
  // Global classification bootstrap exercises an empty graph and resets its own Context (G-380).
  'tests/qa/integration/classification-bootstrap.test.ts',
  // Read stability writes concurrently while the relay catches up (G-323).
  'tests/qa/integration/read-stability.test.ts',
  // Home feed replays the relay from zero and exercises private/disclosure fences.
  'tests/qa/integration/feed-home.test.ts',
  // Work read probes cut over classification and replace the dataset epoch.
  'services/main/tests/work-read.integration.test.ts',
  // Realm read probes change public disclosure, erasure and the restore hold.
  'services/main/tests/realm-read.integration.test.ts',
  // Management read probes hide a Realm and toggle its restore hold.
  'services/main/tests/management-read.integration.test.ts',
  'tests/qa/integration/validation-command.test.ts',
  'tests/qa/integration/validation-cross-profile.test.ts',
  // MODEL22 deliberately replaces the dataset's model generation head to
  // prove an in-flight semantic command is fenced. Later writers require the
  // bootstrap generation, so this file owns a fresh graph.
  'tests/qa/integration/semantic-generation.test.ts',
  'tests/qa/integration/search-statement-query.test.ts',
  'tests/qa/integration/event-time.test.ts',
  'tests/qa/integration/access-org-realm-move-api.test.ts',
  'tests/qa/integration/theme-activation-api.test.ts',
  'tests/qa/integration/owner-operations.test.ts',
  'tests/qa/integration/owner-relay-gap.test.ts',
  'tests/qa/integration/owner-outbox-recovery.test.ts',
  'tests/qa/integration/sys-receipt-relay-gap.test.ts',
  'tests/qa/integration/rating-release-target.test.ts',
  'tests/qa/integration/content-publication-native.test.ts',
  'tests/qa/integration/context-statement-cases.test.ts',
  'tests/qa/integration/erasure-api.test.ts',
  'tests/qa/integration/erasure-published-search.test.ts',
  'tests/qa/integration/hub-api.test.ts',
  'tests/qa/integration/judgment-api.test.ts',
  'tests/qa/integration/protection-content-api.test.ts',
  'tests/qa/integration/protection-work-api.test.ts',
  'tests/qa/integration/public-search-scale.test.ts',
  // Broad typeahead prefixes characterize exact population growth on a fresh native graph.
  'tests/qa/integration/typeahead-growth.test.ts',
  'tests/qa/integration/recommendation-context.test.ts',
  'tests/qa/integration/realm-reply-api.test.ts',
  'tests/qa/integration/source-graph-projection.test.ts',
  'tests/qa/integration/source-authenticated-api.test.ts',
  'tests/qa/integration/source-field-cost.test.ts',
  'tests/qa/integration/source-field.test.ts',
  'tests/qa/integration/source-support-attach.test.ts',
  'tests/qa/integration/translated-work-links.test.ts',
  'tests/qa/integration/web-auth-bootstrap.test.ts',
  'tests/qa/integration/work-address-api.test.ts',
  'tests/qa/integration/work-derivation.test.ts',
  // Discovery probes cut over classification and toggle the dataset restore hold.
  'tests/qa/integration/discovery-projection.test.ts',
  // Profile/library probes change disclosure, erasure and the dataset restore hold.
  'services/main/tests/profiles.integration.test.ts',
  // Person onboarding and vanity claims need a fresh Agent graph and Access owner.
  'tests/qa/integration/agent-handle.test.ts',
  // Directory assertions need an empty Realm population; scale probes inject raw heads and a global restore hold.
  'tests/qa/integration/realm-directory.test.ts',
  // Discovery refresh replays outboxes from zero and starts with no active population.
  'tests/qa/integration/discovery-refresh.test.ts',
  // Incremental discovery pins the exact initial Work population before appending writers.
  'tests/qa/integration/discovery-incremental.test.ts',
  // These readers bind whole-dataset populations or require matching graph/SQL owner histories.
  'tests/qa/integration/also-enjoyed.test.ts',
  'tests/qa/integration/authenticated-api-journey.test.ts',
  'tests/qa/integration/content-public-domain.test.ts',
  'tests/qa/integration/home-list-cards.test.ts',
  'tests/qa/integration/organization-publication-moderation.test.ts',
  'tests/qa/integration/public-search-cjk.test.ts',
  'tests/qa/integration/public-selection-oracle.test.ts',
  'tests/qa/integration/ranking-progress.test.ts',
  'tests/qa/integration/review-api.test.ts',
  'tests/qa/integration/search-chapter-book.test.ts',
  'tests/qa/integration/search-source-title.test.ts',
  'tests/qa/integration/wiki-realm-selection.test.ts',
  'tests/qa/integration/work-serial-projection.test.ts',
  // Previously qualified only on automatic retry; declare their fresh owner requirement up front.
  'tests/qa/integration/structure-relay.test.ts',
  'tests/qa/integration/main-selection-languages.test.ts',
  'tests/qa/integration/search-studio-chapter-content.test.ts',
  // The scale probe uses this bootstrapped project instead of provisioning a nested stack.
  'tests/qa/integration/growth-search-refresh.test.ts',
  // Global standing-rating cards must share their graph and Access population.
  'tests/qa/integration/search-card-fields.test.ts',
  // Confirmed fresh-project passes after shared graph/SQL history failures (G-408).
  'tests/qa/integration/search-card-rich.test.ts',
  'tests/qa/integration/search-title-body-native.test.ts',
  'tests/qa/integration/content-eligibility-order.test.ts',
  'tests/qa/integration/feed-reviews.test.ts',
  // G-401's assertions stay unchanged; the budget's population belongs to this file.
  'tests/qa/integration/feed-read-budget.test.ts',
  // Owner settlement and library discovery compare a complete fresh population.
  'tests/qa/integration/content-variant-order.test.ts',
  'tests/qa/integration/library-status.test.ts',
  // Home replays prior receipts; public paging requires coherent card owners.
  'tests/qa/integration/follows-authors.test.ts',
  'tests/qa/integration/paging-authority-search.test.ts',
  // Saved Filter tabs read Home's feed, which is global across the QA project's files.
  'tests/qa/integration/saved-filter.test.ts',
  // Continue across volumes seeds Home, whose relay replays prior receipts from zero (G-410).
  'tests/qa/integration/structure-book-volumes.test.ts',
  // These probes bind exact replay positions or a complete graph/owner population.
  'tests/qa/integration/g-825-structure-receipt-family.test.ts',
  'tests/qa/integration/g-585-script-folding.test.ts',
  // Relation history must use the same immutable object directory as its graph.
  'tests/qa/integration/g-905-catalogue.test.ts',
  // These probes finish or rank the complete graph population within fixed budgets.
  'tests/qa/integration/concept-page.test.ts',
  'tests/qa/integration/g-556-ranked-catalogue.test.ts',
  // Home's relay reads its complete retained outbox from sequence zero.
  'tests/qa/integration/g-542-endpoints.test.ts',
  // Retained relation definitions must use the object directory that owns their graph revisions.
  'tests/qa/integration/g-831-relations.test.ts',
  'tests/qa/integration/g-840-catalogue.test.ts',
  'tests/qa/integration/g-894-progress-summary.test.ts',
  // Release traversal probes own their complete global publication and owner inventory.
  'tests/qa/integration/g-851-release-query.test.ts',
  // Suitability's complete resource reads require matching global Rating Context and Access histories.
  'tests/qa/integration/g-897-suitability.test.ts',
  // Optional hydration seeds one Global question and owns its fresh discovery generations.
  'tests/qa/integration/g-1012-optional-hydration.test.ts',
  // Catalogue write/growth measurements own their initial population and disk-backed project.
  'tests/qa/integration/g-1031-catalogue-write.test.ts',
  // These drop the project's owner schemas; G1023 rebuilds only up to 1029.
  'tests/qa/integration/g-1023-alias-migration.test.ts',
  'tests/qa/integration/g-991-owner-migrations.test.ts',
  // Replays other files in one process; shared, their cached modules register no tests.
  // The raw-update scan follows imports through export-api, discovery-projection and work-cards fixtures.
  'tests/qa/integration/discovery-read-isolation.test.ts',
  // Synthetic outbox batches would reach later files' relays in a shared project.
  'tests/qa/integration/membership-seek.test.ts',
  'tests/qa/integration/g-1063-cost.test.ts',
  'tests/qa/integration/g-1056-occurrence-projection.test.ts',
  'tests/qa/integration/g-842-catalogue.test.ts',
  'tests/qa/integration/discovery-rating-effects.test.ts',
  'tests/qa/integration/model-custody-backfill.test.ts',
  // A thousand Studio chapter commands need their own wall budget and exact Work/Post inventory.
  'tests/qa/integration/post-catalogue-scale.test.ts',
  // Designates the first platform administrator on a fresh stack.
  'tests/qa/integration/platform-bootstrap.test.ts',
  // Online-index cancellation probes mutate owner migration receipts and create disposable schemas.
  'tests/qa/integration/concurrent-index-migrations.test.ts',
  // Statement projection commits while later writes continue, so this file owns the epoch and its coverage row.
  'tests/qa/integration/statement-seek-progress.test.ts',
  // Separate batches so the harness resets between them. The second file reads the Work-name scope rebuilt after that reset.
  'tests/qa/integration/work-name-scope-a-startup.test.ts',
  'tests/qa/integration/work-name-scope-b-after-reset.test.ts',
  // Name-record planting writes a synthetic outbox batch, so later relays must not see it.
  'tests/qa/integration/g-898-wiki-disclosure.test.ts',
  // The shared wiki journey plants the same synthetic batch through plantCharacterMerge.
  'tests/qa/integration/g-693-wiki-delta.test.ts',
  // Reply write cost compares two Realm sizes exactly. Other suites on the same database move that count.
  'services/main/tests/realm-reply-write-cost.test.ts',
  // The reserved-owner step plants one synthetic outbox batch through a profile-validated command, so later relays must not see it.
  'tests/qa/integration/semantic-change-race.test.ts',
  // Post lifecycle leaves a retained synthetic migration graph and an invalidated membership completion proof (65 legacy Works without a publisher), so a later file on the same database is refused as populated without prepared membership.
  'tests/qa/integration/post-lifecycle.test.ts',
  // Raw protection probes invalidate the membership completion proof, so later Recipe writers need a fresh project.
  'tests/qa/integration/g-829-public-reads.test.ts',
  // Person avatar delivery toggles the global Access recovery hold and ends its Account authority.
  'services/main/tests/account-deletion-person-avatar.test.ts',
  // Account-ending probes retain native names and refresh the catalogue index.
  'tests/qa/integration/person-ended-typeahead.test.ts',
  'tests/qa/integration/person-ended-name-search.test.ts',
  // Deployment-designation revocation must not end later files' publication assignment.
  'tests/qa/integration/review/source-publication-authority.test.ts',
  // Restores a bootstrapped Access baseline between destructive designation controls.
  'tests/qa/integration/review/governance-designation-revocation.test.ts',
  // Author preparation and lifecycle proofs own their command-created stopped corpus.
  'tests/qa/integration/outcomes/realm/studio-inventory.test.ts',
  'tests/qa/integration/outcomes/realm/published-author-lifecycle.test.ts',
] as const;

/** Delta proofs require the product assembler, whose raw update endpoint is closed. */
export const commandOnlyIntegrationFiles: ReadonlySet<string> = new Set([
  // Author preparation and restores require the closed product assembler.
  'tests/qa/integration/outcomes/realm/studio-inventory.test.ts',
  'tests/qa/integration/outcomes/realm/published-author-lifecycle.test.ts',
  // Imported licence delivery is proved through the production catalogue writer.
  'tests/qa/integration/imported-content-rights.test.ts',
  'services/main/tests/also-enjoyed-read-cost.integration.test.ts',
  // Context vocabulary growth owns its command-built Concept population and bounded read budget.
  'tests/qa/integration/classification-context-continuation.test.ts',
  'tests/qa/integration/g-1038-catalogue-scale.test.ts',
  'tests/qa/integration/growth-search-refresh.test.ts',
  // API-built corpus backups need the product assembler and a closed raw-update endpoint.
  'tests/qa/integration/realm-discussion-source.test.ts',
  // A standalone ranking confirmation can prepare the same stopped owner cut.
  'tests/qa/integration/outcomes/realm/ranking.test.ts',
  'tests/qa/integration/profile-corpus-restore.test.ts',
  'tests/qa/integration/recipe-page-growth.test.ts',
  'tests/qa/integration/zone-navigation-growth.test.ts',
  'tests/qa/integration/work-profile-seed-checkpoints.test.ts',
  // Explicit seed preparation uses the same product assembler as checkpoint restores.
  'tests/qa/fault-recovery/work-profile-seed-build.test.ts',
  // Library growth checkpoints retain and restore an API-built Work profile corpus.
  'tests/qa/integration/library-growth.test.ts',
  'tests/qa/integration/search-ranked-growth.test.ts',
  // restores the launch books corpus
  'tests/qa/integration/launch-real-books.test.ts',
  // API-built Gutenberg recipe corpus uses the product assembler and independent persistent restores.
  'tests/qa/integration/launch-real-recipes.test.ts',
  // Original title custody needs the exclusive product writer so startup can finish the Work-name directory.
  'tests/qa/integration/title-candidate-original-custody.test.ts',
]);

export interface RawSparqlIntegrationScan {
  roots: readonly string[];
  files: ReadonlySet<string>;
  sites: ReadonlyMap<string, readonly string[]>;
}

interface SourceToken {
  kind: 'identifier' | 'string' | 'template' | 'punctuation';
  value: string;
  line: number;
}

interface ImportReference {
  value?: string;
  line: number;
  unresolved?: string;
}

const rawUpdatePrefixes = /^(?:BASE|PREFIX|INSERT|DELETE|WITH|USING|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i;

function tokensOf(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let offset = 0;
  let line = 1;
  const recordLine = (start: number, end: number) => {
    line += source.slice(start, end).match(/\n/g)?.length ?? 0;
  };
  const skipString = (start: number, quote: string): number => {
    let cursor = start + 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') { cursor += 2; continue; }
      if (source[cursor] === quote) return cursor + 1;
      cursor++;
    }
    return source.length;
  };
  const skipTemplate = (start: number): number => {
    let cursor = start + 1;
    let expressionDepth = 0;
    while (cursor < source.length) {
      const character = source[cursor]!;
      if (character === '\\') { cursor += 2; continue; }
      if (expressionDepth === 0 && character === '`') return cursor + 1;
      if (expressionDepth === 0 && character === '$' && source[cursor + 1] === '{') {
        expressionDepth = 1;
        cursor += 2;
        continue;
      }
      if (expressionDepth > 0 && (character === '"' || character === "'")) {
        cursor = skipString(cursor, character);
        continue;
      }
      if (expressionDepth > 0 && character === '`') {
        cursor = skipTemplate(cursor);
        continue;
      }
      if (expressionDepth > 0 && character === '/' && source[cursor + 1] === '/') {
        const end = source.indexOf('\n', cursor + 2);
        cursor = end < 0 ? source.length : end + 1;
        continue;
      }
      if (expressionDepth > 0 && character === '/' && source[cursor + 1] === '*') {
        const end = source.indexOf('*/', cursor + 2);
        cursor = end < 0 ? source.length : end + 2;
        continue;
      }
      if (expressionDepth > 0 && character === '{') expressionDepth++;
      else if (expressionDepth > 0 && character === '}') expressionDepth--;
      cursor++;
    }
    return source.length;
  };

  while (offset < source.length) {
    const start = offset;
    const character = source[offset]!;
    if (/\s/.test(character)) { offset++; if (character === '\n') line++; continue; }
    if (character === '/' && source[offset + 1] === '/') {
      const end = source.indexOf('\n', offset + 2);
      offset = end < 0 ? source.length : end + 1;
      if (end >= 0) line++;
      continue;
    }
    if (character === '/' && source[offset + 1] === '*') {
      const end = source.indexOf('*/', offset + 2);
      offset = end < 0 ? source.length : end + 2;
      recordLine(start, offset);
      continue;
    }
    if (character === '"' || character === "'") {
      offset = skipString(start, character);
      const raw = source.slice(start + 1, offset - 1).replace(/\\([\\'"`])/g, '$1');
      tokens.push({ kind: 'string', value: raw, line });
      recordLine(start, offset);
      continue;
    }
    if (character === '`') {
      offset = skipTemplate(start);
      tokens.push({ kind: 'template', value: source.slice(start + 1, offset - 1), line });
      recordLine(start, offset);
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      offset++;
      while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset]!)) offset++;
      tokens.push({ kind: 'identifier', value: source.slice(start, offset), line });
      continue;
    }
    tokens.push({ kind: 'punctuation', value: character, line });
    offset++;
  }
  return tokens;
}

function importReferences(tokens: readonly SourceToken[]): ImportReference[] {
  const variables = new Map<string, string[]>();
  for (let index = 0; index < tokens.length - 3; index++) {
    if (!['const', 'let', 'var'].includes(tokens[index]!.value)) continue;
    const name = tokens[index + 1];
    if (name?.kind !== 'identifier' || tokens[index + 2]?.value !== '=') continue;
    const initializer = tokens[index + 3]!;
    if (initializer.kind === 'string' || initializer.kind === 'template') {
      variables.set(name.value, [initializer.value]);
      continue;
    }
    if (initializer.value !== '[') continue;
    const values: string[] = [];
    let cursor = index + 4;
    let onlyStrings = true;
    while (cursor < tokens.length && tokens[cursor]!.value !== ']') {
      const item = tokens[cursor]!;
      if (item.value !== ',' && item.kind !== 'string') onlyStrings = false;
      if (item.kind === 'string') values.push(item.value);
      cursor++;
    }
    if (onlyStrings && tokens[cursor]?.value === ']') variables.set(name.value, values);
  }
  for (let index = 0; index < tokens.length - 4; index++) {
    if (!['const', 'let', 'var'].includes(tokens[index]!.value) || tokens[index + 2]?.value !== 'of') continue;
    const name = tokens[index + 1];
    const collection = tokens[index + 3];
    if (name?.kind === 'identifier' && collection?.kind === 'identifier' && variables.has(collection.value))
      variables.set(name.value, variables.get(collection.value)!);
  }

  const references: ImportReference[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.value === 'import' && tokens[index + 1]?.value === '(') {
      const argument = tokens[index + 2];
      if (argument?.kind === 'string' || argument?.kind === 'template') {
        references.push({ value: argument.value, line: token.line });
      } else if (argument?.kind === 'identifier' && variables.has(argument.value)) {
        for (const value of variables.get(argument.value)!) references.push({ value, line: token.line });
      } else if (argument) {
        references.push({ line: token.line, unresolved: argument.value });
      }
      continue;
    }
    if (token.value !== 'import' && token.value !== 'export') continue;
    if (token.value === 'import' && tokens[index + 1]?.value === '.') continue;
    if (token.value === 'export' && !['*', '{', 'type'].includes(tokens[index + 1]?.value ?? '')) continue;
    if (tokens[index + 1]?.kind === 'string') {
      references.push({ value: tokens[index + 1]!.value, line: token.line });
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      if (tokens[cursor]!.value === ';') break;
      if (tokens[cursor]!.value === 'from' && tokens[cursor + 1]?.kind === 'string') {
        references.push({ value: tokens[cursor + 1]!.value, line: token.line });
        break;
      }
    }
  }
  return references;
}

function sourcePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

function sourceFileForImport(root: string, importer: string, specifier: string): string | undefined {
  const candidate = specifier.startsWith('/') ? resolve(specifier) : resolve(dirname(importer), specifier);
  const candidates = extname(candidate)
    ? [candidate, candidate.replace(/\.js$/i, '.ts'), candidate.replace(/\.mjs$/i, '.mts')]
    : ['.ts', '.tsx', '.mts', '.cts', '.js'].map(extension => `${candidate}${extension}`)
      .concat(['.ts', '.tsx', '.mts', '.cts', '.js'].map(extension => join(candidate, `index${extension}`)));
  return candidates.find(path => existsSync(path) && !relative(root, path).startsWith(`..${sep}`));
}

function isSupportSource(root: string, file: string): boolean {
  const path = sourcePath(root, file);
  return path.startsWith('tests/') || path.startsWith('scripts/qa/')
    || path.startsWith('scripts/fixture/') || path.startsWith('scripts/dev/');
}

function rawUpdateCallSites(tokens: readonly SourceToken[]): string[] {
  const sites: string[] = [];
  const fusekiBindings = new Set<string>();
  for (let index = 0; index < tokens.length - 2; index++) {
    const token = tokens[index]!;
    if (!['const', 'let', 'var'].includes(token.value) || tokens[index + 1]?.kind !== 'identifier') continue;
    const name = tokens[index + 1]!.value;
    let end = index + 2;
    while (end < tokens.length && !['=', ';', ')', ','].includes(tokens[end]!.value)) end++;
    const declaration = tokens.slice(index, Math.min(tokens.length, end + 5)).map(item => item.value).join(' ');
    if (/\bFusekiClient\b/.test(declaration) || /\bnew\s+FusekiClient\b/.test(declaration)) fusekiBindings.add(name);
  }
  for (let index = 0; index < tokens.length - 2; index++) {
    const name = tokens[index];
    if (name?.kind !== 'identifier' || tokens[index + 1]?.value !== ':') continue;
    const annotation = tokens.slice(index + 2, index + 10).map(token => token.value).join(' ');
    if (/\bFusekiClient\b/.test(annotation)) fusekiBindings.add(name.value);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < tokens.length - 3; index++) {
      if (!['const', 'let', 'var'].includes(tokens[index]!.value) || tokens[index + 1]?.kind !== 'identifier') continue;
      const name = tokens[index + 1]!.value;
      let equals = index + 2;
      while (equals < tokens.length && !['=', ';'].includes(tokens[equals]!.value)) equals++;
      if (tokens[equals]?.value !== '=') continue;
      const initializer: string[] = [];
      for (let cursor = equals + 1; cursor < tokens.length; cursor++) {
        const token = tokens[cursor]!;
        if (token.kind === 'identifier' || token.value === '.') initializer.push(token.value);
        else break;
      }
      const identifiers = initializer.filter(value => value !== '.');
      if (identifiers.some(value => /^(?:native)?fuseki$/i.test(value) || fusekiBindings.has(value)))
        fusekiBindings.add(name);
    }
  }
  const isRawQuery = (token: SourceToken | undefined) =>
    (token?.kind === 'string' || token?.kind === 'template') && rawUpdatePrefixes.test(token.value.trimStart());
  for (let index = 2; index < tokens.length - 2; index++) {
    const method = tokens[index]!;
    if (method.value !== 'update' || tokens[index - 1]?.value !== '.' || tokens[index + 1]?.value !== '(') continue;
    let start = index - 2;
    while (start >= 2 && tokens[start - 1]?.value === '.' && tokens[start - 2]?.kind === 'identifier') start -= 2;
    const receiver = tokens.slice(start, index - 1).map(item => item.value).join('');
    const identifiers = receiver.split('.');
    const knownFuseki = identifiers.some(name => /^(?:native)?fuseki$/i.test(name) || fusekiBindings.has(name));
    const graphClient = identifiers.some(name => /^(?:graph|client)$/i.test(name) || fusekiBindings.has(name));
    if (knownFuseki || graphClient && isRawQuery(tokens[index + 2])) sites.push(`${method.line}: ${receiver}.update()`);
  }

  const privateProductIngressProbe = tokens.some((token, index) => token.value === 'FUSEKI_URL'
    && tokens[index - 1]?.value === '.' && tokens[index - 2]?.value === 'apps')
    && (tokens.some(token => token.value === 'qaStack')
      || tokens.some(token => token.value === 'stack:up' || token.value === 'stack:reset'));
  const updateEndpoints = tokens.filter((token, index) => {
    if (token.kind !== 'string' && token.kind !== 'template') return false;
    if (/\/update(?:[/?#]|$)/i.test(token.value)) return true;
    return token.value === 'update' && tokens[index - 1]?.value === '(' && tokens[index - 2]?.value === 'URL'
      && tokens[index - 3]?.value === 'new';
  });
  const sparqlUpdateContentTypes = tokens.filter(token => (token.kind === 'string' || token.kind === 'template')
    && /application\/sparql-update/i.test(token.value));
  const hasHttpRequest = tokens.some((token, index) => ['fetch', 'Request'].includes(token.value)
    && tokens[index + 1]?.value === '(');
  if (hasHttpRequest && !privateProductIngressProbe) {
    for (const token of updateEndpoints) sites.push(`${token.line}: raw /update request`);
    for (const token of sparqlUpdateContentTypes) sites.push(`${token.line}: application/sparql-update`);
  }
  return [...new Set(sites)];
}

/** Scan registered integration roots and their local test/fixture support imports.
 * Product-ingress probes that start their own product stack do not select this shard's assembler. */
export function scanRawSparqlIntegrationFiles(root = resolve(import.meta.dir, '../..')): RawSparqlIntegrationScan {
  const roots = new Set<string>();
  for (const file of repositoryFiles(root)) {
    if (file.startsWith('tests/qa/integration/') && /\.test\.tsx?$/.test(file)) roots.add(file);
  }
  for (const file of integrationGateFiles) {
    if (existsSync(join(root, file)) && /\.test\.tsx?$/.test(file)) roots.add(file);
  }

  const files = new Set<string>();
  const sites = new Map<string, readonly string[]>();
  // Helpers are shared by hundreds of roots. Parse each source once per scan,
  // while keeping a fresh dependency traversal and provenance for every root.
  const sources = new Map<string, { sites: string[]; references: ImportReference[] }>();
  for (const rootFile of [...roots].sort()) {
    const visited = new Set<string>();
    const pending = [resolve(root, rootFile)];
    const rootSites: string[] = [];
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      let analysis = sources.get(file);
      if (!analysis) {
        const tokens = tokensOf(readFileSync(file, 'utf8'));
        analysis = { sites: rawUpdateCallSites(tokens), references: importReferences(tokens) };
        sources.set(file, analysis);
      }
      rootSites.push(...analysis.sites.map(site => `${sourcePath(root, file)}:${site}`));
      for (const reference of analysis.references) {
        if (reference.unresolved) {
          throw new Error(`Cannot resolve imported test helper at ${sourcePath(root, file)}:${reference.line}: ${reference.unresolved}`);
        }
        const specifier = reference.value!;
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
        const dependency = sourceFileForImport(root, file, specifier);
        if (!dependency) {
          throw new Error(`Cannot resolve local integration import at ${sourcePath(root, file)}:${reference.line}: ${specifier}`);
        }
        if (isSupportSource(root, dependency)) pending.push(dependency);
      }
    }
    if (rootSites.length) {
      files.add(rootFile);
      sites.set(rootFile, [...new Set(rootSites)].sort());
    }
  }
  return { roots: [...roots].sort(), files, sites };
}

let cachedRawSparqlIntegrationScan: RawSparqlIntegrationScan | undefined;

/** Defer crawling integration tests until a caller needs assembler classification.
 * Most QA CLI imports do not plan integration shards and should stay cheap. */
export function rawSparqlIntegrationScan(): RawSparqlIntegrationScan {
  cachedRawSparqlIntegrationScan ??= scanRawSparqlIntegrationFiles();
  return cachedRawSparqlIntegrationScan;
}

export function rawSparqlIntegrationFiles(): ReadonlySet<string> {
  return rawSparqlIntegrationScan().files;
}
