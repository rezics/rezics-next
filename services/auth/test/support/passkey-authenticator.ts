import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
const issuer = 'https://auth.rezics.com';
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest();
const encode = (data: Buffer | string) => Buffer.from(data).toString('base64url');

// Small CBOR encoder for a none attestation and a P-256 COSE public key.
function cbor(value: string | number | Buffer | Map<unknown, unknown>): Buffer {
  const header = (major: number, n: number) =>
    n < 24
      ? Buffer.from([major * 32 + n])
      : n < 256
        ? Buffer.from([major * 32 + 24, n])
        : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
  if (typeof value === 'number') return value >= 0 ? header(0, value) : header(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([header(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value]);
  return Buffer.concat([
    header(5, value.size),
    ...[...value].flatMap(([k, v]) => [cbor(k as never), cbor(v as never)]),
  ]);
}

/** Software resident authenticator: none attestation, real ES256 assertions. */
export function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  let counter = 0;
  let userHandle: string;
  const clientData = (type: string, challenge: string, origin = issuer) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: encode(id),
    registration(options: { challenge: string; user: { id: string } }, uv = true, origin = issuer) {
      userHandle = options.user.id;
      const cose = cbor(
        new Map<unknown, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, 'base64url')],
          [-3, Buffer.from(jwk.y!, 'base64url')],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        hash('rezics.com'),
        Buffer.from([uv ? 0x45 : 0x41]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      return {
        id: encode(id),
        rawId: encode(id),
        type: 'public-key' as const,
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: encode(clientData('webauthn.create', options.challenge, origin)),
          attestationObject: encode(
            cbor(
              new Map<unknown, unknown>([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', authData],
              ]),
            ),
          ),
          transports: ['internal'],
        },
      };
    },
    assertion(options: { challenge: string }, uv = true, origin = issuer) {
      const client = clientData('webauthn.get', options.challenge, origin);
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const data = Buffer.concat([hash('rezics.com'), Buffer.from([uv ? 5 : 1]), count]);
      return {
        id: encode(id),
        rawId: encode(id),
        type: 'public-key' as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: encode(client),
          authenticatorData: encode(data),
          signature: encode(sign('sha256', Buffer.concat([data, hash(client)]), pair.privateKey)),
          userHandle,
        },
      };
    },
  };
}
