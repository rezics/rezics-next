import { createPublicKey } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';

/** DNS evidence only: no message, recursive SPF evaluation or alignment claim. */
export interface SenderDomains {
  fromDomain: string;
  envelopeDomain: string;
  dkimDomain: string;
  dkimSelector: string;
  dmarcDomain: string;
}
export interface MailDnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
}
export type MailDnsState = 'present' | 'missing' | 'invalid' | 'unknown';
export interface MailDnsEvidence {
  name: string;
  state: MailDnsState;
  reason: string;
}
export const MAIL_DNS_BOUNDS = {
  timeoutMs: 5_000,
  records: 64,
  bytes: 16_384,
  chunks: 256,
} as const;

function domain(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    value.includes('.') &&
    value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  );
}
export function senderDomains(input: unknown): SenderDomains {
  if (!input || typeof input !== 'object') throw new Error('Expected sender-domain JSON');
  const value = input as Record<string, unknown>;
  const fields = ['fromDomain', 'envelopeDomain', 'dkimDomain', 'dkimSelector', 'dmarcDomain'];
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => typeof value[key] !== 'string')
  )
    throw new Error('Expected exactly five sender-domain fields');
  const result = Object.fromEntries(
    fields.map((key) => [key, (value[key] as string).toLowerCase()]),
  ) as unknown as SenderDomains;
  if (
    ![result.fromDomain, result.envelopeDomain, result.dkimDomain, result.dmarcDomain].every(
      domain,
    ) ||
    !result.dkimSelector
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    `${result.dkimSelector}._domainkey.${result.dkimDomain}`.length > 253 ||
    `_dmarc.${result.dmarcDomain}`.length > 253 ||
    !(
      result.fromDomain === result.dmarcDomain ||
      result.fromDomain.endsWith(`.${result.dmarcDomain}`)
    )
  )
    throw new Error(
      'Invalid sender DNS names; use ASCII domains and the actual DMARC policy domain',
    );
  return result;
}

type Finding = Pick<MailDnsEvidence, 'state' | 'reason'>;
const invalid = (reason: string): Finding => ({ state: 'invalid', reason });
const unknown = (reason: string): Finding => ({ state: 'unknown', reason });
const present = (): Finding => ({
  state: 'present',
  reason: 'record structure checked; delivery verification still required',
});

// SPF targets frequently use service labels such as _spf.provider.example.
function spfDomain(value: string): boolean {
  return (
    value.length <= 253 &&
    value.includes('.') &&
    value.split('.').every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label))
  );
}

function spf(record: string): Finding {
  const modifiers = new Set<string>();
  for (const term of record.split(' ').slice(1).filter(Boolean)) {
    if (term.includes('%')) return unknown('SPF macros require provider evaluation');
    const modifier = /^([a-z][a-z0-9_.-]*)=(\S+)$/i.exec(term);
    if (modifier) {
      const name = modifier[1]!.toLowerCase();
      if (modifiers.has(name)) return invalid('duplicate SPF modifier');
      modifiers.add(name);
      if (['redirect', 'exp'].includes(name) && !spfDomain(modifier[2]!))
        return invalid('invalid SPF modifier domain');
      continue;
    }
    const mechanism = term.replace(/^[+?~-]/, '');
    if (/^all$/i.test(mechanism)) continue;
    const ip = /^ip([46]):([^/]+)(?:\/(\d+))?$/i.exec(mechanism);
    if (ip) {
      const family = Number(ip[1]);
      if (
        isIP(ip[2]!) !== family ||
        (ip[3] !== undefined && Number(ip[3]) > (family === 4 ? 32 : 128))
      )
        return invalid('invalid SPF IP network');
      continue;
    }
    const target = /^(include|exists):(.+)$/i.exec(mechanism);
    if (target && spfDomain(target[2]!)) continue;
    const host = /^(a|mx|ptr)(?::([^/]+))?(?:\/(\d+))?(?:\/\/(\d+))?$/i.exec(mechanism);
    if (
      host &&
      (!host[2] || spfDomain(host[2])) &&
      (!host[3] || Number(host[3]) <= 32) &&
      (!host[4] || Number(host[4]) <= 128) &&
      (host[1]!.toLowerCase() !== 'ptr' || (!host[3] && !host[4]))
    )
      continue;
    return invalid('invalid or unrecognized SPF mechanism');
  }
  return present();
}

function tags(record: string): Map<string, string> | null {
  const result = new Map<string, string>();
  const entries = record.trim().replace(/;\s*$/, '').split(';');
  for (const entry of entries) {
    const match = /^\s*([a-z][a-z0-9_]*)\s*=\s*([^\r\n]*)\s*$/i.exec(entry);
    if (!match || result.has(match[1]!)) return null;
    result.set(match[1]!, match[2]!.trim());
  }
  return result;
}
function dkim(record: string): Finding {
  const values = tags(record);
  if (
    !values ||
    (values.has('v') && (values.keys().next().value !== 'v' || values.get('v') !== 'DKIM1'))
  )
    return invalid('invalid DKIM tags or version');
  const key = values.get('p')?.replace(/[ \t]/g, '');
  if (!key) return invalid(values.has('p') ? 'revoked DKIM key' : 'missing DKIM public key');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(key))
    return invalid('invalid DKIM base64 key');
  const type = values.get('k') ?? 'rsa';
  if (!['rsa', 'ed25519'].includes(type)) return unknown('unsupported DKIM key type');
  const bytes = Buffer.from(key, 'base64');
  if (type === 'ed25519') {
    if (bytes.length !== 32) return invalid('invalid Ed25519 DKIM key length');
  } else {
    try {
      const publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
      if (
        publicKey.asymmetricKeyType !== 'rsa' ||
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 1_024
      )
        return invalid('DKIM requires an RSA key of at least 1024 bits');
    } catch {
      return invalid('invalid DER DKIM public key');
    }
  }
  if (
    values.has('h') &&
    !values
      .get('h')!
      .split(':')
      .map((value) => value.trim())
      .includes('sha256')
  )
    return invalid('DKIM key does not permit SHA-256');
  if (
    values.has('s') &&
    !values
      .get('s')!
      .split(':')
      .map((value) => value.trim())
      .some((value) => ['*', 'email'].includes(value))
  )
    return invalid('DKIM key does not permit email');
  return present();
}
function dmarc(record: string): Finding {
  const values = tags(record);
  if (
    !values ||
    [...values.keys()][0] !== 'v' ||
    [...values.keys()][1] !== 'p' ||
    values.get('v') !== 'DMARC1' ||
    !['none', 'quarantine', 'reject'].includes(values.get('p') ?? '')
  )
    return invalid('invalid DMARC version or policy');
  for (const key of ['adkim', 'aspf'])
    if (values.has(key) && !['r', 's'].includes(values.get(key)!))
      return invalid('invalid DMARC alignment mode');
  if (values.has('sp') && !['none', 'quarantine', 'reject'].includes(values.get('sp')!))
    return invalid('invalid DMARC subdomain policy');
  if (
    values.has('pct') &&
    (!/^\d{1,3}$/.test(values.get('pct')!) || Number(values.get('pct')) > 100)
  )
    return invalid('invalid DMARC percentage');
  return present();
}

async function evidence(
  name: string,
  kind: 'spf' | 'dkim' | 'dmarc',
  resolver: MailDnsResolver,
  timeoutMs: number,
): Promise<MailDnsEvidence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      Promise.resolve().then(() => resolver.resolveTxt(name)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject({ code: 'ETIMEOUT' }), timeoutMs);
      }),
    ]);
    let bytes = 0;
    let chunks = 0;
    if (!Array.isArray(records) || records.length > MAIL_DNS_BOUNDS.records)
      return { name, ...unknown('DNS answer exceeds record bound') };
    for (const record of records) {
      if (!Array.isArray(record)) return { name, ...unknown('malformed resolver answer') };
      for (const chunk of record) {
        if (typeof chunk !== 'string') return { name, ...unknown('malformed resolver answer') };
        bytes += Buffer.byteLength(chunk);
        chunks++;
        if (bytes > MAIL_DNS_BOUNDS.bytes || chunks > MAIL_DNS_BOUNDS.chunks)
          return { name, ...unknown('DNS answer exceeds size bound') };
      }
    }
    const candidates = records
      .map((record) => record.join(''))
      .filter((record) =>
        kind === 'spf'
          ? /^v=spf1(?: |$)/i.test(record)
          : kind === 'dmarc'
            ? /^\s*v\s*=\s*DMARC1(?:\s*;|\s*$)/.test(record)
            : /(?:^|;)\s*(?:v\s*=\s*DKIM1|p\s*=)/.test(record),
      );
    if (!candidates.length) return { name, state: 'missing', reason: 'no matching TXT record' };
    if (candidates.length !== 1) return { name, ...invalid('multiple matching TXT records') };
    const check = { spf, dkim, dmarc }[kind];
    return { name, ...check(candidates[0]!) };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return ['ENOTFOUND', 'ENODATA'].includes(code ?? '')
      ? { name, state: 'missing', reason: 'DNS name or TXT record absent' }
      : { name, ...unknown('DNS lookup failed or timed out') };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkSenderDomains(
  input: unknown,
  resolver?: MailDnsResolver,
  timeoutMs: number = MAIL_DNS_BOUNDS.timeoutMs,
) {
  const domains = senderDomains(input);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAIL_DNS_BOUNDS.timeoutMs)
    throw new Error('DNS timeout must be between 1 and 5000 ms');
  const owned = resolver ? undefined : new Resolver({ timeout: timeoutMs, tries: 1 });
  const dns = resolver ?? owned!;
  try {
    const [spf, dkim, dmarc] = await Promise.all([
      evidence(domains.envelopeDomain, 'spf', dns, timeoutMs),
      evidence(`${domains.dkimSelector}._domainkey.${domains.dkimDomain}`, 'dkim', dns, timeoutMs),
      evidence(`_dmarc.${domains.dmarcDomain}`, 'dmarc', dns, timeoutMs),
    ]);
    return { domains, spf: spf!, dkim: dkim!, dmarc: dmarc! };
  } finally {
    owned?.cancel();
  }
}

/** A limited descriptor read also bounds files that grow after the size check. */
export function readSenderDomainsFile(path: string): unknown {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAIL_DNS_BOUNDS.bytes)
      throw new Error('Expected a bounded regular JSON file');
    const buffer = Buffer.alloc(MAIL_DNS_BOUNDS.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const next = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!next) break;
      length += next;
    }
    if (length > MAIL_DNS_BOUNDS.bytes) throw new Error('Sender-domain file exceeds bound');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    closeSync(descriptor);
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one sender-domain JSON file');
    const path = process.argv[2]!;
    const report = await checkSenderDomains(readSenderDomainsFile(path));
    console.log(JSON.stringify(report, null, 2));
    if ([report.spf, report.dkim, report.dmarc].some((item) => item.state !== 'present'))
      process.exitCode = 1;
  } catch {
    console.error(
      'Mail DNS check refused: supply one bounded JSON file with the five sender-domain fields',
    );
    process.exitCode = 1;
  }
}
