import { t } from 'elysia';
import type { Static, TSchema } from 'typebox';

const closed = { additionalProperties: false } as const;
const end = '(?![\\s\\S])';
const printable = `^[^\\u0000-\\u001f\\u007f]*${end}`;
const version = t.String({ minLength: 1, maxLength: 128, pattern: printable });
export const LAUNCHER_PAGE_SIZE = 25;
export const LAUNCHER_REQUIRED_RELEASE_LIMIT = 16;
export const LAUNCHER_TITLE_KEY_BYTES = 1024;
export const LAUNCHER_ARTIFACT_MAX_BYTES = 2 * 1024 ** 3;
export const PACKAGE_ID_PATTERN = `^[a-z0-9][a-z0-9-]{0,62}\\.[a-z0-9][a-z0-9._-]{0,95}${end}`;
export const RELEASE_ID_PATTERN = `^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}${end}`;
export const packageId = t.String({ pattern: PACKAGE_ID_PATTERN, maxLength: 160 });
export const releaseId = t.String({ pattern: RELEASE_ID_PATTERN, maxLength: 128 });
export const packageKind = t.Union([t.Literal('overlay-panel'), t.Literal('minecraft-mod')]);
export const subjectId = t.String({ pattern: `^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}${end}` });

export const cataloguePackage = t.Object(
  {
    id: packageId,
    kind: packageKind,
    publisher: t.String({ minLength: 1, maxLength: 120, pattern: printable }),
    title: t.String({ minLength: 1, maxLength: 160, pattern: printable }),
    summary: t.String({ maxLength: 1000, pattern: printable }),
    subjectId: t.Optional(subjectId),
  },
  closed,
);

const compatibility = t.Union([
  t.Object(
    {
      kind: t.Literal('overlay-panel'),
      launcherRange: version,
    },
    closed,
  ),
  t.Object(
    {
      kind: t.Literal('minecraft-mod'),
      gameVersion: version,
      loader: t.Literal('fabric'),
    },
    closed,
  ),
]);

export const releaseReference = t.Object({ packageId, releaseId }, closed);
export const catalogueRelease = t.Object(
  {
    packageId,
    id: releaseId,
    version,
    compatibility,
    artifact: t.Object(
      {
        url: t.String({ minLength: 9, maxLength: 2048, pattern: `^https://[^\\u0000-\\u0020\\u007f]+${end}` }),
        size: t.Integer({ minimum: 1, maximum: LAUNCHER_ARTIFACT_MAX_BYTES }),
        sha256: t.String({ pattern: `^[a-f0-9]{64}${end}` }),
      },
      closed,
    ),
    requires: t.Array(releaseReference, { maxItems: LAUNCHER_REQUIRED_RELEASE_LIMIT }),
  },
  closed,
);

export const publishedRelease = t.Object({ package: cataloguePackage, release: catalogueRelease }, closed);
const cursor = t.Optional(t.String({ minLength: 1, maxLength: 4096 }));
export const packageQuery = t.Object(
  { kind: packageKind, q: t.Optional(t.String({ maxLength: 160, pattern: printable })), cursor },
  closed,
);
export const releaseQuery = t.Object({ cursor }, closed);

export function cataloguePage<T extends TSchema>(item: T) {
  return t.Object(
    { items: t.Array(item, { maxItems: LAUNCHER_PAGE_SIZE }), nextCursor: t.Union([t.String(), t.Null()]) },
    closed,
  );
}

export type LauncherPackage = Static<typeof cataloguePackage>;
export type LauncherRelease = Static<typeof catalogueRelease>;
export type LauncherReleaseReference = Static<typeof releaseReference>;
export type PublishLauncherRelease = Static<typeof publishedRelease>;
