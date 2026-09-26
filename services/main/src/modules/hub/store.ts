import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContentCore, VariantIdentity } from '../../../../content/src/core.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import { PackageArtifactStore } from '../package/lock-artifacts.ts';
import { npmSnapshotSyntax } from '../package/npm-lock.ts';
import { collisionKey, confinedPath } from '../package/install-archive.ts';
import { stableJson } from '../package/lock-schema.ts';
import { saveAdmittedHubDraft } from './admitted.ts';
import type { HubImportRow, HubRevisionFileRow, HubRevisionRequirementRow, HubRevisionRow }
  from './schema.ts';

export class HubInvalid extends Error {}
export class HubConflict extends Error {}
export class HubUnavailable extends Error {}

export interface HubIdentity {
  resourceId: string;
  variantId: string;
  language: VariantIdentity['language'];
  direction: VariantIdentity['direction'];
  expectedHead: string | null;
  actingSubject: string;
}
export interface SkillImportInput extends HubIdentity {
  profile: 'agent-skills-directory-import-v1';
  sourceFormat: 'agent-skills-directory-v1';
  sourceLocator: { label: string };
  files: Array<{ path: string; bytesBase64: string; executable: boolean }>;
}
export interface PromptRevisionInput extends HubIdentity {
  profile: 'rezics-prompt-revision-v1';
  content: string;
  parameterSchema: Record<string, unknown>;
  examples: Array<{ parameters: Record<string, unknown>; output: string }>;
  applicability: { models: string[]; tools: string[] };
}
export interface HubImportView {
  import: string; revision: string; variant: string; contentOperation: string;
  sourceTreeSha256: string; name: string; description: string;
  files: Array<{ path: string; file: string; sha256: string; role: string;
    executable: boolean; bytesBase64: string }>;
  missingRequirements: string[]; requirements: HubRequirementView[]; residuals: string[]; createdAt: string;
}
export interface HubRequirementView {
  ordinal: number; ecosystem: string; nativeSelector: string; target: Record<string, unknown>;
  strength: 'required' | 'optional'; declaration: 'declared' | 'missing' | 'unsupported';
  sourcePath: string; sourcePointer: string;
}
export interface PromptRevisionView {
  revision: string; variant: string; predecessor: string | null;
  content: string; parameterSchema: Record<string, unknown>;
  examples: Array<{ parameters: Record<string, unknown>; output: string }>;
  applicability: PromptRevisionInput['applicability']; schemaSha256: string; createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_IMPORT_BYTES = 1_048_576;
const MAX_FILES = 128;
const PACKAGE_REQUIREMENTS_PATH = 'rezics.package-requirements.json';
const PACKAGE_REQUIREMENTS_PROFILE = 'rezics-skill-package-requirements-v1';
const PACKAGE_REQUIREMENTS_LIMIT = 65_536;
const PACKAGE_ECOSYSTEMS = new Set(['npm', 'cargo', 'go']);

/** Parse the bounded REZICS sidecar; selectors remain ecosystem-native strings. */
export function inspectSkillPackageRequirements(files: Array<{ path: string; bytes: Uint8Array }> ):
  Omit<HubRequirementView, 'ordinal'>[] {
  const sidecar = files.find(file => file.path === PACKAGE_REQUIREMENTS_PATH);
  if (!sidecar) return [];
  if (sidecar.bytes.byteLength > PACKAGE_REQUIREMENTS_LIMIT) {
    throw new HubInvalid('Skill package requirement file exceeds its byte budget');
  }
  let root: Record<string, unknown>;
  try {
    root = npmSnapshotSyntax.parseJson(decoder.decode(sidecar.bytes));
  } catch { throw new HubInvalid('Skill package requirement file is not valid UTF-8 JSON'); }
  if (Object.keys(root).sort().join(',') !== 'profile,requirements'
    || root.profile !== PACKAGE_REQUIREMENTS_PROFILE || !Array.isArray(root.requirements)
    || root.requirements.length > 256) {
    throw new HubInvalid('Skill package requirement file has an unsupported shape');
  }
  return root.requirements.map((item, ordinal) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HubInvalid(`Skill package requirement ${ordinal} is malformed`);
    }
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'ecosystem,selector,strength,target'
      || typeof entry.ecosystem !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.ecosystem)
      || typeof entry.selector !== 'string' || !entry.selector.trim()
      || entry.selector !== entry.selector.trim()
      || Buffer.byteLength(entry.selector) > 1024 || !['required', 'optional'].includes(String(entry.strength))
      || !entry.target || typeof entry.target !== 'object' || Array.isArray(entry.target)
      || Buffer.byteLength(stableJson(entry.target)) > 4096) {
      throw new HubInvalid(`Skill package requirement ${ordinal} is malformed`);
    }
    const sourcePointer = `/requirements/${ordinal}`;
    return { ecosystem: entry.ecosystem, nativeSelector: entry.selector,
      target: entry.target as Record<string, unknown>,
      strength: entry.strength as HubRequirementView['strength'],
      declaration: PACKAGE_ECOSYSTEMS.has(entry.ecosystem) ? 'declared' as const : 'unsupported' as const,
      sourcePath: sidecar.path, sourcePointer };
  });
}

function exactBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HubInvalid('file bytes must use canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new HubInvalid('file bytes are not canonical');
  return bytes;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

/** Parse only scalar frontmatter; retain the entire exact SKILL.md for richer clients. */
export function inspectSkillManifest(text: string, paths: Set<string>): {
  name: string; description: string; missingRequirements: string[]; residuals: string[] } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) throw new HubInvalid('SKILL.md needs YAML frontmatter');
  const fields = new Map<string, string>();
  const residuals: string[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    if (!field) { if (line.trim()) residuals.push(`unparsed-frontmatter:${line.trim().slice(0, 120)}`); continue; }
    if (fields.has(field[1]!)) throw new HubInvalid(`duplicate ${field[1]} declaration`);
    fields.set(field[1]!, scalar(field[2]!));
    if (!['name', 'description', 'license', 'compatibility', 'allowed-tools'].includes(field[1]!)) {
      residuals.push(`unsupported-frontmatter:${field[1]}`);
    }
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64
    || !description || description.length > 1024) throw new HubInvalid('invalid Skill name or description');
  const missingRequirements = new Set<string>();
  for (const field of ['compatibility', 'allowed-tools']) {
    if (fields.has(field)) missingRequirements.add(`${field}:requires-independent-validation`);
  }
  for (const link of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const path = link[1]!.split('#')[0]!;
    if (!path || /^(https?:|mailto:)/i.test(path)) continue;
    if (!confinedPath(path) || !paths.has(path)) missingRequirements.add(`file:${path}`);
  }
  return { name, description, missingRequirements: [...missingRequirements].sort(), residuals };
}

function checkIdentity(input: HubIdentity): VariantIdentity {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.resourceId)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/i.test(input.variantId)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.actingSubject)
    || (input.expectedHead !== null && !UUID.test(input.expectedHead))) {
    throw new HubInvalid('invalid Hub identity');
  }
  return { id: input.variantId, resourceId: input.resourceId,
    language: input.language, direction: input.direction };
}

function checkSchema(schema: Record<string, unknown>, examples: PromptRevisionInput['examples']): void {
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
    || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object'
    || Array.isArray(schema.properties) || Object.keys(schema).some(key => ![
      '$schema', 'type', 'properties', 'required', 'additionalProperties', 'description', 'title',
    ].includes(key))) throw new HubInvalid('unsupported parameter schema');
  const properties = schema.properties as Record<string, unknown>;
  if (Object.keys(properties).length > 64 || !Array.isArray(schema.required)
    || schema.required.some(item => typeof item !== 'string' || !Object.hasOwn(properties, item))
    || schema.additionalProperties !== false) throw new HubInvalid('invalid parameter requirements');
  const types = new Map<string, string>();
  for (const [name, definition] of Object.entries(properties)) {
    const field = definition as Record<string, unknown>;
    if (!field || typeof field !== 'object' || Array.isArray(field)
      || !['string', 'number', 'integer', 'boolean'].includes(String(field.type))
      || Object.keys(field).some(key => !['type', 'description'].includes(key))) {
      throw new HubInvalid(`unsupported parameter ${name}`);
    }
    types.set(name, String(field.type));
  }
  for (const example of examples) {
    if (typeof example.output !== 'string' || example.output.length > 16_384
      || !example.parameters || Array.isArray(example.parameters)
      || schema.required.some(item => !Object.hasOwn(example.parameters, item as string))) {
      throw new HubInvalid('example does not satisfy required parameters');
    }
    for (const [name, value] of Object.entries(example.parameters)) {
      const type = types.get(name);
      if (!type || (type === 'integer' ? !Number.isInteger(value)
        : typeof value !== type)) throw new HubInvalid('example differs from parameter schema');
    }
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export class HubStore {
  constructor(private readonly pool: Pool, private readonly content: ContentCore,
    private readonly access: AccessAdmissionRegistry, private readonly environment: WorkActivationEnvironment,
    private readonly artifacts: PackageArtifactStore) {}

  async importSkill(principal: VerifiedPrincipal, principalId: string, key: string,
    input: SkillImportInput): Promise<{ value: HubImportView; replayed: boolean }> {
    const variant = checkIdentity(input);
    if (input.profile !== 'agent-skills-directory-import-v1'
      || input.sourceFormat !== 'agent-skills-directory-v1' || input.expectedHead !== null
      || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)
      || !input.sourceLocator?.label || input.sourceLocator.label.length > 256
      || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
      throw new HubInvalid('invalid Skill directory import');
    }
    let total = 0;
    const files = input.files.map(file => {
      if (!confinedPath(file.path) || typeof file.executable !== 'boolean') {
        throw new HubInvalid('Skill file path is not confined');
      }
      const bytes = exactBase64(file.bytesBase64);
      total += bytes.byteLength;
      return { path: file.path, executable: file.executable, bytes, sha256: sha(bytes) };
    }).sort((a, b) => a.path < b.path ? -1 : 1);
    if (total > MAX_IMPORT_BYTES || new Set(files.map(file => collisionKey(file.path))).size !== files.length) {
      throw new HubInvalid('Skill directory exceeds byte budget or collides by path');
    }
    const manifest = files.find(file => file.path === 'SKILL.md');
    if (!manifest) throw new HubInvalid('Skill directory lacks SKILL.md');
    if (manifest.bytes.byteLength > 65_536) throw new HubInvalid('SKILL.md exceeds text budget');
    let text: string;
    try { text = decoder.decode(manifest.bytes); }
    catch { throw new HubInvalid('SKILL.md is not UTF-8'); }
    const inspected = inspectSkillManifest(text, new Set(files.map(file => file.path)));
    if (inspected.name !== input.sourceLocator.label) {
      throw new HubInvalid('Skill name must match its directory label');
    }
    if (inspected.missingRequirements.length + inspected.residuals.length > 256
      || Buffer.byteLength(stableJson([...inspected.missingRequirements, ...inspected.residuals])) > 32_768) {
      throw new HubInvalid('Skill declarations exceed the residual budget');
    }
    const packageRequirements = inspectSkillPackageRequirements(files);
    const tree = sha(stableJson(files.map(file => ({ path: file.path,
      sha256: file.sha256, executable: file.executable }))));
    const body = stableJson({ profile: 'rezics-skill-package-v1', name: inspected.name,
      description: inspected.description, instructions: text, sourceFormat: input.sourceFormat,
      sourceLocator: input.sourceLocator, sourceTreeSha256: tree,
      files: files.map(file => ({ path: file.path, sha256: file.sha256,
        executable: file.executable })), missingRequirements: inspected.missingRequirements,
      packageRequirements, residuals: inspected.residuals });
    if (Buffer.byteLength(body, 'utf8') > MAX_IMPORT_BYTES) {
      throw new HubInvalid('Skill revision exceeds the retained Content byte budget');
    }
    const requestDigest = sha(stableJson({ key, body, variant, actingSubject: input.actingSubject }));
    const previous = await this.importByKey(principalId, key);
    if (previous && previous.request_digest !== requestDigest) throw new HubConflict('import key belongs to another request');
    const { saved, operationId } = await saveAdmittedHubDraft(this.environment, this.content,
      this.access, principal, { resourceId: input.resourceId, variant, expectedHead: null,
        model: 'rezics-skill-package-v1', serializedJson: body,
        actingSubject: input.actingSubject, idempotencyKey: key });
    if (!saved.revisionId) throw new HubUnavailable('Content saved no Skill revision');
    if (!previous) {
      const retained = await Promise.all(files.map(file => this.artifacts.retain(file.bytes,
        file.path === 'SKILL.md' ? 'text/markdown' : 'application/octet-stream', principalId)));
      try {
        await transaction(this.pool, async client => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`hub-import:${principalId}:${key}`]);
          const occupied = await client.query<{ request_digest: string }>(`SELECT request_digest
            FROM hub.import WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key]);
          if (occupied.rows[0]) {
            if (occupied.rows[0].request_digest !== requestDigest) throw new HubConflict('concurrent Skill import differs');
            return;
          }
          await client.query(`INSERT INTO hub.variant_profile (variant_id, kind)
            VALUES ($1, 'skill-package') ON CONFLICT DO NOTHING`, [input.variantId]);
          await client.query(`INSERT INTO hub.revision (revision_id, variant_id, kind, body_model,
              applicability, file_count, requirement_count)
            VALUES ($1, $2, 'skill-package', 'rezics-skill-package-v1', '{}', $3, $4)
            ON CONFLICT DO NOTHING`, [saved.revisionId, input.variantId, files.length, packageRequirements.length]);
          for (const [index, file] of files.entries()) {
            await client.query(`INSERT INTO hub.revision_file (revision_id, path, file_id, role,
                artifact_id, sha256, mode_executable)
              VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [saved.revisionId, file.path, randomUUID(), file.path === 'SKILL.md' ? 'manifest'
              : file.path.startsWith('scripts/') ? 'script'
                : file.path.startsWith('references/') ? 'reference'
                  : file.path.startsWith('assets/') ? 'asset' : 'other',
            retained[index]!.id, file.sha256, file.executable]);
          }
          for (const [ordinal, requirement] of packageRequirements.entries()) {
            await client.query(`INSERT INTO hub.revision_requirement (revision_id, ordinal, ecosystem,
                native_selector, target, strength, declaration, source_path, source_pointer)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [saved.revisionId, ordinal, requirement.ecosystem, requirement.nativeSelector,
              JSON.stringify(requirement.target), requirement.strength, requirement.declaration,
              requirement.sourcePath, requirement.sourcePointer]);
          }
          await client.query(`INSERT INTO hub.import (id, principal_id, idempotency_key, request_digest,
              source_format, source_tree_sha256, source_locator, ingest_profile, outcome,
              content_operation_id, revision_id, residuals, unsupported)
            VALUES ($1, $2, $3, $4, 'agent-skills-directory-v1', $5, $6,
              'inert-ingest-v1', 'imported', $7, $8, $9, '[]')`,
          [randomUUID(), principalId, key, requestDigest, tree, JSON.stringify(input.sourceLocator),
            operationId, saved.revisionId, JSON.stringify([...inspected.missingRequirements,
              ...inspected.residuals])]);
        });
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
      }
    }
    const row = await this.importByKey(principalId, key);
    if (!row || row.request_digest !== requestDigest || row.revision_id !== saved.revisionId) {
      throw new HubConflict('concurrent Skill import differs');
    }
    const value = await this.readImport(principalId, row.id);
    if (!value) throw new HubUnavailable('saved Skill import is unavailable');
    return { value, replayed: saved.replayed || !!previous };
  }

  async readImport(principalId: string, id: string): Promise<HubImportView | null> {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query<HubImportRow>(`SELECT * FROM hub.import
      WHERE id = $1 AND principal_id = $2 AND outcome = 'imported'`, [id, principalId])).rows[0];
    if (!row?.revision_id || !row.content_operation_id) return null;
    const files = (await this.pool.query<HubRevisionFileRow>(`SELECT * FROM hub.revision_file
      WHERE revision_id = $1 ORDER BY path LIMIT 129`, [row.revision_id])).rows;
    if (files.length > MAX_FILES) throw new HubUnavailable('Skill file inventory exceeds admitted limit');
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const artifacts = await Promise.all(files.map(file => this.artifacts.read(file.artifact_id)));
    if ((await this.artifacts.revoked(artifacts.map(item => item.row.sha256))).size) {
      throw new HubUnavailable('Skill file was revoked');
    }
    const exact = (await this.content.readExactBatch([row.revision_id], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new HubUnavailable('Skill Content revision is unavailable');
    const body = exact.body;
    if (body.sourceTreeSha256 !== row.source_tree_sha256
      || sha(stableJson(files.map(file => ({ path: file.path, sha256: file.sha256,
        executable: file.mode_executable })))) !== row.source_tree_sha256) {
      throw new HubUnavailable('Skill inventory differs from its exact Content revision');
    }
    const requirements = await this.readSkillRequirementViews(row.revision_id);
    const exactRequirements = (body.packageRequirements as Array<Omit<HubRequirementView, 'ordinal'>>) ?? [];
    if (stableJson(exactRequirements) !== stableJson(requirements.map(({ ordinal: _ordinal, ...item }) => item))) {
      throw new HubUnavailable('Skill requirement rows differ from their exact Content revision');
    }
    return { import: row.id, revision: row.revision_id, variant: exact.reference.variantId,
      contentOperation: row.content_operation_id, sourceTreeSha256: row.source_tree_sha256,
      name: String(body.name), description: String(body.description),
      files: files.map((file, index) => ({ path: file.path, file: file.file_id, sha256: file.sha256,
        role: file.role, executable: file.mode_executable,
        bytesBase64: Buffer.from(artifacts[index]!.bytes).toString('base64') })),
      missingRequirements: (body.missingRequirements as string[]) ?? [],
      requirements,
      residuals: (body.residuals as string[]) ?? [], createdAt: row.created_at.toISOString() };
  }

  async importResource(principalId: string, id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    return (await this.pool.query<{ resource_id: string }>(`SELECT v.resource_id FROM hub.import i
      JOIN hub.revision h ON h.revision_id = i.revision_id
      JOIN content.variant v ON v.id = h.variant_id
      WHERE i.id = $1 AND i.principal_id = $2 AND i.outcome = 'imported'`,
    [id, principalId])).rows[0]?.resource_id ?? null;
  }

  async revisePrompt(principal: VerifiedPrincipal, key: string, input: PromptRevisionInput):
    Promise<{ value: PromptRevisionView; replayed: boolean }> {
    const variant = checkIdentity(input);
    if (input.profile !== 'rezics-prompt-revision-v1' || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)
      || !input.content || input.content.length > 65_536 || !Array.isArray(input.examples)
      || input.examples.length > 32 || !input.applicability
      || !Array.isArray(input.applicability.models) || !Array.isArray(input.applicability.tools)
      || input.applicability.models.length + input.applicability.tools.length > 64
      || [...input.applicability.models, ...input.applicability.tools].some(item =>
        typeof item !== 'string' || !item || item.length > 200)) {
      throw new HubInvalid('invalid Prompt revision');
    }
    checkSchema(input.parameterSchema, input.examples);
    const schemaSha = sha(stableJson(input.parameterSchema));
    const body = stableJson({ profile: 'rezics-prompt-v1', content: input.content,
      parameterSchema: input.parameterSchema, examples: input.examples,
      applicability: input.applicability });
    if (Buffer.byteLength(body, 'utf8') > 262_144) throw new HubInvalid('Prompt revision exceeds byte budget');
    const { saved } = await saveAdmittedHubDraft(this.environment, this.content, this.access,
      principal, { resourceId: input.resourceId, variant, expectedHead: input.expectedHead,
        model: 'rezics-prompt-v1', serializedJson: body,
        actingSubject: input.actingSubject, idempotencyKey: key });
    if (!saved.revisionId) throw new HubUnavailable('Content saved no Prompt revision');
    await transaction(this.pool, async client => {
      await client.query(`INSERT INTO hub.variant_profile (variant_id, kind)
        VALUES ($1, 'prompt') ON CONFLICT DO NOTHING`, [input.variantId]);
      await client.query(`INSERT INTO hub.revision (revision_id, variant_id, kind, body_model,
          applicability, parameter_schema_sha256, parameter_schema_dialect, file_count, requirement_count)
        VALUES ($1, $2, 'prompt', 'rezics-prompt-v1', $3, $4,
          'https://json-schema.org/draft/2020-12/schema', 0, 0) ON CONFLICT DO NOTHING`,
      [saved.revisionId, input.variantId, JSON.stringify(input.applicability), schemaSha]);
    });
    const value = await this.readPrompt(saved.revisionId);
    if (!value) throw new HubUnavailable('saved Prompt revision is unavailable');
    return { value, replayed: saved.replayed };
  }

  async promptResource(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    return (await this.pool.query<{ resource_id: string }>(`SELECT v.resource_id FROM hub.revision h
      JOIN content.variant v ON v.id = h.variant_id WHERE h.revision_id = $1 AND h.kind = 'prompt'`,
    [id])).rows[0]?.resource_id ?? null;
  }

  /** Resolve a Skill revision to its owning resource before package work. */
  async skillResource(id: string): Promise<string | null> {
    if (!UUID.test(id)) return null;
    return (await this.pool.query<{ resource_id: string }>(`SELECT v.resource_id FROM hub.revision h
      JOIN content.variant v ON v.id = h.variant_id
      WHERE h.revision_id = $1 AND h.kind = 'skill-package'`, [id])).rows[0]?.resource_id ?? null;
  }

  async skillRequirements(id: string): Promise<HubRequirementView[]> {
    if (!UUID.test(id)) return [];
    const kind = (await this.pool.query(`SELECT 1 FROM hub.revision
      WHERE revision_id = $1 AND kind = 'skill-package'`, [id])).rowCount;
    return kind ? this.readSkillRequirementViews(id) : [];
  }

  private async readSkillRequirementViews(id: string): Promise<HubRequirementView[]> {
    const rows = (await this.pool.query<HubRevisionRequirementRow>(`SELECT * FROM hub.revision_requirement
      WHERE revision_id = $1 ORDER BY ordinal LIMIT 257`, [id])).rows;
    if (rows.length > 256) throw new HubUnavailable('Skill requirement inventory exceeds its limit');
    return rows.map(row => ({ ordinal: row.ordinal, ecosystem: row.ecosystem,
      nativeSelector: row.native_selector, target: row.target, strength: row.strength,
      declaration: row.declaration, sourcePath: row.source_path, sourcePointer: row.source_pointer }));
  }

  async readPrompt(id: string): Promise<PromptRevisionView | null> {
    if (!UUID.test(id)) return null;
    const row = (await this.pool.query<HubRevisionRow>(`SELECT * FROM hub.revision
      WHERE revision_id = $1 AND kind = 'prompt'`, [id])).rows[0];
    if (!row) return null;
    const exact = (await this.content.readExactBatch([id], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new HubUnavailable('Prompt Content revision is unavailable');
    const body = exact.body;
    if (sha(stableJson(body.parameterSchema)) !== row.parameter_schema_sha256) {
      throw new HubUnavailable('Prompt schema digest differs');
    }
    if (stableJson(body.applicability) !== stableJson(row.applicability)) {
      throw new HubUnavailable('Prompt applicability differs from its exact Content revision');
    }
    return { revision: id, variant: row.variant_id, predecessor: exact.reference.predecessor,
      content: String(body.content), parameterSchema: body.parameterSchema as Record<string, unknown>,
      examples: body.examples as PromptRevisionView['examples'],
      applicability: body.applicability as PromptRevisionView['applicability'],
      schemaSha256: row.parameter_schema_sha256!, createdAt: row.created_at.toISOString() };
  }

  private async importByKey(principalId: string, key: string): Promise<HubImportRow | undefined> {
    return (await this.pool.query<HubImportRow>(`SELECT * FROM hub.import
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
  }
}
