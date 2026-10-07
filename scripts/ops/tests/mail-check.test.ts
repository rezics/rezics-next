import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkSenderDomains,
  MAIL_DNS_BOUNDS,
  readSenderDomainsFile,
  senderDomains,
  type MailDnsResolver,
} from '../mail-check.ts';

const domains = {
  fromDomain: 'notices.example.com',
  envelopeDomain: 'bounce.example.net',
  dkimDomain: 'example.com',
  dkimSelector: 'production',
  dmarcDomain: 'example.com',
};
const names = {
  spf: domains.envelopeDomain,
  dkim: `${domains.dkimSelector}._domainkey.${domains.dkimDomain}`,
  dmarc: `_dmarc.${domains.dmarcDomain}`,
};
const rsaKey = generateKeyPairSync('rsa', { modulusLength: 1024 })
  .publicKey.export({ format: 'der', type: 'spki' })
  .toString('base64');
const ed25519Key = Buffer.from(
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!,
  'base64url',
).toString('base64');
const healthy = {
  spf: 'v=spf1 include:provider.example.net ip4:192.0.2.0/24 ip6:2001:db8::/32 -all',
  dkim: `v=DKIM1; k=rsa; p=${rsaKey}; h=sha256; s=email`,
  dmarc: 'v=DMARC1; p=reject; sp=quarantine; adkim=s; aspf=r; pct=100',
};
type Kind = keyof typeof names;

function resolverWith(kind: Kind, answer: string[][]): MailDnsResolver {
  return {
    resolveTxt: async (name) =>
      name === names[kind]
        ? answer
        : [[healthy[(Object.keys(names) as Kind[]).find((key) => names[key] === name)!]]],
  };
}

test('checks exactly the envelope, selector and policy TXT names, joining only each record’s chunks', async () => {
  const calls: string[] = [];
  const report = await checkSenderDomains(domains, {
    resolveTxt: async (name) => {
      calls.push(name);
      if (name === names.spf) return [['site-verification=unrelated'], ['v=spf', '1 -all']];
      if (name === names.dkim)
        return [
          ['unrelated-provider-token'],
          ['v=DKIM1; k=rsa; p=', rsaKey.slice(0, 80), rsaKey.slice(80)],
        ];
      if (name === names.dmarc)
        return [['site-verification=unrelated'], ['v=DMARC1;', ' p=reject']];
      throw new Error('Unexpected DNS query');
    },
  });
  expect(calls.sort()).toEqual(Object.values(names).sort());
  expect(report.domains).toEqual(domains);
  for (const kind of Object.keys(names) as Kind[]) {
    expect(report[kind]).toEqual({
      name: names[kind],
      state: 'present',
      reason: 'record structure checked; delivery verification still required',
    });
  }
});

test('a provider CNAME resolver can return its final TXT answer without another application lookup', async () => {
  const calls: string[] = [];
  // Recursive DNS resolves the provider CNAME; this interface supplies its final TXT RRset.
  const providerAnswers: Record<string, string[][]> = {
    [names.spf]: [[healthy.spf]],
    [names.dkim]: [[`k=ed25519; p=${ed25519Key}`]],
    [names.dmarc]: [[healthy.dmarc]],
  };
  const report = await checkSenderDomains(domains, {
    resolveTxt: async (name) => {
      calls.push(name);
      return providerAnswers[name]!;
    },
  });
  expect(calls.sort()).toEqual(Object.keys(providerAnswers).sort());
  expect(report.dkim.state).toBe('present');
});

test('accepts structural RSA and Ed25519 public keys, including RSA as the default key type', async () => {
  for (const record of [
    `p=${rsaKey}`,
    `v=DKIM1; p=${rsaKey}`,
    `v=DKIM1; k=ed25519; p=${ed25519Key}`,
  ]) {
    const report = await checkSenderDomains(domains, resolverWith('dkim', [[record]]));
    expect(report.dkim.state).toBe('present');
  }
});

test('SPF syntax accepts supported mechanisms and modifiers without resolving their targets', async () => {
  const report = await checkSenderDomains(
    domains,
    resolverWith('spf', [
      [
        'v=spf1 a mx:mail.example.net/24//64 ptr:example.net exists:probe.example.net ?all redirect:bad',
      ],
    ]),
  );
  expect(report.spf.state).toBe('invalid');
  const valid = await checkSenderDomains(
    domains,
    resolverWith('spf', [
      [
        'v=spf1 a mx:mail.example.net/24//64 ptr:example.net exists:probe.example.net include:_spf.provider.example.net ?all redirect=_spf.example.net exp=explain.example.net extension=value',
      ],
    ]),
  );
  expect(valid.spf.state).toBe('present');
});

for (const kind of Object.keys(names) as Kind[]) {
  test(`${kind} distinguishes duplicate records from unrelated or absent TXT data`, async () => {
    const duplicate = await checkSenderDomains(
      domains,
      resolverWith(kind, [[healthy[kind]], [healthy[kind]]]),
    );
    expect(duplicate[kind]).toMatchObject({
      state: 'invalid',
      reason: 'multiple matching TXT records',
    });
    for (const answer of [[], [['provider-verification=token']], [['v=spf'], ['1 -all']]]) {
      const missing = await checkSenderDomains(domains, resolverWith(kind, answer));
      expect(missing[kind]).toMatchObject({ state: 'missing', reason: 'no matching TXT record' });
    }
  });
}

test('DNS absent-name and absent-TXT errors are missing while server failure and timeout are unknown', async () => {
  for (const code of ['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED']) {
    const report = await checkSenderDomains(domains, {
      resolveTxt: async () => {
        throw Object.assign(new Error('DNS driver failure'), { code });
      },
    });
    const state = ['ENODATA', 'ENOTFOUND'].includes(code) ? 'missing' : 'unknown';
    for (const kind of Object.keys(names) as Kind[]) expect(report[kind].state).toBe(state);
  }
});

test('a stalled resolver is bounded while the healthy lookups retain their evidence', async () => {
  const report = await checkSenderDomains(
    domains,
    {
      resolveTxt: async (name) =>
        name === names.spf
          ? new Promise<string[][]>(() => {})
          : [[name === names.dkim ? healthy.dkim : healthy.dmarc]],
    },
    5,
  );
  expect(report.spf).toMatchObject({ state: 'unknown', reason: 'DNS lookup failed or timed out' });
  expect(report.dkim.state).toBe('present');
  expect(report.dmarc.state).toBe('present');
});

test('independent outcomes survive an absent key and malformed policy', async () => {
  const report = await checkSenderDomains(domains, {
    resolveTxt: async (name) => {
      if (name === names.dkim) throw { code: 'ENODATA' };
      return [[name === names.spf ? healthy.spf : 'v=DMARC1; p=discard']];
    },
  });
  expect(report.spf.state).toBe('present');
  expect(report.dkim.state).toBe('missing');
  expect(report.dmarc.state).toBe('invalid');
});

test('resolver failures reveal neither raw messages nor their nested causes', async () => {
  for (const error of [
    Object.assign(
      new Error('private-provider-host secret-credential', { cause: 'raw-provider-response' }),
      { code: 'ESERVFAIL' },
    ),
    'private-provider-host secret-credential',
    null,
  ]) {
    const report = await checkSenderDomains(domains, {
      resolveTxt: () => {
        throw error;
      },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /private-provider-host|secret-credential|raw-provider-response/,
    );
    for (const kind of Object.keys(names) as Kind[])
      expect(report[kind]).toMatchObject({
        state: 'unknown',
        reason: 'DNS lookup failed or timed out',
      });
  }
});

const malformedSpf = [
  'v=spf1 redirect=example.net redirect=example.com',
  'v=spf1 exp=invalid',
  'v=spf1 include:invalid',
  'v=spf1 unrecognized:example.net',
  'v=spf1 ip4:999.1.2.3',
  'v=spf1 ip4:2001:db8::1',
  'v=spf1 ip4:192.0.2.1/33',
  'v=spf1 ip6:192.0.2.1',
  'v=spf1 ip6:2001:db8::1/129',
  'v=spf1 mx/33',
  'v=spf1 a//129',
  'v=spf1 ptr/24',
];
for (const record of malformedSpf) {
  test(`rejects malformed SPF: ${record}`, async () => {
    expect((await checkSenderDomains(domains, resolverWith('spf', [[record]]))).spf.state).toBe(
      'invalid',
    );
  });
}

test('SPF macro expansion remains unknown rather than a positive evidence result', async () => {
  for (const record of [
    'v=spf1 include:%{d}.provider.example.net -all',
    'v=spf1 exists:%{i}.example.net -all',
  ]) {
    const report = await checkSenderDomains(domains, resolverWith('spf', [[record]]));
    expect(report.spf).toMatchObject({
      state: 'unknown',
      reason: 'SPF macros require provider evaluation',
    });
  }
});

const malformedDkim = [
  ['v=DKIM1; p=', 'revoked DKIM key'],
  ['v=DKIM1; k=rsa', 'missing DKIM public key'],
  ['v=DKIM1; p=not*base64', 'invalid DKIM base64 key'],
  ['v=DKIM1; p=YWJj', 'invalid DER DKIM public key'],
  [`v=DKIM1; p=${ed25519Key}`, 'invalid DER DKIM public key'],
  ['v=DKIM1; k=ed25519; p=YWJj', 'invalid Ed25519 DKIM key length'],
  [`p=${rsaKey}; v=DKIM1`, 'invalid DKIM tags or version'],
  [`v=DKIM2; p=${rsaKey}`, 'invalid DKIM tags or version'],
  [`v=DKIM1; p=${rsaKey}; p=${rsaKey}`, 'invalid DKIM tags or version'],
  [`v=DKIM1; p=${rsaKey}; malformed`, 'invalid DKIM tags or version'],
  [`v=DKIM1; p=${rsaKey}; h=sha1`, 'DKIM key does not permit SHA-256'],
  [`v=DKIM1; p=${rsaKey}; s=other`, 'DKIM key does not permit email'],
];
for (const [record, reason] of malformedDkim) {
  test(`rejects malformed DKIM: ${reason} (${malformedDkim.findIndex((item) => item[0] === record)})`, async () => {
    const report = await checkSenderDomains(domains, resolverWith('dkim', [[record!]]));
    expect(report.dkim).toMatchObject({ state: 'invalid', reason });
  });
}

test('rejects a parseable weak RSA key and preserves unsupported key types as unknown', async () => {
  const weakKey = generateKeyPairSync('rsa', { modulusLength: 512 })
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');
  const weak = await checkSenderDomains(domains, resolverWith('dkim', [[`v=DKIM1; p=${weakKey}`]]));
  expect(weak.dkim).toMatchObject({
    state: 'invalid',
    reason: 'DKIM requires an RSA key of at least 1024 bits',
  });
  const unsupported = await checkSenderDomains(
    domains,
    resolverWith('dkim', [[`v=DKIM1; k=future; p=${rsaKey}`]]),
  );
  expect(unsupported.dkim).toMatchObject({ state: 'unknown', reason: 'unsupported DKIM key type' });
});

for (const record of [
  'v=DMARC1',
  'v=DMARC1; p=discard',
  'v=DMARC1; p=reject; p=none',
  'v=DMARC1; adkim=s; p=reject',
  'v=DMARC1; p=reject; malformed',
  'v=DMARC1; p=reject; adkim=invalid',
  'v=DMARC1; p=reject; aspf=invalid',
  'v=DMARC1; p=reject; sp=discard',
  'v=DMARC1; p=reject; pct=101',
  'v=DMARC1; p=reject; pct=-1',
  'v=DMARC1; p=reject; pct=1.5',
]) {
  test(`rejects malformed DMARC: ${record}`, async () => {
    expect((await checkSenderDomains(domains, resolverWith('dmarc', [[record]]))).dmarc.state).toBe(
      'invalid',
    );
  });
}

test('DNS record, chunk and UTF-8 byte budgets accept their limit and refuse excess as unknown', async () => {
  const atLimit = [
    [[healthy.spf], ...Array.from({ length: MAIL_DNS_BOUNDS.records - 1 }, () => ['unrelated'])],
    [[healthy.spf, ...Array<string>(MAIL_DNS_BOUNDS.chunks - 1).fill('')]],
    [['v=spf1 -all'.padEnd(MAIL_DNS_BOUNDS.bytes, ' ')]],
  ];
  for (const answer of atLimit)
    expect((await checkSenderDomains(domains, resolverWith('spf', answer))).spf.state).toBe(
      'present',
    );
  const excessive = [
    Array.from({ length: MAIL_DNS_BOUNDS.records + 1 }, () => [healthy.spf]),
    [[healthy.spf, ...Array<string>(MAIL_DNS_BOUNDS.chunks).fill('')]],
    [['v=spf1 -all'.padEnd(MAIL_DNS_BOUNDS.bytes + 1, ' ')]],
    [[healthy.spf], ['é'.repeat(MAIL_DNS_BOUNDS.bytes / 2)]],
  ];
  for (const answer of excessive) {
    const report = await checkSenderDomains(domains, resolverWith('spf', answer));
    expect(report.spf.state).toBe('unknown');
    expect(report.dkim.state).toBe('present');
    expect(report.dmarc.state).toBe('present');
  }
});

test('malformed resolver output cannot become valid record evidence', async () => {
  for (const answer of [null, {}, ['v=spf1 -all'], [[42]], [['v=spf1 -all'], null]]) {
    const report = await checkSenderDomains(
      domains,
      resolverWith('spf', answer as unknown as string[][]),
    );
    expect(report.spf.state).toBe('unknown');
  }
});

test('normalizes ASCII names and permits a dotted selector without broadening the DMARC scope', () => {
  expect(
    senderDomains({
      ...domains,
      fromDomain: 'NOTICES.EXAMPLE.COM',
      dkimSelector: 'Provider.Production',
    }),
  ).toEqual({ ...domains, dkimSelector: 'provider.production' });
});

test('malformed configuration and timeout bounds refuse before any DNS operation', async () => {
  let calls = 0;
  const resolver: MailDnsResolver = {
    resolveTxt: async () => {
      calls++;
      return [];
    },
  };
  const invalidInputs = [
    null,
    [],
    'private-input',
    {},
    { ...domains, extra: 'private-value' },
    { ...domains, envelopeDomain: undefined },
    { ...domains, dkimSelector: 42 },
    ...[
      'localhost',
      '.example.com',
      'example..com',
      'example.com.',
      '-mail.example.com',
      'mail_.example.com',
      'méssage.example.com',
      `${'a'.repeat(64)}.example.com`,
    ].map((envelopeDomain) => ({ ...domains, envelopeDomain })),
    ...['', '-selector', 'bad selector', 'selector..next', 'selector.', 'é', 'a'.repeat(64)].map(
      (dkimSelector) => ({ ...domains, dkimSelector }),
    ),
    { ...domains, dmarcDomain: 'other.example.net' },
    { ...domains, fromDomain: 'notexample.com' },
    {
      ...domains,
      dkimSelector: 'a'.repeat(63),
      dkimDomain: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.com`,
    },
  ];
  for (const input of invalidInputs)
    await expect(checkSenderDomains(input, resolver)).rejects.toThrow();
  for (const timeout of [
    0,
    -1,
    1.5,
    MAIL_DNS_BOUNDS.timeoutMs + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])
    await expect(checkSenderDomains(domains, resolver, timeout)).rejects.toThrow('DNS timeout');
  expect(calls).toBe(0);
});

test('CLI refuses malformed, oversized and absent files with bounded private output before DNS', () => {
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const base = mkdtempSync(join(root, '.temp/mail-check-'));
  const cli = resolve(import.meta.dir, '../mail-check.ts');
  try {
    const malformed = join(base, 'private-malformed.json');
    const shape = join(base, 'private-shape.json');
    const oversized = join(base, 'private-oversized.json');
    writeFileSync(malformed, '{"private-credential":');
    writeFileSync(shape, JSON.stringify({ privateCredential: 'secret-value' }));
    writeFileSync(oversized, ' '.repeat(MAIL_DNS_BOUNDS.bytes + 1));
    for (const args of [
      [],
      [malformed],
      [shape],
      [oversized],
      [join(base, 'private-absent.json')],
      [shape, malformed],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 16_384,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'Mail DNS check refused: supply one bounded JSON file with the five sender-domain fields\n',
      );
      expect(result.stderr).not.toMatch(/private-|secret-value/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sender-domain file reading accepts the exact byte budget and refuses excess, nonfiles and invalid UTF-8', () => {
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const base = mkdtempSync(join(root, '.temp/mail-check-file-'));
  try {
    const bounded = join(base, 'bounded.json');
    const excessive = join(base, 'excessive.json');
    const invalidUtf8 = join(base, 'invalid-utf8.json');
    const invalidJson = join(base, 'invalid-json.json');
    const json = JSON.stringify(domains);
    writeFileSync(bounded, json.padEnd(MAIL_DNS_BOUNDS.bytes, ' '));
    writeFileSync(excessive, json.padEnd(MAIL_DNS_BOUNDS.bytes + 1, ' '));
    writeFileSync(invalidUtf8, Buffer.from([0xff]));
    writeFileSync(invalidJson, '{');
    expect(readSenderDomainsFile(bounded)).toEqual(domains);
    for (const path of [excessive, invalidUtf8, invalidJson, base, join(base, 'absent.json')])
      expect(() => readSenderDomainsFile(path)).toThrow();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
