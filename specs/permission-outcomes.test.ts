import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Facts, Grant, Login, Operation, PermissionDriver, Session } from './permission-driver';

setDefaultTimeout(30_000);
// Run product acceptance with PERMISSION_DRIVER_MODULE=/absolute/driver.ts bun test <this file>.
const missingDriver = 'PERMISSION_DRIVER_MODULE is required: bind a real product permission driver';
const start = '2030-01-01T00:00:00.000Z';
const now = '2030-01-01T00:00:01.000Z';
const end = '2030-01-01T00:00:02.000Z';
const valid = { start, end };
const operation: Operation = { kind: 'resource', resourceId: 'document', action: 'read' };
const login: Login = { actorId: 'agent', clientId: 'third-party', scopes: ['read'], requestedBy: 'assignment' };
const directLogin: Login = { actorId: 'agent', clientId: 'third-party', scopes: ['read'] };
const grant = (id: string, accountId: string): Grant => ({
  id,
  subject: { accountId },
  resourceId: 'document',
  actions: ['read'],
  effect: 'allow',
  valid,
});

function fixture(): Facts {
  return {
    accounts: ['agent', 'principal', 'other'].map((id) => ({
      id,
      kind: 'actor',
      state: 'active',
      minimumAuthnEpoch: 1,
      ...(id === 'agent' ? { operatorId: 'principal' } : {}),
    })),
    resources: ['document', 'other-document'],
    clients: [
      { id: 'third-party', party: 'third' },
      { id: 'first-party', party: 'first' },
    ],
    consents: [{ actorId: 'agent', clientId: 'third-party', scopes: ['read'] }],
    grants: [grant('actor-grant', 'agent'), grant('principal-grant', 'principal')],
    memberships: [],
    delegatedRequests: [{ id: 'assignment', createdBy: 'principal', assignedTo: 'agent' }],
  };
}

let driver: PermissionDriver | undefined;
let facts: Facts;
let session: Session;
const product = () => {
  if (!driver) throw new Error('Permission driver was not initialized');
  return driver;
};
async function authenticate(input: Login = login): Promise<Session> {
  const result = await product().authenticate(input);
  expect(result.outcome).toBe('authenticated');
  if (result.outcome !== 'authenticated') throw new Error('Positive authentication control failed');
  return result.session;
}
async function attempt(input: Login, op: Operation = operation, claims?: Partial<Login>) {
  const result = await product().authenticate(input);
  return result.outcome === 'denied' ? 'denied' : product().execute(result.session, op, claims);
}
async function replace(change: (facts: Facts) => void) {
  change(facts);
  await product().replaceFacts(facts);
}
async function denies(change: (facts: Facts) => void) {
  await replace(change);
  expect(await product().execute(session, operation)).toBe('denied');
}

async function initialize() {
  const module = process.env.PERMISSION_DRIVER_MODULE;
  if (!module) throw new Error(missingDriver);
  if (!isAbsolute(module) && !module.startsWith('file:')) {
    throw new Error('PERMISSION_DRIVER_MODULE must be an absolute path or file URL');
  }
  const binding = await import(isAbsolute(module) ? pathToFileURL(module).href : new URL(module).href);
  if (typeof binding.createPermissionDriver !== 'function') {
    throw new Error('Permission driver must export createPermissionDriver');
  }
  driver = await binding.createPermissionDriver();
  facts = fixture();
  await product().setAuthoritativeTime(now);
  await product().replaceFacts(facts);
  session = await authenticate();
  // Every independent denial first proves the same fixture can execute the action.
  expect(await product().execute(session, operation)).toBe('permitted');
}
beforeEach(initialize, 30_000);

afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
}, 30_000);

test('actor grant AND consented scope AND principal grant permit the same action and resource', async () => {
  expect(await product().execute(session, operation)).toBe('permitted');
});
test('revoking only the actor grant denies', async () => {
  await denies((f) => {
    f.grants = f.grants.filter((g) => g.id !== 'actor-grant');
  });
});
test('revoking only client consent denies an already authenticated request', async () => {
  await denies((f) => {
    f.consents = [];
  });
});
test('revoking only the principal grant denies', async () => {
  await denies((f) => {
    f.grants = f.grants.filter((g) => g.id !== 'principal-grant');
  });
});
test('an actor grant for a different actor does not match', async () => {
  await denies((f) => {
    f.grants[0]!.subject = { accountId: 'other' };
  });
});
test('an actor grant for a different resource does not match', async () => {
  await denies((f) => {
    f.grants[0]!.resourceId = 'other-document';
  });
});
test('a principal grant for a different actor does not match', async () => {
  await denies((f) => {
    f.grants[1]!.subject = { accountId: 'other' };
  });
});
test('a principal grant for a different resource does not match', async () => {
  await denies((f) => {
    f.grants[1]!.resourceId = 'other-document';
  });
});
test('a different actor grant action does not match', async () => {
  await denies((f) => {
    f.grants[0]!.actions = ['write'];
  });
});
test('a different principal grant action does not match', async () => {
  await denies((f) => {
    f.grants[1]!.actions = ['write'];
  });
});
test('a different consented scope does not match', async () => {
  await denies((f) => {
    f.consents[0]!.scopes = ['write'];
  });
});
test('consent for another actor or client does not match', async () => {
  for (const field of ['actorId', 'clientId'] as const) {
    facts = fixture();
    await product().replaceFacts(facts);
    expect(await product().execute(session, operation)).toBe('permitted');
    facts.consents[0]![field] = field === 'actorId' ? 'other' : 'first-party';
    await product().replaceFacts(facts);
    expect(await product().execute(session, operation)).toBe('denied');
  }
});
test('without a principal actor grants and consent suffice', async () => {
  for (const operand of ['grant', 'consent']) {
    facts = fixture();
    await replace((f) => {
      f.grants = [grant('actor-grant', 'agent')];
      f.delegatedRequests = [];
    });
    const direct = await authenticate(directLogin);
    expect(await product().execute(direct, operation)).toBe('permitted');
    await replace((f) => {
      if (operand === 'grant') f.grants = [];
      else f.consents = [];
    });
    expect(await product().execute(direct, operation)).toBe('denied');
  }
});
test('operator rights never automatically grant agent rights', async () => {
  const direct = await authenticate(directLogin);
  expect(await product().execute(direct, operation)).toBe('permitted');
  await replace((f) => {
    f.grants = [grant('operator-grant', 'principal')];
  });
  expect(await product().execute(direct, operation)).toBe('denied');
});
test('unknown actions fail closed', async () => {
  // Supply all three operands so a missing allow cannot mask an open action registry.
  await replace((f) => {
    for (const g of f.grants) g.actions.push('unknown:action');
    f.consents[0]!.scopes.push('unknown:action');
  });
  expect(await product().execute(session, operation)).toBe('permitted');
  // Auth may reject the unregistered scope, or execution must reject the action.
  expect(
    await attempt({ ...login, scopes: ['read', 'unknown:action'] }, { ...operation, action: 'unknown:action' }),
  ).toBe('denied');
});
test('missing authoritative evidence fails closed', async () => {
  await evidenceDenies('missing');
});
test('unresolved authoritative evidence fails closed', async () => {
  await evidenceDenies('unavailable');
});
async function evidenceDenies(failure: 'missing' | 'unavailable') {
  // Each source gets a fresh positive control, without relying on earlier failures.
  for (const source of [
    'accounts',
    'resources',
    'clients',
    'grants',
    'consents',
    'delegatedRequests',
    'memberships',
  ] as const) {
    if (source !== 'accounts') {
      await product().close();
      driver = undefined;
      await initialize();
    }
    if (source === 'memberships') await organizationGrant();
    expect(await product().execute(session, operation)).toBe('permitted');
    await product().failEvidence(source, failure);
    expect(await product().execute(session, operation)).toBe('denied');
  }
}
test('suspended and deleted actors fail closed', async () => {
  for (const state of ['suspended', 'deleted'] as const) {
    facts = fixture();
    await product().replaceFacts(facts);
    expect(await product().execute(session, operation)).toBe('permitted');
    await denies((f) => {
      f.accounts[0]!.state = state;
    });
  }
});
test('raising minimum authn_epoch rejects the stale session', async () => {
  await denies((f) => {
    f.accounts[0]!.minimumAuthnEpoch = 2;
  });
});
test('active explicit denies override each account grant', async () => {
  for (const account of ['agent', 'principal']) {
    facts = fixture();
    await product().replaceFacts(facts);
    expect(await product().execute(session, operation)).toBe('permitted');
    await denies((f) => {
      f.grants.push({ ...grant('explicit-deny', account), effect: 'deny' });
    });
  }
});
test('first-party preconsent supplies no resource grant', async () => {
  const first = await authenticate({ ...login, clientId: 'first-party' });
  expect(await product().execute(first, operation)).toBe('permitted');
  await replace((f) => {
    f.grants = f.grants.filter((g) => g.id !== 'actor-grant');
  });
  expect(await product().execute(first, operation)).toBe('denied');
});
test('requested_by must reference a request created by that principal', async () => {
  await replace((f) => {
    f.delegatedRequests[0]!.createdBy = 'other';
  });
  expect(await attempt(login)).toBe('denied');
  expect(await product().execute(session, operation)).toBe('denied');
});
test('an actor cannot self-assert a principal instead of a request reference', async () => {
  expect(await attempt({ ...login, requestedBy: 'principal' })).toBe('denied');
});
test('an actor cannot use a request assigned to another actor', async () => {
  await replace((f) => {
    f.delegatedRequests[0]!.assignedTo = 'other';
  });
  expect(await attempt(login)).toBe('denied');
});
test('untrusted identity client principal and scope cannot expand authenticated authority', async () => {
  for (const claims of [
    { actorId: 'principal' },
    { clientId: 'first-party' },
    { scopes: ['read'] },
    { requestedBy: 'assignment' },
  ]) {
    facts = fixture();
    await product().replaceFacts(facts);
    expect(await product().execute(session, operation)).toBe('permitted');
    let target = session;
    if ('actorId' in claims) {
      target = await authenticate(directLogin);
      expect(await product().execute(target, operation)).toBe('permitted');
    }
    // Give the asserted identity/client/scope a path to read, but not the real request.
    if ('actorId' in claims) {
      facts.grants = [grant('principal-grant', 'principal')];
      facts.consents.push({ actorId: 'principal', clientId: 'third-party', scopes: ['read'] });
    }
    if ('clientId' in claims) facts.consents = [];
    if ('scopes' in claims) {
      facts.consents[0]!.scopes = ['read', 'write'];
      for (const grant of facts.grants) grant.actions = ['read', 'write'];
    }
    if ('requestedBy' in claims) {
      facts.delegatedRequests.push({ id: 'other-assignment', createdBy: 'other', assignedTo: 'agent' });
      facts.grants.push(grant('other-principal-grant', 'other'));
    }
    await product().replaceFacts(facts);
    if ('scopes' in claims) {
      target = await authenticate({ ...login, scopes: ['write'] });
      expect(await product().execute(target, { ...operation, action: 'write' })).toBe('permitted');
      // Both accounts and current consent allow read; only the issued scope excludes it.
      expect(await product().execute(target, operation)).toBe('denied');
    }
    if ('requestedBy' in claims) {
      target = await authenticate({ ...login, requestedBy: 'other-assignment' });
      expect(await product().execute(target, operation)).toBe('permitted');
      await replace((f) => {
        f.grants = f.grants.filter((g) => g.id !== 'other-principal-grant');
      });
    }
    expect(await product().execute(target, operation, claims)).toBe('denied');
  }
});
test('each grant starts inclusively and expires at the exact authoritative end', async () => {
  for (const index of [0, 1]) {
    facts = fixture();
    facts.grants[1 - index]!.valid = { start: '2029-01-01T00:00:00.000Z', end: '2031-01-01T00:00:00.000Z' };
    await product().replaceFacts(facts);
    for (const [instant, expected] of [
      [now, 'permitted'],
      [start, 'permitted'],
      ['2029-12-31T23:59:59.999Z', 'denied'],
      [end, 'denied'],
      ['2030-01-01T00:00:02.001Z', 'denied'],
    ] as const) {
      await product().setAuthoritativeTime(instant);
      expect(await product().execute(session, operation)).toBe(expected);
    }
    await product().setAuthoritativeTime(now);
  }
});
test('future and expired denies do not block but an active deny does', async () => {
  for (const account of ['agent', 'principal']) {
    facts = fixture();
    await replace((f) => {
      for (const g of f.grants) g.valid = { start: '2029-01-01T00:00:00.000Z', end: '2031-01-01T00:00:00.000Z' };
      f.grants.push({ ...grant('temporary-deny', account), effect: 'deny' });
    });
    for (const [instant, expected] of [
      ['2029-12-31T23:59:59.999Z', 'permitted'],
      [start, 'denied'],
      [now, 'denied'],
      [end, 'permitted'],
      ['2030-01-01T00:00:02.001Z', 'permitted'],
    ] as const) {
      await product().setAuthoritativeTime(instant);
      expect(await product().execute(session, operation)).toBe(expected);
    }
  }
});

async function organizationGrant() {
  facts = fixture();
  facts.accounts.push({ id: 'organization', kind: 'organization', state: 'active', minimumAuthnEpoch: 1 });
  facts.accounts.push({ id: 'other-organization', kind: 'organization', state: 'active', minimumAuthnEpoch: 1 });
  delete facts.accounts[0]!.operatorId;
  facts.grants[0]!.subject = { organizationId: 'organization', role: 'owner' };
  facts.memberships = [{ organizationId: 'organization', actorId: 'agent', role: 'owner', valid }];
  await product().replaceFacts(facts);
  expect(await product().execute(session, operation)).toBe('permitted');
}
test('organizations cannot be authenticated actors', async () => {
  await organizationGrant();
  expect(await attempt({ actorId: 'organization', clientId: 'first-party', scopes: ['read'] })).toBe('denied');
});
test('organization-role grants require an eligible human member with the specified role', async () => {
  const mutations: ((f: Facts) => void)[] = [
    (f) => {
      f.memberships = [];
    },
    (f) => {
      f.memberships[0]!.role = 'member';
    },
    (f) => {
      f.memberships[0]!.actorId = 'other';
    },
    (f) => {
      f.memberships[0]!.organizationId = 'other-organization';
    },
    (f) => {
      f.accounts[0]!.operatorId = 'principal';
    },
    (f) => {
      f.memberships[0]!.valid = { start: '2029-01-01T00:00:00.000Z', end: now };
    },
    (f) => {
      f.memberships[0]!.valid = { start: end, end: '2031-01-01T00:00:00.000Z' };
    },
  ];
  for (const mutation of mutations) {
    await organizationGrant();
    await denies(mutation);
  }
});
test('grant administration cannot delegate actions the grantor lacks', async () => {
  await replace((f) => {
    f.grants = [grant('actor-grant', 'agent'), { ...grant('administration', 'agent'), actions: ['grant:manage'] }];
    f.grants[0]!.actions = ['read', 'write'];
    f.consents[0]!.scopes = ['read', 'write', 'grant:manage'];
  });
  const administrator = await authenticate({ ...directLogin, scopes: ['read', 'write', 'grant:manage'] });
  const delegation: Operation = { kind: 'grant', grant: { ...grant('recipient-write', 'other'), actions: ['write'] } };
  expect(await product().execute(administrator, delegation)).toBe('permitted');
  const recipient = await authenticate({ actorId: 'other', clientId: 'first-party', scopes: ['read', 'write'] });
  const write: Operation = { ...operation, action: 'write' };
  expect(await product().execute(recipient, write)).toBe('permitted');
  // Reseed the same pre-administration fixture, removing only the grantor's write.
  // The recipient grant produced by the positive command is also cleared.
  await replace((f) => {
    f.grants[0]!.actions = ['read'];
  });
  expect(await product().execute(administrator, delegation)).toBe('denied');
  expect(await product().execute(recipient, write)).toBe('denied');
});
