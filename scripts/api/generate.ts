import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openapi } from '@elysia/openapi';
import { createMainApp, type MainWorkDependencies } from '../../services/main/src/app.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';

const artifact = 'generated/openapi/main/public.json';
const commands = [
  '/v1/works/{id}/title-control/source-return',
  '/v1/content-drafts',
  '/v1/content-comments',
  '/v1/content-publications', '/v1/content-search-eligibility',
  '/v1/rating-observations', '/v1/rating-contexts',
  '/v1/rating-contexts/{id}/policy-revisions', '/v1/classification-decisions',
  '/v1/classification-propositions', '/v1/classification-contexts', '/v1/spaces',
  '/v1/publication-selections', '/v1/publication-rejections',
  '/v1/contribution-publications', '/v1/contribution-edits', '/v1/contributions',
  '/v1/works', '/v1/works/{id}/scalar-value', '/v1/translation-links', '/v1/content-edits',
  '/v1/access/group-changes', '/v1/access/group-impact-proposals',
  '/v1/access/group-impact-approvals',
  '/v1/access/grant-changes',
  '/v1/access/membership-changes',
  '/v1/access/eligible-org-member-set-grant-changes',
  '/v1/access/selected-org-membership-changes',
  '/v1/access/org-realm-proposals', '/v1/access/org-realm-changes', '/v1/access/org-realm-moves',
  '/v1/access/managed-organization-grants', '/v1/access/organization-roster-policy',
  '/v1/me/membership-consents',
  '/v1/me/membership-consent-revocations',
  '/v1/me/private-membership-consents',
  '/v1/access/private-membership-changes',
  '/v1/access/private-group-member-changes',
  '/v1/access/private-role-binding-changes',
  '/v1/me/representation-requests', '/v1/access/representation-changes',
  '/v1/access/roles', '/v1/access/role-revisions', '/v1/access/role-bindings',
  '/v1/addresses/claims', '/v1/addresses/renames', '/v1/addresses/dispositions',
] as const;
const privateReads = [
  '/v1/works/{id}/title-control',
  '/v1/works/{id}/scalar-value',
  '/v1/works/{id}/scalar-value/revisions/{revision}',
  '/v1/works/{id}/author-credits/{credit}/revisions/{revision}',
  '/v1/me/acting-contexts',
  '/v1/me/main-versions/{mainVersion}/selection',
  '/v1/me/realms/{realm}/main-versions/{mainVersion}/selection',
  '/v1/rating-observations/{observation}/revisions/{revision}',
  '/v1/rating-contexts/{id}/policy-revisions/{revision}',
  '/v1/contributions/{contribution}/drafts/{revision}',
  '/v1/main-versions/{mainVersion}/revisions/{revision}',
  '/v1/revisions/{revision}',
  '/v1/content-revisions/{revision}',
  '/v1/content-revisions/{revision}/comments',
  '/v1/content-comments/{comment}',
  '/v1/access/group-scope', '/v1/access/group-impact-proposals/{proposalId}',
  '/v1/access/grants', '/v1/access/grants/{grantId}',
  '/v1/access/representation-requests/{requestId}',
  '/v1/access/representations/{representationId}',
  '/v1/access/eligible-org-member-set-grants/{grantId}',
  '/v1/me/selected-org-membership-changes',
  '/v1/access/roles/{familyId}', '/v1/access/role-bindings',
  '/v1/access/role-bindings/{bindingId}',
  '/v1/me/private-memberships',
  '/v1/access/org-realm-participation',
  '/v1/access/organization-management', '/v1/access/managed-organization-grants/{grantId}',
] as const;
const privateChecks = ['/v1/me/acting-context-checks',
  '/v1/me/private-membership-consent-revocations'] as const;
const privateWrites = ['/v1/me/main-versions/{mainVersion}/variant-preference',
  '/v1/realms/{realm}/main-versions/{mainVersion}/variant-recommendation'] as const;
const sourceReads = [
  '/v1/sources/author-credit-supports/{support}',
  '/v1/sources/observations/{observation}',
  '/v1/sources/conversions/{conversion}',
  '/v1/sources/conversions/{base}/drift/{candidate}',
  '/v1/sources/conversions/{base}/child-correspondences/{candidate}',
  '/v1/sources/correspondences/{correspondence}',
  '/v1/sources/conversions/{conversion}/source-graph',
  '/v1/sources/proposals/{proposal}',
  '/v1/sources/proposals/{proposal}/adoption/native-work',
  '/v1/works/{id}/source-support',
  '/v2/works/{id}/source-supports',
  '/v2/works/{id}/source-supports/{binding}',
  '/v1/works/{id}/source-refresh-assessments/{candidateProposal}',
  '/v1/works/{id}/source-title-applications/{candidateProposal}',
] as const;
const sourceWrites = [
  '/v1/works/{id}/source-author-credits',
  '/v1/sources/author-credit-supports/{support}/withdrawals',
  '/v1/sources/intakes',
  '/v1/sources/acquisitions/open-library/works',
  '/v1/sources/observations/{observation}/conversions/open-library-work',
  '/v1/sources/conversions/{conversion}/source-graph',
  '/v1/sources/conversions/{conversion}/proposals/native-work',
  '/v1/sources/proposals/{proposal}/adoption/native-work',
  '/v1/sources/correspondences',
  '/v1/works/{id}/source-title-applications/{candidateProposal}',
  '/v1/works/{id}/source-support/withdrawal',
  '/v2/works/{id}/source-supports',
  '/v2/works/{id}/source-supports/{binding}/withdrawal',
] as const;
const packageReads = ['/v1/package-resolutions/{resolution}',
  '/v1/package-resolutions/cargo/{resolution}',
  '/v1/package-resolutions/npm/{resolution}',
  '/v1/package-sources/go/{capture}'] as const;
const packageWrites = ['/v1/package-resolutions',
  '/v1/package-resolutions/cargo',
  '/v1/package-resolutions/npm',
  '/v1/package-resolutions/from-captures', '/v1/package-sources/go'] as const;

interface Operation {
  parameters?: unknown[];
  security?: { bearerAuth: never[] }[];
  responses?: Record<string, { content?: Record<string, unknown> }>;
}
interface Document {
  openapi?: string;
  components?: Record<string, unknown>;
  paths?: Record<string, Record<string, Operation>>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

const schemaValues = new Set(['const', 'default', 'enum', 'example', 'examples']);

/** TypeBox emits draft-07 tuples (`items: [...]`, `additionalItems`); OpenAPI 3.1
 * schemas are JSON Schema 2020-12, which spells them `prefixItems` and `items`. */
export function jsonSchema2020Tuples(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonSchema2020Tuples);
  if (value === null || typeof value !== 'object') return value;
  const { items, additionalItems, ...rest } = value as Record<string, unknown>;
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(rest).map(([key, item]) =>
    [key, schemaValues.has(key) ? item : jsonSchema2020Tuples(item)]));
  if (Array.isArray(items)) {
    result.prefixItems = items.map(jsonSchema2020Tuples);
    if (additionalItems !== undefined) result.items = jsonSchema2020Tuples(additionalItems);
  } else {
    if (items !== undefined) result.items = jsonSchema2020Tuples(items);
    if (additionalItems !== undefined) result.additionalItems = jsonSchema2020Tuples(additionalItems);
  }
  return result;
}

/** Build the public contract from the live Elysia routes without starting services. */
export async function buildMainOpenApi(): Promise<string> {
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'),
    {} as MainWorkDependencies).use(openapi({
      documentation: { info: { title: 'REZICS Main Public API', version: '1.0.0' } },
      exclude: { paths: /^\/health\// },
    }));
  const response = await app.handle(new Request('http://localhost/openapi/json'));
  if (response.status !== 200) throw new Error('Main OpenAPI generator did not return a document');
  const document = await response.json() as Document;
  const paths = Object.entries(document.paths ?? {});
  if (!document.openapi?.startsWith('3.1.') || paths.length !== 139
    || paths.some(([path, methods]) => !/^\/v[12]\//.test(path)
      || Object.values(methods).some(operation => !operation.responses
        || (!operation.responses['200'] && !operation.responses['201']
          && !(path === '/v1/private-queries' && operation.responses['503']))))) {
    throw new Error('Main OpenAPI is missing an installed route or success response');
  }
  for (const path of commands) {
    const operation = document.paths?.[path]?.post;
    if (!operation) throw new Error(`Main command is missing from OpenAPI: ${path}`);
    operation.security = [{ bearerAuth: [] }];
    operation.parameters = [...(operation.parameters ?? []), {
      name: 'Idempotency-Key', in: 'header', required: true,
      schema: { type: 'string', minLength: 1, maxLength: 128,
        pattern: '^[A-Za-z0-9:_./-]{1,128}$' },
    }];
  }
  for (const path of privateReads) {
    const operation = document.paths?.[path]?.get;
    if (!operation) throw new Error(`Main private read is missing from OpenAPI: ${path}`);
    operation.security = [{ bearerAuth: [] }];
  }
  for (const path of privateChecks) {
    const operation = document.paths?.[path]?.post;
    if (!operation) throw new Error(`Main private check is missing from OpenAPI: ${path}`);
    operation.security = [{ bearerAuth: [] }];
  }
  for (const path of privateWrites) {
    const operation = document.paths?.[path]?.put;
    if (!operation) throw new Error(`Main private write is missing from OpenAPI: ${path}`);
    operation.security = [{ bearerAuth: [] }];
    operation.parameters = [...(operation.parameters ?? []), {
      name: 'Idempotency-Key', in: 'header', required: true,
      schema: { type: 'string', minLength: 1, maxLength: 128,
        pattern: '^[A-Za-z0-9:_./-]{1,128}$' },
    }];
  }
  for (const [pathsWithMethod, method] of [[sourceReads, 'get'],
    [sourceWrites, 'post'], [packageReads, 'get'], [packageWrites, 'post']] as const) {
    for (const path of pathsWithMethod) {
      const operation = document.paths?.[path]?.[method];
      if (!operation) throw new Error(`Main source operation is missing from OpenAPI: ${path}`);
      operation.security = [{ bearerAuth: [] }];
    }
  }
  for (const path of [...packageWrites, '/v2/works/{id}/source-supports',
    '/v1/works/{id}/source-author-credits', '/v1/sources/author-credit-supports/{support}/withdrawals',
    '/v2/works/{id}/source-supports/{binding}/withdrawal']) {
    const operation = document.paths?.[path]?.post;
    if (!operation) throw new Error(`Main package write is missing from OpenAPI: ${path}`);
    operation.parameters = [...(operation.parameters ?? []), {
      name: 'Idempotency-Key', in: 'header', required: true,
      schema: { type: 'string', minLength: 1, maxLength: 128,
        pattern: '^[A-Za-z0-9:_./-]{1,128}$' },
    }];
  }
  document.components = { ...document.components,
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } };
  for (const [, methods] of paths) for (const operation of Object.values(methods)) {
    for (const [status, result] of Object.entries(operation.responses ?? {})) {
      if (Number(status) < 400 || !result.content?.['application/json']) continue;
      result.content['application/problem+json'] = result.content['application/json'];
      delete result.content['application/json'];
    }
  }
  return `${JSON.stringify(canonical(jsonSchema2020Tuples(document)), null, 2)}\n`;
}

export async function generateMainOpenApi(root: string, check: boolean): Promise<void> {
  const expected = await buildMainOpenApi();
  const path = join(root, artifact);
  if (check) {
    let actual: string;
    try { actual = readFileSync(path, 'utf8'); }
    catch { throw new Error(`Missing generated artifact: ${artifact}`); }
    if (actual !== expected) throw new Error(`Generated artifact differs: ${artifact}; run yarn gen`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, expected);
  }
}
