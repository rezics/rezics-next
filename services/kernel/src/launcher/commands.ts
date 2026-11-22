import { PLATFORM_RESOURCE } from '../access/bootstrap-governance.ts';
import { authoritativeTimeValue, noEffect, runCommand, type CommandAuthorization } from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor } from '../request/access.ts';
import { launcherSearchKey, readLauncherRelease } from './catalogue.ts';
import {
  LAUNCHER_TITLE_KEY_BYTES,
  type LauncherRelease,
  type LauncherReleaseReference,
  type PublishLauncherRelease,
} from './contract.ts';
import packageReserve from './package-reserve-release.sql';
import packageWithdraw from './package-withdraw-release.sql';
import releasePublish from './release-publish.sql';
import releaseWithdraw from './release-withdraw.sql';

type CommandConfig = { pool: Pool; clock: () => Date };
type CommandContext = {
  actor: AccountActor;
  deadline: number;
  key: string;
  authorization: CommandAuthorization;
};

function commandOptions(
  config: CommandConfig,
  context: CommandContext,
  action: 'publish' | 'withdraw',
  input: unknown,
) {
  const { actor, deadline, key, authorization } = context;
  if (
    authorization.action !== `launcher:${action}` ||
    authorization.resource.id !== PLATFORM_RESOURCE.id ||
    authorization.resource.route !== PLATFORM_RESOURCE.route
  )
    throw new ProblemError('forbidden');
  const operation = `launcher.release.${action}`;
  return {
    partition: 0,
    clock: config.clock,
    deadline,
    authorization,
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    receipt: { actorAccountId: actor.accountId, kind: operation, key, digest: requestDigest(operation, actor, input) },
  };
}

function releaseEvent(action: 'published' | 'withdrawn', reference: LauncherReleaseReference) {
  return {
    type: `com.rezics.launcher.release.${action}.v1`,
    subject: PLATFORM_RESOURCE.id,
    data: reference,
  };
}

function validatePublication(packageId: string, input: PublishLauncherRelease) {
  const { package: pkg, release } = input;
  if (pkg.id !== packageId || release.packageId !== packageId || release.compatibility.kind !== pkg.kind)
    throw new ProblemError('invalid_request', {
      detail: 'Package, release and compatibility must name the same kind and package.',
    });
  const titleKey = launcherSearchKey(pkg.title);
  if (!titleKey || !pkg.publisher.trim())
    throw new ProblemError('invalid_request', { detail: 'A package needs a title and publisher.' });
  if (Buffer.byteLength(titleKey) > LAUNCHER_TITLE_KEY_BYTES)
    throw new ProblemError('invalid_request', { detail: 'The normalized package title is too large.' });
  if (pkg.kind === 'overlay-panel' && release.artifact.size > 16_384)
    throw new ProblemError('invalid_request', { detail: 'Overlay panel artifacts must fit within 16 KiB.' });
  let url: URL;
  try {
    url = new URL(release.artifact.url);
  } catch {
    throw new ProblemError('invalid_request', { detail: 'Invalid artifact URL.' });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    release.artifact.url.includes('\\') ||
    !url.hostname
  )
    throw new ProblemError('invalid_request', {
      detail: 'Use a public HTTPS artifact URL without credentials or a fragment.',
    });
  const seen = new Set<string>();
  for (const requirement of release.requires) {
    if (seen.has(requirement.packageId) || requirement.packageId === packageId)
      throw new ProblemError('invalid_request', {
        detail: 'Specify a single required release per other package.',
      });
    seen.add(requirement.packageId);
  }
  return titleKey;
}

function compatibleDependency(release: LauncherRelease, dependency: LauncherRelease | null) {
  if (!dependency || release.compatibility.kind !== dependency.compatibility.kind) return false;
  if (release.compatibility.kind === 'overlay-panel') return true;
  return (
    dependency.compatibility.kind === 'minecraft-mod' &&
    release.compatibility.gameVersion === dependency.compatibility.gameVersion &&
    release.compatibility.loader === dependency.compatibility.loader
  );
}

export function publishLauncherRelease(
  config: CommandConfig,
  context: CommandContext,
  packageId: string,
  input: PublishLauncherRelease,
) {
  const titleKey = validatePublication(packageId, input);
  const { package: pkg, release } = input;
  return runCommand(config.pool, commandOptions(config, context, 'publish', input), async (tx, { time }) => {
    // Resolve only explicitly pinned predecessors. Earlier publication prevents cycles.
    for (const requirement of release.requires) {
      const dependency = await readLauncherRelease(tx, requirement.packageId, requirement.releaseId);
      if (!compatibleDependency(release, dependency))
        throw new ProblemError('conflict', {
          detail: 'A required release is missing, has been withdrawn or is incompatible.',
        });
    }
    const reserved = await packageReserve.run(tx, {
      id: pkg.id,
      kind: pkg.kind,
      publisher: pkg.publisher,
      title: pkg.title,
      title_key: titleKey,
      summary: pkg.summary,
      subject_id: pkg.subjectId ?? null,
    });
    if (!reserved) throw new ProblemError('conflict', { detail: 'Published package metadata is immutable.' });
    const inserted = await releasePublish.run(tx, {
      package_id: packageId,
      id: release.id,
      version: release.version,
      compatibility: JSON.stringify(release.compatibility),
      artifact_url: release.artifact.url,
      artifact_size: String(release.artifact.size),
      artifact_sha256: release.artifact.sha256,
      requirements: JSON.stringify(release.requires),
      published_at: authoritativeTimeValue(time),
    });
    if (!inserted) throw new ProblemError('conflict', { detail: 'The release ID or version already exists.' });
    return { value: release, events: [releaseEvent('published', { packageId, releaseId: release.id })] };
  });
}

export function withdrawLauncherRelease(
  config: CommandConfig,
  context: CommandContext,
  reference: LauncherReleaseReference,
) {
  const { packageId, releaseId } = reference;
  return runCommand(config.pool, commandOptions(config, context, 'withdraw', reference), async (tx, { time }) => {
    const result = await releaseWithdraw.run(tx, {
      package_id: packageId,
      release_id: releaseId,
      at: authoritativeTimeValue(time),
    });
    if (!result?.present) throw new ProblemError('not_found');
    const value = { withdrawn: true as const };
    if (!result.changed) return noEffect(value);
    const reduced = await packageWithdraw.run(tx, { id: packageId });
    if (!reduced) throw new Error('Launcher package visibility counter is inconsistent');
    return { value, events: [releaseEvent('withdrawn', reference)] };
  });
}
