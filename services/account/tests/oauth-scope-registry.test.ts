import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentRegistrationScopes } from '../src/auth.ts';
import { thirdPartyConsentDecision } from '../src/consent.ts';
import { closedGroupScopes, consentScopes, discoverOAuthScopeRegistry, providerScopes } from '../src/oauth-scopes.ts';
import * as commerce from '../src/oauth-scopes/commerce.ts';
import * as connectedApps from '../src/oauth-scopes/connected-apps.ts';
import * as event from '../src/oauth-scopes/event.ts';
import * as packages from '../src/oauth-scopes/package.ts';
import * as theme from '../src/oauth-scopes/theme.ts';
import * as types from '../src/oauth-scopes/types.ts';
import * as verification from '../src/oauth-scopes/verification.ts';
import * as vote from '../src/oauth-scopes/vote.ts';
import * as wiki from '../src/oauth-scopes/wiki.ts';

const scopePattern = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const mainSource = join(import.meta.dir, '../../main/src');

function stripComments(source: string) {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'quote' = 'code';
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const current = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (current === '/' && next === '/') { mode = 'line'; i++; continue; }
      if (current === '/' && next === '*') { mode = 'block'; i++; continue; }
      if (current === "'" || current === '"' || current === '`') { mode = 'quote'; quote = current; }
      out += current;
      continue;
    }
    if (mode === 'line') { if (current === '\n') { mode = 'code'; out += current; } continue; }
    if (mode === 'block') { if (current === '*' && next === '/') { mode = 'code'; i++; } continue; }
    out += current;
    if (current === '\\') { out += source[i + 1] ?? ''; i++; continue; }
    if (current === quote) mode = 'code';
  }
  return out;
}

function matching(source: string, start: number, open: string, close: string) {
  if (source[start] !== open) return undefined;
  let depth = 0;
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const current = source[i]!;
    if (quote) {
      if (current === '\\') { i++; continue; }
      if (current === quote) quote = '';
      continue;
    }
    if (current === "'" || current === '"' || current === '`') { quote = current; continue; }
    if (current === open) depth++;
    else if (current === close && --depth === 0) return source.slice(start + 1, i);
  }
  return undefined;
}

function splitTop(source: string) {
  const parts: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const current = source[i]!;
    if (quote) {
      if (current === '\\') { i++; continue; }
      if (current === quote) quote = '';
      continue;
    }
    if (current === "'" || current === '"' || current === '`') { quote = current; continue; }
    if (current === '(') round++;
    else if (current === ')') round--;
    else if (current === '[') square++;
    else if (current === ']') square--;
    else if (current === '{') curly++;
    else if (current === '}') curly--;
    else if (current === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** Scopes Main asks Account to verify, including constants, principal checks,
 * admission fields and MCP tool scopes. Access scope-gate ids are not included. */
function declaredMainScopes() {
  const constants = new Map<string, string[]>();
  const sources = walk(mainSource).map(path => stripComments(readFileSync(path, 'utf8')));
  for (const source of sources) {
    for (const match of source.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*/g)) {
      const name = match[1]!;
      const at = match.index! + match[0].length;
      const head = source[at];
      let scopes: string[] = [];
      if (head === "'") {
        const literal = source.slice(at).match(/^'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'/);
        if (literal) scopes = [literal[1]!];
      } else if (head === '[' || head === '{') {
        const body = matching(source, at, head, head === '[' ? ']' : '}');
        scopes = body ? [...body.matchAll(/'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'/g)].map(item => item[1]!) : [];
      }
      if (scopes.length) constants.set(name, [...new Set([...(constants.get(name) ?? []), ...scopes])]);
    }
  }
  const found = new Set<string>();
  const add = (scope: string) => { if (scopePattern.test(scope)) found.add(scope); };
  const absorb = (text: string) => {
    for (const literal of text.matchAll(/'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'/g)) add(literal[1]!);
    for (const identifier of text.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
      for (const scope of constants.get(identifier[1]!) ?? []) add(scope);
    }
  };
  for (const source of sources) {
    for (const needle of ['.verify(', 'principal(']) {
      let from = 0;
      while (from < source.length) {
        const at = source.indexOf(needle, from);
        if (at < 0) break;
        const args = matching(source, at + needle.length - 1, '(', ')');
        from = at + needle.length;
        const second = args ? splitTop(args)[1] : undefined;
        if (!second) continue;
        const trimmed = second.trim();
        const bracket = trimmed.indexOf('[');
        absorb(bracket === 0 ? matching(trimmed, bracket, '[', ']') ?? trimmed : trimmed);
      }
    }
    for (const match of source.matchAll(/\b(?:oauthScope|accountScope|editPermission|targetReadPermission)\b([^\n;{}]*)/g)) {
      absorb(match[1]!);
    }
    for (const match of source.matchAll(/\bscopes\s*:\s*\[([\s\S]*?)\]/g)) absorb(match[1]!);
  }
  return found;
}

test('every Main account scope is registered', () => {
  const missing = [...declaredMainScopes()].filter(scope => !providerScopes.includes(scope)).sort();
  expect(missing).toEqual([]);
  expect(providerScopes).toContain('quota:reserve');
  expect(providerScopes).toContain('type:admit');
  expect(providerScopes).toContain('wiki:propose');
});

test('closed-group scopes stay off third-party consent and dynamic registration', () => {
  const requested = ['openid', 'type:admit', 'wiki:propose', 'work:read'];
  expect(consentScopes(requested, false)).toEqual(['openid', 'work:read']);
  expect(consentScopes(['type:admit'], false)).toEqual([]);
  expect(consentScopes(requested, true)).toBe(requested);
  for (const scope of consentScopes([...closedGroupScopes, 'openid', 'work:read'], false)) {
    expect(closedGroupScopes).not.toContain(scope);
  }
  const registration = agentRegistrationScopes();
  for (const scope of closedGroupScopes) expect(registration).not.toContain(scope);
  expect(thirdPartyConsentDecision({ accept: true, oauth_query: 'signed' }, ['openid', 'work:read'], true))
    .toEqual({ accept: true, oauth_query: 'signed', scope: 'openid work:read' });
  expect(thirdPartyConsentDecision({ accept: true, oauth_query: 'signed' }, [], true))
    .toEqual({ accept: false, oauth_query: 'signed' });
  const named = { accept: true, oauth_query: 'signed', scope: 'openid' };
  expect(thirdPartyConsentDecision(named, ['openid'], true)).toBe(named);
  const firstParty = { accept: true, oauth_query: 'signed' };
  expect(thirdPartyConsentDecision(firstParty, ['type:admit'], false)).toBe(firstParty);
  expect(thirdPartyConsentDecision({ accept: false, oauth_query: 'signed' }, ['openid'], true).accept).toBe(false);
});

test('closed-group marks follow families whose operations sit only in closed platform groups', () => {
  for (const module of [commerce, event, packages, theme, types, verification, connectedApps, vote]) {
    expect([...module.closedGroupScopes]).toEqual([...module.oauthScopes]);
  }
  expect([...wiki.closedGroupScopes]).toEqual(['wiki:propose']);
  for (const scope of ['package:capture', 'package:resolve', 'package:verify', 'package:read',
    'source:intake', 'source:acquire', 'source:convert', 'source:propose', 'source:correspond',
    'subscription:manage', 'quota:reserve', 'event:submit', 'event:read', 'theme:approve', 'theme:read',
    'vote:manage', 'claim:create', 'connected-app:observe']) {
    expect(closedGroupScopes).toContain(scope);
  }
  for (const scope of ['source:read', 'source:adopt', 'zone:edit', 'work:read', 'statement:decide', 'owner:operate']) {
    expect(closedGroupScopes).not.toContain(scope);
  }
});

test('a closed-group mark must name a scope declared in the same file', async () => {
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(join('.temp', 'oauth-scopes-'));
  try {
    await writeFile(join(directory, 'synthetic.ts'),
      "export const oauthScopes = ['synthetic:read'] as const;\nexport const closedGroupScopes = ['synthetic:write'];\n");
    await expect(discoverOAuthScopeRegistry(directory)).rejects.toThrow(/not declared in synthetic\.ts/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
