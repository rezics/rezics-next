import { createHash } from 'node:crypto';

/**
 * The policies the site publishes, rendered from `docs/legal/*.md` (no copies).
 * `terms` and `privacy` are the two a person accepts at sign-up; their source
 * digests must equal `services/account/src/policy-versions.ts`.
 */
export const policies = [
  { slug: 'terms', source: 'terms-of-service.md' },
  { slug: 'privacy', source: 'privacy-policy.md' },
  { slug: 'acceptable-use', source: 'acceptable-use-policy.md' },
  { slug: 'content-ratings-and-age', source: 'content-ratings-and-age-policy.md' },
  { slug: 'ai', source: 'ai-policy.md' },
  { slug: 'copyright-and-dmca', source: 'copyright-and-dmca-policy.md' },
  { slug: 'ncii', source: 'ncii-takedown-policy.md' },
  { slug: 'child-safety', source: 'child-safety-policy.md' },
  { slug: 'api-and-agent', source: 'api-and-agent-terms.md' },
] as const;
export type PolicySlug = (typeof policies)[number]['slug'];

/** A marker the maintainer must replace with a fact: `[REZICS TO FILL: <description>]`. */
const markerPattern = /\[REZICS TO FILL(?::\s*([^\]]*))?\]/g;
const repository = 'https://github.com/rezics/rezics-next/blob/main/docs/';

export interface Marker {
  /** The description, or `@<label>` for a bare marker (the label is the text before it). */
  key: string;
  text: string;
}

/** The text before a bare marker on its line, or a table row's first cell. */
function labelBefore(line: string, index: number): string {
  if (line.startsWith('|')) return (line.split('|')[1] ?? '').trim();
  return line
    .slice(0, index)
    .replace(/[:\s]+$/, '')
    .trim();
}

export function markersIn(source: string): Marker[] {
  const found: Marker[] = [];
  for (const line of source.split('\n')) {
    for (const match of line.matchAll(markerPattern)) {
      const description = match[1]?.trim();
      found.push({
        key: description ? description : `@${labelBefore(line, match.index)}`,
        text: match[0],
      });
    }
  }
  return found;
}

export function sourceDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/** What a release must not carry: the facts file has to supply a value for each of these. */
export interface FactSlots {
  /** Value for a marker key in one policy, or '' when the maintainer has not supplied it. */
  fill(key: string, policy: PolicySlug): string;
}

/**
 * The published Markdown for one source: markers replaced by facts, section
 * lines (`**1. Title**`) made headings, the repeated title line dropped and
 * links between drafts pointed at their pages (`/legal/<slug>/`, localized by the page).
 * An unfilled marker stays visible and is wrapped so a draft build can show it.
 */
export function publishedMarkdown(
  slug: PolicySlug,
  source: string,
  slots: FactSlots,
): { markdown: string; unfilled: string[] } {
  const unfilled: string[] = [];
  const bySource = new Map<string, PolicySlug>(policies.map((p) => [p.source, p.slug]));
  const lines = source.split('\n');
  const titleIndex = lines.findIndex((line, i) => i > 0 && /^REZICS .+/.test(line));
  const body = lines
    .filter((_, i) => i !== titleIndex)
    .map((line) => {
      let next = line.replace(/^\*\*(\d+\.\s.+)\*\*$/, '## $1');
      // Fill by position in the line so a bare marker keeps its own label.
      next = next.replace(
        markerPattern,
        (text, description: string | undefined, offset: number) => {
          const key = description?.trim() ? description.trim() : `@${labelBefore(next, offset)}`;
          const value = slots.fill(key, slug).trim();
          if (value) return value;
          unfilled.push(key);
          return `<mark data-unfilled>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</mark>`;
        },
      );
      return next.replace(/\]\(([^):#]+\.md)(#[^)]*)?\)/g, (_all, file: string, hash = '') => {
        const sibling = bySource.get(file);
        if (sibling) return `](/legal/${sibling}/${hash})`;
        const target = new URL(file, 'https://x/docs/legal/').pathname.replace(/^\/docs\//, '');
        return `](${repository}${target}${hash})`;
      });
    });
  return { markdown: body.join('\n'), unfilled };
}

export interface AcceptedVersion {
  policyId: string;
  source: string;
  versionDigest: string;
}

/**
 * Why a release build must fail: markers left in a source, facts that are
 * empty, or a source whose digest differs from the digest sign-up records.
 */
export function releaseProblems(input: {
  unfilled: { slug: PolicySlug; keys: string[] }[];
  emptyFacts: string[];
  digests: { slug: PolicySlug; source: string; digest: string }[];
  accepted: readonly AcceptedVersion[];
}): string[] {
  const problems: string[] = [];
  for (const { slug, keys } of input.unfilled) {
    for (const key of new Set(keys))
      problems.push(`${slug}: [REZICS TO FILL] marker has no fact: ${key}`);
  }
  for (const path of input.emptyFacts) problems.push(`legal facts: ${path} is empty`);
  for (const version of input.accepted) {
    const found = input.digests.find((d) => d.source === version.source);
    if (!found) problems.push(`${version.policyId}: ${version.source} is not published`);
    else if (found.digest !== version.versionDigest) {
      problems.push(
        `${version.policyId}: source digest ${found.digest} differs from services/account/src/policy-versions.ts (${version.versionDigest})`,
      );
    }
  }
  return problems;
}

/** `task about:build -- --release` (or `ABOUT_RELEASE=1`) builds what may be published. */
export function isReleaseBuild(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return argv.includes('--release') || env.ABOUT_RELEASE === '1';
}
