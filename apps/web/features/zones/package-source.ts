import type { ZonePackage } from '@rezics/zone-sdk';
import type { ZoneData } from '../wiki/selection.ts';
import { declaringSlug, type Execution } from './execution.ts';

/** Where an official package's code and its plain-data declarations come from. */
export interface PackageSource {
  /** Imports the package's code; only for a view that runs it. */
  load(slug: string): Promise<ZonePackage | null>;
  /** Reads what the package declares without importing its code. */
  declarations(slug: string): Promise<ZoneData | null>;
}

type Approval = Parameters<typeof declaringSlug>[0];

/**
 * The package a view runs and the data it follows. Presentation off (safe mode, the standard look) imports no
 * package code; the reader's position and continuity still follow what the approved package declares. A community
 * surface runs and follows nothing.
 */
export async function resolvePackage({ decided, approval, surface, source }: {
  decided: Execution;
  approval: Approval;
  surface: 'community' | 'site';
  source: PackageSource;
}): Promise<{ execution: Execution; pkg: ZonePackage | null; data: ZoneData | null }> {
  if (surface !== 'site') return { execution: { mode: 'fallback', reason: 'none-approved' }, pkg: null, data: null };
  if (decided.mode === 'package') {
    try {
      const pkg = await source.load(decided.slug);
      if (pkg) return { execution: decided, pkg, data: pkg };
    } catch (error) {
      console.error(`Official Zone package ${decided.slug} failed to load; showing its fallback`, error);
    }
    return { execution: { mode: 'fallback', reason: 'load-failed' }, pkg: null, data: null };
  }
  const slug = declaringSlug(approval);
  try {
    return { execution: decided, pkg: null, data: slug ? await source.declarations(slug) : null };
  } catch (error) {
    console.error(`Official Zone package ${slug} declarations failed to load; its positions are not offered`, error);
    return { execution: decided, pkg: null, data: null };
  }
}
