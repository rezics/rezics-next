import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';
import type { Pool } from 'pg';
import { accountEmailQueue, renderAccountEmail, smtpSender } from '../src/email.ts';
import {
  mailEventSignature,
  mailSuppressionApi,
  optionalMailSuppressed,
} from '../src/mail-suppression.ts';

const secret = 'offline-mail-drill-account-secret';
const eventsSecret = 'offline-mail-drill-delivery-events-secret';
const address = 'member@example.test';
const input = {
  userId: 'member',
  to: address,
  url: 'https://accounts.example.test/',
  locale: 'en' as const,
};
type MailRow = {
  id: string;
  user_id: string;
  payload: string | null;
  state: string;
  startedAt: number;
  expiresAt: number;
};

/** A SQL-boundary fake: fail on unfamiliar queries instead of inventing API behavior.
 * Claims mutate synchronously, modeling the database's atomic UPDATE claim. The
 * existing database integration suite owns PostgreSQL locking correctness. */
function mailStore() {
  const mail = new Map<string, MailRow>();
  const suppression = new Map<string, { reason: string; source: string }>();
  let loseSentAcknowledgement = false;
  const query = async (statement: string, values: unknown[] = []) => {
    const sql = statement.replace(/\s+/g, ' ').trim();
    const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
    if (sql === "SELECT 1 FROM rezics_mail_suppression WHERE address = $1 AND purpose = 'digest'")
      return result(suppression.has(String(values[0])) ? [{}] : []);
    if (sql.startsWith('INSERT INTO rezics_mail_suppression ')) {
      const key = String(values[0]);
      if (!suppression.has(key))
        suppression.set(key, { reason: String(values[1]), source: String(values[2]) });
      return result();
    }
    if (sql.startsWith('INSERT INTO rezics_account_email ')) {
      const id = String(values[0]);
      if (!mail.has(id))
        mail.set(id, {
          id,
          user_id: String(values[1]),
          payload: String(values[2]),
          state: 'queued',
          startedAt: 0,
          expiresAt: Date.now() + Number(values[3]) * 60_000,
        });
      return result();
    }
    if (sql.startsWith('SELECT u.email,u."emailVerified",s.deletion_started_at FROM "user" u '))
      return result(
        values[0] === input.userId
          ? [{ email: address, emailVerified: true, deletion_started_at: null }]
          : [],
      );
    if (sql.includes("WHERE state = 'sending' AND started_at < now() - interval '2 minutes'")) {
      for (const row of mail.values())
        if (row.state === 'sending' && row.startedAt < Date.now() - 120_000) {
          row.state = 'uncertain';
          row.payload = null;
        }
      return result();
    }
    if (sql.includes("WHERE state = 'queued' AND expires_at <= now()")) {
      for (const row of mail.values())
        if (row.state === 'queued' && row.expiresAt <= Date.now()) {
          row.state = 'expired';
          row.payload = null;
        }
      return result();
    }
    if (sql.includes('FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, user_id, payload')) {
      const row = [...mail.values()].find(
        (value) => value.state === 'queued' && value.expiresAt > Date.now(),
      );
      if (!row) return result();
      row.state = 'sending';
      row.startedAt = Date.now();
      return result([{ id: row.id, user_id: row.user_id, payload: row.payload }]);
    }
    const terminal =
      /^UPDATE rezics_account_email SET state = '(sent|expired|uncertain)', payload = NULL WHERE id = \$1$/.exec(
        sql,
      );
    if (terminal) {
      if (terminal[1] === 'sent' && loseSentAcknowledgement) {
        loseSentAcknowledgement = false;
        throw new Error('Database acknowledgement lost after SMTP accepted DATA');
      }
      const row = mail.get(String(values[0]));
      if (!row) throw new Error('Unknown queue row');
      row.state = terminal[1]!;
      row.payload = null;
      return result();
    }
    throw new Error(`Unexpected mail-drill SQL: ${sql}`);
  };
  return {
    pool: { query } as unknown as Pool,
    mail,
    suppression,
    loseSentAcknowledgement: () => {
      loseSentAcknowledgement = true;
    },
  };
}

/** Short-lived loopback certificate, generated with the already-pinned runtime.
 * The child trusts this certificate explicitly; TLS validation stays enabled. */
async function loopbackCertificate(directory: string) {
  const der = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const size =
      body.length < 128
        ? Buffer.from([body.length])
        : body.length < 256
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x82, body.length >> 8, body.length & 255]);
    return Buffer.concat([Buffer.from([tag]), size, body]);
  };
  const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
  const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
  const algorithm = sequence(oid('2a864886f70d01010b'), der(0x05));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('localhost')))));
  const time = (offset: number) =>
    der(
      0x18,
      Buffer.from(
        new Date(Date.now() + offset)
          .toISOString()
          .replace(/[-:T]/g, '')
          .replace(/\.\d{3}Z$/, 'Z'),
      ),
    );
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const body = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    sequence(time(-60_000), time(86_400_000)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      sequence(
        sequence(
          oid('551d13'),
          der(0x01, Buffer.from([0xff])),
          der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
        ),
        sequence(
          oid('551d11'),
          der(
            0x04,
            sequence(der(0x87, Buffer.from([127, 0, 0, 1])), der(0x82, Buffer.from('localhost'))),
          ),
        ),
      ),
    ),
  );
  const certificate = sequence(
    body,
    algorithm,
    der(0x03, Buffer.from([0]), sign('sha256', body, privateKey)),
  );
  const cert = `-----BEGIN CERTIFICATE-----\n${certificate
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const caPath = join(directory, 'loopback-ca.pem');
  await writeFile(caPath, cert);
  return { cert, key, caPath };
}

async function smtpFixture(
  options: {
    tls?: Awaited<ReturnType<typeof loopbackCertificate>>;
    badAuth?: boolean;
    loseDataAck?: boolean;
  } = {},
) {
  const sockets = new Set<Socket>();
  const commands: { command: string; encrypted: boolean }[] = [];
  const messages: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let stream: Socket = socket;
    let buffer = '',
      message = '';
    let encrypted = false,
      authenticated = false,
      data = false;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data && line !== '.') {
          message += `${line}\r\n`;
          continue;
        }
        if (data) {
          messages.push(message);
          data = false;
          if (options.loseDataAck) stream.destroy();
          else stream.write('250 queued\r\n');
          continue;
        }
        commands.push({ command: line, encrypted });
        if (line.startsWith('EHLO'))
          stream.write(
            `250-localhost\r\n${options.tls && !encrypted ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`,
          );
        else if (line === 'STARTTLS') {
          if (!options.tls) {
            stream.write('454 TLS unavailable\r\n');
            continue;
          }
          socket.removeListener('data', onData);
          socket.write('220 begin TLS\r\n');
          const secure = new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext(options.tls),
          });
          secure.on('error', () => {});
          stream = secure;
          encrypted = true;
          buffer = '';
          secure.on('data', onData);
          return;
        } else if (line.startsWith('AUTH PLAIN ')) {
          authenticated =
            !options.badAuth &&
            Buffer.from(line.slice(11), 'base64').toString() === '\0mail-user\0mail-password';
          stream.write(authenticated ? '235 authenticated\r\n' : '535 authentication failed\r\n');
        } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
          stream.write(
            authenticated || !options.tls ? '250 accepted\r\n' : '530 authentication required\r\n',
          );
        } else if (line === 'DATA') {
          data = true;
          stream.write('354 send data\r\n');
        } else if (line === 'QUIT') stream.end('221 goodbye\r\n');
        else stream.write('500 unsupported\r\n');
      }
    };
    socket.on('data', onData);
    socket.write('220 localhost SMTP\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === 'string') throw new Error('SMTP port unavailable');
  return {
    port: endpoint.port,
    commands,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const smtpConfig = (port: number) => ({
  host: '127.0.0.1',
  port,
  secure: false,
  requireTLS: true,
  user: 'mail-user',
  password: 'mail-password',
  from: 'accounts@example.test',
});
const smtpMail = {
  id: 'mail-drill',
  to: address,
  ...renderAccountEmail('verify', 'en', `${input.url}verify`),
};

async function trustedSend(port: number, caPath: string) {
  // Root CAs are loaded at runtime startup, so isolate trust from every other test.
  const source = new URL('../src/email.ts', import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `const { smtpSender } = await import(${JSON.stringify(source)}); try {
      await smtpSender(${JSON.stringify(smtpConfig(port))})(${JSON.stringify(smtpMail)});
      console.log(JSON.stringify({ accepted: true }));
    } catch (error) { console.log(JSON.stringify({ accepted: false, code: error.code, message: error.message })); }`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath, NODE_TLS_REJECT_UNAUTHORIZED: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`SMTP child exited ${exit}: ${stderr}`);
  return JSON.parse(stdout) as { accepted: boolean; code?: string; message?: string };
}

test('production mail drill: required STARTTLS refuses missing TLS before authentication or DATA', async () => {
  const smtp = await smtpFixture();
  try {
    await expect(smtpSender(smtpConfig(smtp.port))(smtpMail)).rejects.toThrow();
    expect(smtp.commands.some((value) => value.command === 'STARTTLS')).toBe(true);
    expect(smtp.commands.some((value) => /^(AUTH|MAIL FROM:|DATA)/.test(value.command))).toBe(
      false,
    );
    expect(smtp.messages).toHaveLength(0);
  } finally {
    await smtp.close();
  }
});

test('production mail drill: trusted STARTTLS authenticates before DATA; bad credentials and untrusted TLS fail closed', async () => {
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.temp/production-mail-drill-'));
  try {
    const tls = await loopbackCertificate(directory);
    for (const badAuth of [false, true]) {
      const smtp = await smtpFixture({ tls, badAuth });
      try {
        const result = await trustedSend(smtp.port, tls.caPath);
        expect(result.accepted).toBe(!badAuth);
        if (badAuth) expect(result.code).toBe('EAUTH');
        expect(
          smtp.commands
            .filter((value) => value.command.startsWith('AUTH '))
            .map((value) => value.encrypted),
        ).toEqual([true]);
        expect(smtp.messages).toHaveLength(badAuth ? 0 : 1);
        if (!badAuth) {
          expect(smtp.commands.find((value) => value.command === 'DATA')?.encrypted).toBe(true);
          expect(smtp.messages[0]).toContain('Message-ID: <mail-drill@example.test>');
          expect(smtp.messages[0]).toContain('Content-Type: multipart/alternative');
        }
      } finally {
        await smtp.close();
      }
    }
    const untrusted = await smtpFixture({ tls });
    try {
      const emptyCa = join(directory, 'empty-ca.pem');
      await writeFile(emptyCa, '');
      expect((await trustedSend(untrusted.port, emptyCa)).accepted).toBe(false);
      expect(untrusted.commands.some((value) => /^(AUTH|DATA)/.test(value.command))).toBe(false);
      expect(untrusted.messages).toHaveLength(0);
    } finally {
      await untrusted.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('production mail drill: signed hard bounce is idempotent, rejects forged/stale/altered bodies, and preserves mandatory mail', async () => {
  const store = mailStore();
  const sent: { headers?: Record<string, string> }[] = [];
  const queue = accountEmailQueue(
    store.pool,
    secret,
    async (mail) => {
      sent.push(mail);
    },
    input.url,
  );
  const api = mailSuppressionApi(store.pool, secret, eventsSecret);
  const raw = JSON.stringify({
    address: ` ${address.toUpperCase()} `,
    type: 'hard_bounce',
    source: 'provider-adapter',
    eventId: 'bounce-1',
  });
  const request = (
    body = raw,
    key = eventsSecret,
    timestamp = String(Math.floor(Date.now() / 1_000)),
    signedBody = body,
  ) =>
    api.handle(
      new Request('http://localhost/api/internal/mail-events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rezics-mail-timestamp': timestamp,
          'x-rezics-mail-signature': mailEventSignature(key, timestamp, signedBody),
        },
        body,
      }),
    );
  const digest = { ...input, purpose: 'digest' as const, message: 'One mention' };
  await queue.enqueue(digest);
  expect((await request(raw, 'forged-secret')).status).toBe(403);
  expect(
    (await request(raw, eventsSecret, String(Math.floor(Date.now() / 1_000) - 600))).status,
  ).toBe(403);
  expect(
    (
      await request(
        raw.replace('bounce-1', 'altered'),
        eventsSecret,
        String(Math.floor(Date.now() / 1_000)),
        raw,
      )
    ).status,
  ).toBe(403);
  expect(store.suppression.size).toBe(0);
  expect((await Promise.all([request(), request()])).map((response) => response.status)).toEqual([
    204, 204,
  ]);
  expect((await request()).status).toBe(204);
  expect(store.suppression.size).toBe(1);
  expect(store.suppression.get(address)).toEqual({
    reason: 'hard_bounce',
    source: 'provider-adapter:bounce-1',
  });
  expect(await optionalMailSuppressed(store.pool, address.toUpperCase())).toBe(true);
  await queue.drain();
  expect([...store.mail.values()].map((row) => row.state)).toEqual(['expired']);
  await queue.enqueue(digest);
  expect(store.mail.size).toBe(1);
  for (const purpose of ['verify', 'reset', 'change-email', 'notice'] as const)
    await queue.enqueue({ ...input, purpose, message: 'Mandatory account notice' });
  await Promise.all([queue.drain(), queue.drain()]);
  expect(sent).toHaveLength(4);
  expect(sent.every((mail) => mail.headers === undefined)).toBe(true);
  expect([...store.mail.values()].filter((row) => row.state === 'sent')).toHaveLength(4);
});

test('production mail drill: lost SMTP DATA acknowledgement is uncertain and concurrent/repeated drains never resend', async () => {
  const store = mailStore();
  const smtp = await smtpFixture({ loseDataAck: true });
  const queue = accountEmailQueue(
    store.pool,
    secret,
    smtpSender({ ...smtpConfig(smtp.port), requireTLS: false, user: '', password: '' }),
    input.url,
  );
  try {
    await queue.enqueue({ ...input, purpose: 'reset' });
    await Promise.all([queue.drain(), queue.drain()]);
    expect(smtp.messages).toHaveLength(1);
    expect(
      [...store.mail.values()].map((row) => ({ state: row.state, payload: row.payload })),
    ).toEqual([{ state: 'uncertain', payload: null }]);
    await Promise.all([queue.drain(), queue.drain()]);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.commands.filter((value) => value.command === 'DATA')).toHaveLength(1);
  } finally {
    await smtp.close();
  }
});

test('production mail drill: stale sending and lost database acknowledgement after SMTP success never resend', async () => {
  const store = mailStore();
  const sent: string[] = [];
  const queue = accountEmailQueue(
    store.pool,
    secret,
    async (mail) => {
      sent.push(mail.id);
    },
    input.url,
  );
  await queue.enqueue({ ...input, purpose: 'reset' });
  const stale = [...store.mail.values()][0]!;
  stale.state = 'sending';
  stale.startedAt = Date.now() - 180_000;
  await queue.drain();
  expect(stale.state).toBe('uncertain');
  expect(stale.payload).toBeNull();
  expect(sent).toHaveLength(0);
  await queue.enqueue({ ...input, purpose: 'verify' });
  store.loseSentAcknowledgement();
  await Promise.all([queue.drain(), queue.drain()]);
  expect(sent).toHaveLength(1);
  expect(
    [...store.mail.values()].every((row) => row.state === 'uncertain' && row.payload === null),
  ).toBe(true);
  await queue.drain();
  expect(sent).toHaveLength(1);
});
