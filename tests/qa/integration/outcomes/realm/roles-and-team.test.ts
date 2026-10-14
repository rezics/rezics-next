import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import team from '../../../../../scripts/qa/cases/outcomes/realm/roles-and-team.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(245_000);
const proofDeadlineMs = 120_000; // The original API outcome proof owns these 120 seconds.
const recordDeadlineMs = 120_000;
const fileWall = setTimeout(() => { throw new Error('Roles and team file exceeded 480 s'); }, 480_000);
async function within(part: string, milliseconds: number, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
let dialogBundle: string;
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(team);
let initialRole: string;
const root = () => `/v1/realms/${sessions.realm.slice(-36)}`;
const acting = (person: PersonaSession) =>
  `actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request,
    raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
type Role = {
  id: string;
  permissions: string[];
  holders: { member: string }[] | null;
  moreHolders: boolean | null;
};
type Roles = { generation: string; cap: number; roles: Role[] };
type TargetScope = { kind: 'concept'; id: string } | null;
type Impact = {
  digest: string;
  exact: true;
  affectedCount: number;
  generation: string;
  targetScope?: TargetScope;
  previousTargetScope?: TargetScope;
  changes: { member: string; gained: string[]; lost: string[];
    jurisdictions?: { targetScope: TargetScope; gained: string[]; lost: string[] }[] }[];
};
type Receipt = { receiptId: string; generation: string; replayed: boolean; impact: Impact };
type Change =
  | { kind: 'role'; roleId: string; name: string; permissions: string[] }
  | { kind: 'assignment'; roleId: string; member: string; assigned: boolean; validUntil: string };
const assignment = (roleId: string, member: string, assigned = true): Change => ({
  kind: 'assignment',
  roleId,
  member,
  assigned,
  validUntil: new Date(Date.now() + 3_600_000).toISOString(),
});
async function preview(change: Change, person = sessions.owner, label?: string) {
  const basis = await answer<Roles>(person.main('GET', `${root()}/roles?${acting(person)}`));
  const command = {
    actingSubject: person.actingSubject,
    expectedGeneration: basis.generation,
    reason: 'Review the exact effective Realm permissions',
    change,
  };
  const request = label ? recording.session('owner', person).bind(null, label) : person.main;
  const impact = await answer<Impact>(request('POST', `${root()}/role-impact`, command));
  expect(impact.exact).toBe(true);
  expect(impact.generation).toBe(command.expectedGeneration);
  expect(impact.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(impact.affectedCount).toBe(impact.changes.length);
  return { command: { ...command, impactDigest: impact.digest }, impact };
}
async function change(change: Change) {
  const intent = await preview(change);
  const receipt = await answer<Receipt>(
    sessions.owner.main('POST', `${root()}/role-changes`, intent.command),
    201,
  );
  expect(receipt.impact).toEqual(intent.impact);
  expect(receipt.generation).toBe((BigInt(intent.command.expectedGeneration) + 1n).toString());
  return intent;
}
beforeAll(async () => {
  dialogBundle = await buildDialog();
  sessions = await personaSessions('private');
  await recording.prepare();
  const roles = await answer<Roles>(sessions.owner.main('GET', `${root()}/roles?${acting(sessions.owner)}`));
  initialRole = roles.roles[0]!.id;
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { clearTimeout(fileWall); await sessions?.close(); }
});

async function renderRead(name: PersonaName, label: string, path: string, anonymous = false) {
  const response = await recording.session(name, anonymous ? sessions.visitor : sessions[name])(label, 'GET', path);
  const raw = await response.text();
  if (response.status >= 500) throw new Error(`${name} ${label}: GET ${path}: ${response.status}: ${raw}`);
  return { status: response.status, data: JSON.parse(raw) as { zone?: string; routeSegment?: string | null } };
}

async function frameSite(name: PersonaName, zoneLabel = 'frame-site', editor = true) {
  const person = sessions[name];
  const query = name === 'visitor' ? '' : `?${acting(person)}`;
  const zone = await renderRead(name, zoneLabel, `${root()}/zone${query}`);
  if (zone.status === 200 && zone.data.zone) {
    const zoneId = zone.data.zone.slice(-36);
    await Promise.all([
      renderRead(name, 'frame-site-presentation', `/v1/zones/${zoneId}/presentation${query}`),
      ...(editor && name !== 'visitor'
        ? [renderRead(name, 'frame-site-editor', `/v1/zones/${zoneId}/showcase-editor?${acting(person)}`)] : []),
    ]);
  }
}

async function pageSession(name: Exclude<PersonaName, 'visitor'>) {
  const person = sessions[name];
  await Promise.all([
    renderRead(name, 'session-agent', '/v1/me/session-agent'),
    renderRead(name, 'agent-choices', '/v1/me/agents?languages=en'),
    renderRead(name, 'acting-contexts', '/v1/me/acting-contexts?task=work.create'),
    renderRead(name, 'reading-preferences', `/v1/me/person-preferences?${acting(person)}`),
  ]);
  await renderRead(name, 'acting-agent-profile', `/v1/agents/${person.actingSubject!.slice(-36)}?${acting(person)}`);
}

async function refused(name: PersonaName) {
  const person = sessions[name],
    status = name === 'visitor' ? 401 : 403;
  const sample = recording.session(name, person);
  await Promise.all([
    answer(sample('roles-denied', 'GET', `${root()}/roles?${acting(person)}`), status),
    answer(sample('members-denied', 'GET', `${root()}/members?${acting(person)}`), status),
    answer(
      sample('realm-header', 'GET', name === 'visitor' ? root() : `${root()}?${acting(person)}`),
      ['member', 'moderator'].includes(name) ? 200 : 404,
    ),
    answer(
      sample('frame-realm', 'GET', `${root()}?${acting(person)}&language=en`),
      name === 'visitor' ? 401 : ['member', 'moderator'].includes(name) ? 200 : 404,
    ),
    answer(sample('members-invitations', 'GET', `${root()}/invitations?${acting(person)}`), status),
  ]);
  const command = {
    actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    expectedGeneration: '0',
    reason: 'Unauthorized role edit',
    change: {
      kind: 'role',
      roleId: randomUUID(),
      name: 'Unapproved managers',
      permissions: ['realm.roles.manage'],
    },
  };
  await answer(sample('role-impact-denied', 'POST', `${root()}/role-impact`, command), status);
  await answer(
    person.main('POST', `${root()}/role-changes`, { ...command, impactDigest: '0'.repeat(64) }),
    status,
  );
}

async function ownerProof() {
  const owner = sessions.owner,
    stranger = sessions.stranger,
    moderator = sessions.moderator;
  const sample = recording.session('owner', owner);
  await Promise.all([
    answer(sample('management-realm-header', 'GET', `${root()}?${acting(owner)}&language=en`)),
    answer(sample('roles-initial', 'GET', `${root()}/roles?${acting(owner)}`)),
    answer(sample('member-roster', 'GET', `${root()}/members?${acting(owner)}`)),
    answer(recording.session('owner', sessions.visitor)('member-profile', 'GET', `/v1/agents/${sessions.member.actingSubject!.slice(-36)}`)),
    answer(sample('member-search-empty', 'GET', `${root()}/members?${acting(owner)}&search=nomatch${randomUUID().replaceAll('-', '')}`)),
    answer(sample('outgoing-invitations-empty', 'GET', `${root()}/invitations?${acting(owner)}`)),
    answer(recording.session('owner', sessions.visitor)('holder-name-owner', 'GET', `/v1/agents/${owner.actingSubject!.slice(-36)}`)),
    answer(recording.session('owner', sessions.visitor)('holder-name-moderator', 'GET', `/v1/agents/${moderator.actingSubject!.slice(-36)}`)),
  ]);
  const roleId = randomUUID();
  const created = await change({
    kind: 'role',
    roleId,
    name: 'Delegated role managers',
    permissions: ['realm.roles.manage'],
  });
  expect(created.impact.changes).toEqual([]);
  await answer(sample('roles-unassigned', 'GET', `${root()}/roles?${acting(owner)}`));
  const intent = await preview(assignment(roleId, stranger.actingSubject!), owner, 'role-impact-preview'),
    key = randomUUID();
  expect(intent.impact.changes).toEqual([
    { member: stranger.actingSubject, gained: ['realm.roles.manage'], lost: [],
      jurisdictions: [{ targetScope: null, gained: ['realm.roles.manage'], lost: [] }] },
  ]);
  expect(intent.impact.targetScope).toBeNull();
  expect(intent.impact.previousTargetScope).toBeNull();
  await answer(owner.main('POST', `${root()}/role-changes`, {
    ...intent.command,
    impactDigest: (intent.impact.digest[0] === '0' ? '1' : '0') + intent.impact.digest.slice(1),
  }), 409);
  const receipt = await answer<Receipt>(
    sample('role-assignment-receipt', 'POST', `${root()}/role-changes`, intent.command, key),
    201,
  );
  expect(receipt.impact).toEqual(intent.impact);
  expect(receipt.generation).toBe((BigInt(intent.command.expectedGeneration) + 1n).toString());
  await answer(sample('roles-assigned', 'GET', `${root()}/roles?${acting(owner)}`));
  await answer(recording.session('owner', sessions.visitor)('holder-name-stranger', 'GET', `/v1/agents/${stranger.actingSubject!.slice(-36)}`));
  expect(
    await answer(owner.main('POST', `${root()}/role-changes`, intent.command, key)),
  ).toEqual({ ...receipt, replayed: true });
  await answer(
    sample(
      'role-intent-conflict', 'POST',
      `${root()}/role-changes`,
      { ...intent.command, reason: 'Different intent' },
      key,
    ),
    409,
  );
  await answer(owner.main('POST', `${root()}/role-impact`, intent.command), 400);
  const { impactDigest: _digest, ...stale } = intent.command;
  await answer(owner.main('POST', `${root()}/role-impact`, stale), 409);
  const roles = await answer<Roles>(stranger.main('GET', `${root()}/roles?${acting(stranger)}`));
  expect(roles.roles.length).toBeGreaterThan(0);
  for (const role of roles.roles) expect(role).toMatchObject({ holders: null, moreHolders: null });
  await answer(stranger.main('GET', `${root()}/members?${acting(stranger)}`), 403);
  await answer(stranger.main('GET', `${root()}?${acting(stranger)}`), 404);
  const roster = await answer<{
    items: { member: string; state: string; joinedAt: string | null; roles: { id: string }[] }[];
  }>(
    owner.main(
      'GET',
      `${root()}/members?${acting(owner)}&search=${encodeURIComponent(stranger.actingSubject!)}`,
    ),
  );
  expect(roster.items).toMatchObject([
    {
      member: stranger.actingSubject,
      state: 'not_joined',
      joinedAt: null,
      roles: [{ id: roleId }],
    },
  ]);
  const delegated = await preview(
    { kind: 'role', roleId: randomUUID(), name: 'Delegated empty role', permissions: [] },
    stranger,
  );
  await answer(stranger.main('POST', `${root()}/role-changes`, delegated.command), 201);
  await answer(sessions.operator.main('GET', `${root()}/roles?${acting(stranger)}`), 403);

  const independentRole = randomUUID();
  await change({
    kind: 'role',
    roleId: independentRole,
    name: 'Independent moderation assignment',
    permissions: ['governance.moderate'],
  });
  expect(
    (await change(assignment(independentRole, moderator.actingSubject!))).impact.changes,
  ).toEqual([]);
  expect(
    (await change(assignment(independentRole, moderator.actingSubject!, false))).impact.changes,
  ).toEqual([]);
  await answer(moderator.main('GET', `${root()}/moderation?${acting(moderator)}`));
  expect((await change(assignment(roleId, stranger.actingSubject!, false))).impact.changes).toEqual([
    { member: stranger.actingSubject, gained: [], lost: ['realm.roles.manage'],
      jurisdictions: [{ targetScope: null, gained: [], lost: ['realm.roles.manage'] }] },
  ]);
  await answer(stranger.main('GET', `${root()}/roles?${acting(stranger)}`), 403);

  const race = await preview({
    kind: 'role',
    roleId,
    name: 'Concurrent role edit',
    permissions: [],
  });
  const results = await Promise.all([
    owner.main('POST', `${root()}/role-changes`, race.command),
    owner.main('POST', `${root()}/role-changes`, race.command),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  const basis = await answer<Roles>(owner.main('GET', `${root()}/roles?${acting(owner)}`));
  for (let index = basis.roles.length; index < basis.cap; index++)
    await change({
      kind: 'role',
      roleId: randomUUID(),
      name: `Budget role ${index}`,
      permissions: [],
    });
  const full = await answer<Roles>(owner.main('GET', `${root()}/roles?${acting(owner)}`));
  expect(full.roles.length).toBe(full.cap);
  await answer(
    sample('role-budget-refused', 'POST', `${root()}/role-impact`, {
      actingSubject: owner.actingSubject,
      expectedGeneration: full.generation,
      reason: 'Check the declared role budget',
      change: { kind: 'role', roleId: randomUUID(), name: 'Overflow role', permissions: [] },
    }),
    422,
  );
  expect(
    (await answer<Roles>(owner.main('GET', `${root()}/roles?${acting(owner)}`))).generation,
  ).toBe(full.generation);
}
async function moderatorProof() {
  await refused('moderator');
  await answer(
    sessions.moderator.main('GET', `${root()}/moderation?${acting(sessions.moderator)}`),
  );
}
async function operatorProof() {
  expect(await answer(recording.session('operator', sessions.operator)('platform-access', 'GET', '/v1/me/platform-access'))).toMatchObject({
    groups: ['platform-admin'],
  });
  await refused('operator');
  await answer(sessions.operator.main('GET', `${root()}/roles?${acting(sessions.owner)}`), 403);
}

// Bundle the real browser hook and adapter: only the HTTP boundary is injected.
async function buildDialog() {
  const directory = resolve('.temp/role-dialog');
  mkdirSync(directory, { recursive: true });
  const entry = resolve(directory, 'entry.ts');
  writeFileSync(entry, `
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { bffAdminApi, useRoleChange } from '../../apps/web/features/manage/admin-api.ts';
import { roleDurations } from '../../apps/web/features/manage/members-view.tsx';
const input = window.dialogInput;
window.fetch = async (url, init = {}) => {
  const result = await window.requestMain(String(url), init.method ?? 'GET', init.body,
    new Headers(init.headers).get('idempotency-key'));
  return new Response(result.body, { status: result.status, headers: result.headers });
};
const api = bffAdminApi(input.realm, input.actingSubject);
function Dialog() {
  const [openedAt] = useState(() => Math.max(input.now, Date.now()));
  const days = roleDurations.find(([, days]) => days === 30)[1];
  const change = { kind: 'assignment', roleId: input.roleId, member: input.member,
    assigned: true, validUntil: new Date(openedAt + days * 86400000).toISOString() };
  const result = useRoleChange(api, { ...input, change });
  window.dialog = { ...result, openedAt, api };
  return null;
}
window.startDialog = async () => {
  const [roles, roster] = await Promise.all([api.roles(), api.members('', null)]);
  if (!roles.ok || !roster.ok) throw new Error('Dialog basis could not be read');
  const target = roster.data.items.find(item => item.member === input.member);
  const held = new Set(target.roles.map(role => role.id));
  const choices = roles.data.roles.filter(role => !held.has(role.id));
  const role = choices.find(role => role.permissions.includes('governance.moderate'));
  if (!role) throw new Error('Joined member has no moderation role choice');
  input.roleId = role.id;
  input.generation = roles.data.generation;
  createRoot(document.getElementById('role-dialog-root')).render(createElement(Dialog));
};
`);
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', minify: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': '{}' } });
  if (!result.success) throw new AggregateError(result.logs, 'Role dialog bundle failed');
  return result.outputs[0]!.text();
}

async function dialogSave() {
  const person = sessions.owner;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({
      contentType: 'text/html', body: '<div id="role-dialog-root"></div>',
    }));
    await page.goto('http://localhost');
    const sample = recording.session('owner', person);
    let saving = false;
    await page.exposeFunction('requestMain', async (url: string, method: string, raw?: string, key?: string) => {
      const request = new URL(url);
      const path = request.pathname.replace('/api/main', '') + request.search;
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      // This preview's validUntil minus the selected 30 days is the exact openedAt
      // clock. Its own label preserves that instant without inventing an API answer.
      const label = path.endsWith('/role-impact')
        ? saving ? 'dialog-role-save-preview' : 'role-dialog-opened-at'
        : path.endsWith('/role-changes') ? 'dialog-role-assignment-receipt'
        : path.includes('/agents/') ? 'dialog-impact-member-name'
        : path.split('?')[0]!.endsWith('/members') ? saving ? 'dialog-members-assigned' : 'dialog-member-roster'
        : saving ? 'dialog-roles-assigned' : 'dialog-roles';
      const response = await sample(label, method, path, body, key ?? undefined);
      return { status: response.status, body: await response.text(),
        headers: Object.fromEntries(response.headers.entries()) };
    });
    await page.evaluate(input => { Object.assign(window, { dialogInput: input }); }, {
      principal: person.accountId!, realm: sessions.realm.slice(-36), actingSubject: person.actingSubject!,
      member: sessions.member.actingSubject!, now: Date.now(),
    });
    const browserErrors: string[] = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.addScriptTag({ content: dialogBundle });
    await page.evaluate(() => (window as unknown as { startDialog(): Promise<void> }).startDialog());
    await page.waitForFunction(() => (window as unknown as { dialog: { state: { kind: string }; names: Record<string, unknown> } }).dialog?.state?.kind === 'ready'
      && Object.keys((window as unknown as { dialog: { names: Record<string, unknown> } }).dialog.names).length > 0)
      .catch(async error => {
        const state = await page.evaluate(() => (window as unknown as { dialog?: { state: unknown } }).dialog?.state);
        throw new Error(`Dialog preview failed: ${JSON.stringify({ state, browserErrors })}`, { cause: error });
      });
    saving = true;
    const saved = await page.evaluate(async () => {
      const dialog = (window as unknown as { dialog: { save(reason: string): Promise<{ ok: boolean }>;
        api: { roles(): Promise<unknown>; members(search: string, after: null): Promise<unknown> } } }).dialog;
      const result = await dialog.save('Give the joined member the moderation role');
      if (!result.ok) throw new Error(`Production role Save failed: ${JSON.stringify(result)}`);
      await Promise.all([dialog.api.roles(), dialog.api.members('', null)]);
      return result;
    });
    if (!saved.ok) throw new Error('Production role Save did not confirm');
  } finally { await browser.close(); }
}

async function recordPage(name: PersonaName) {
  const person = sessions[name];
  if (name !== 'visitor') await pageSession(name);
  await Promise.all([
    frameSite(name, name === 'owner' ? 'management-site' : 'frame-site', name !== 'owner'),
    renderRead(name, 'official-address', `/v1/addresses/resolve?scope=space&key=${sessions.realm.slice(-36)}`, true),
    ...(name !== 'visitor' ? [renderRead(name, 'members-role-filter', `${root()}/members?${acting(person)}&role=${initialRole}`)] : []),
    ...(name === 'owner' ? [
      renderRead(name, 'site-editor-access', `/v1/zones/${sessions.zone.slice(-36)}/showcase-editor?${acting(person)}`),
      renderRead(name, 'roster-name-moderator', `/v1/agents/${sessions.moderator.actingSubject!.slice(-36)}`, true),
    ] : []),
    ...(name === 'visitor' ? [renderRead(name, 'frame-site-acting', `${root()}/zone?${acting(person)}`)] : []),
  ]);
  if (name === 'owner') await dialogSave();
}
async function proveAndRecord(name: PersonaName, proof: () => Promise<void>) {
  const start = performance.now();
  let proofElapsed = 0;
  const recordStart = { value: start };
  try {
    await within('proof', proofDeadlineMs, proof);
    proofElapsed = performance.now() - start;
    recordStart.value = performance.now();
    await within('record', recordDeadlineMs, () => recordPage(name));
  } finally {
    console.info(`[roles-and-team] ${name} proof=${Math.round(proofElapsed || performance.now() - start)}ms record=${Math.round(proofElapsed ? performance.now() - recordStart.value : 0)}ms`);
  }
}
outcomeTest(team, 'visitor', () => proveAndRecord('visitor', () => refused('visitor')), recording);
outcomeTest(team, 'stranger', () => proveAndRecord('stranger', () => refused('stranger')), recording);
outcomeTest(team, 'member', () => proveAndRecord('member', () => refused('member')), recording);
outcomeTest(team, 'owner', () => proveAndRecord('owner', ownerProof), recording);
outcomeTest(team, 'moderator', () => proveAndRecord('moderator', moderatorProof), recording);
outcomeTest(team, 'operator', () => proveAndRecord('operator', operatorProof), recording);
