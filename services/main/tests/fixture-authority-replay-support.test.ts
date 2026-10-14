import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import ts from 'typescript-6';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { directWorkCreateProof } from '../src/modules/access/direct-principal.ts';
import { AccessPolicyChanges } from '../src/modules/access/policy-changes.ts';
import { ensureFixtureScopeGate, expireFixtureAuthority, FixtureAuthorityDenied,
  grantFixtureAgentAttribution, grantFixtureAuthority, grantFixturePrincipalAuthority,
  reduceFixtureGrant, registerFixtureIdentity, type FixturePrincipalAuthorityInput } from '../src/modules/access/fixture-authority.ts';

const root = resolve(import.meta.dir, '../../..');
let cluster: PostgresCluster;
let pool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}, 120_000);
afterAll(async () => { await pool?.end(); cluster?.remove(); });

async function identity(scope = `fixture:direct:${randomUUID()}`) {
  const input: FixturePrincipalAuthorityInput = { principalId: randomUUID(),
    actor: `https://rezics.com/id/${randomUUID()}`, scope, action: 'work.create',
    lifetime: '8 hours', requireDispatch: true };
  const principal = { issuer: 'https://account.rezics.test', subject: randomUUID() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await registerFixtureIdentity(client, { ...input, ...principal });
    await ensureFixtureScopeGate(client, scope);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { input, principal };
}
const builders = [
  { name: 'direct principal grant', build: grantFixturePrincipalAuthority },
  { name: 'Agent attribution', build: grantFixtureAgentAttribution },
];
for (const builder of builders) for (const fence of ['recovery', 'gate', 'policy'] as const) {
  test(`${builder.name} refuses a closed ${fence} boundary before writing authority`, async () => {
    const { input, principal } = await identity();
    if (fence === 'policy') {
      await grantFixtureAuthority(pool, { scope: input.scope, requireDispatch: true,
        representations: [{ principalId: input.principalId, actor: input.actor,
          action: 'access.policy.manage', lifetime: '8 hours' }],
        grant: { actor: input.actor, action: 'access.policy.manage', lifetime: '8 hours' } });
      await new AccessPolicyChanges(pool).change({ principal, issuerSubject: input.actor,
        expectedAuthorityEpoch: '0', idempotencyKey: randomUUID(),
        requestDigest: createHash('sha256').update(randomUUID()).digest('hex') }, {
        action: 'publish-revision', policyId: randomUUID(), scopeId: input.scope,
        expectedHeadRevision: '0', mandatory: [], ordered: [{ ruleId: randomUUID(),
          actions: ['work.create'], effect: 'allow', condition: { op: 'authenticated' } }],
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (fence === 'recovery') await client.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
      if (fence === 'gate') await ensureFixtureScopeGate(client, input.scope, { open: false });
      let refused: unknown;
      try { await builder.build(client, input); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(FixtureAuthorityDenied);
      expect((refused as FixtureAuthorityDenied).kind).toBe(fence);
      for (const table of ['principal_permission_grant', 'principal_agent_attribution']) {
        expect((await client.query(`SELECT id FROM access.${table} WHERE principal_id = $1`,
          [input.principalId])).rows).toEqual([]);
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
}

test('direct fixture rows are reusable, independent, and only reduced through the fixture boundary', async () => {
  const { input } = await identity('work:create:root');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = (await client.query('SELECT to_jsonb(a) AS row FROM access.admission a ORDER BY id')).rows;
    const grant = await grantFixturePrincipalAuthority(client, input);
    expect(await directWorkCreateProof(client, input.principalId, input.actor)).toBeNull();
    const attribution = await grantFixtureAgentAttribution(client, input);
    expect(await grantFixturePrincipalAuthority(client, input)).toBe(grant);
    expect(await grantFixtureAgentAttribution(client, input)).toBe(attribution);
    expect(await directWorkCreateProof(client, input.principalId, input.actor)).toMatchObject({
      grantId: grant, attributionId: attribution,
    });
    await reduceFixtureGrant(client, grant, { active: false });
    expect(await directWorkCreateProof(client, input.principalId, input.actor)).toBeNull();
    const replacement = await grantFixturePrincipalAuthority(client, input);
    expect(replacement).not.toBe(grant);
    await reduceFixtureGrant(client, replacement, { validUntil: new Date(Date.now() - 1000) });
    expect(await directWorkCreateProof(client, input.principalId, input.actor)).toBeNull();
    await grantFixturePrincipalAuthority(client, input);
    await expireFixtureAuthority(client, input.actor);
    expect(await directWorkCreateProof(client, input.principalId, input.actor)).toBeNull();
    expect((await client.query(`SELECT id FROM access.principal_agent_attribution
      WHERE id = $1 AND valid_until > clock_timestamp()`, [attribution])).rows).toEqual([]);
    expect((await client.query('SELECT to_jsonb(a) AS row FROM access.admission a ORDER BY id')).rows).toEqual(before);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('direct fixture setup is unavailable to served routes and production modules', () => {
  const violations: string[] = [];
  const names = new Set(['grantFixturePrincipalAuthority', 'grantFixtureAgentAttribution']);
  for (const file of new Bun.Glob('services/main/src/**/*.ts').scanSync({ cwd: root })) {
    if (file.endsWith('/fixture-authority.ts')) continue;
    const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && names.has(node.text)) violations.push(file);
      // Namespace or dynamic fixture imports would expose every setup function.
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /\/fixture-authority(?:\.ts)?$/.test(node.moduleSpecifier.text)
        && (!node.importClause?.namedBindings || ts.isNamespaceImport(node.importClause.namedBindings))) violations.push(file);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && /\/fixture-authority(?:\.ts)?$/.test(node.moduleSpecifier.text) && !node.exportClause) violations.push(file);
      if (ts.isCallExpression(node) && node.arguments.some(argument => ts.isStringLiteral(argument)
        && /\/fixture-authority(?:\.ts)?$/.test(argument.text))) violations.push(file);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
