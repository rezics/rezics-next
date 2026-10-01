import { readFileSync } from 'node:fs';
import type { Loader } from 'astro/loaders';
import { POLICY_VERSIONS } from '../../../../services/account/src/policy-versions.ts';
import { emptyFacts, legalFacts, slotsFor, type LegalFacts } from './facts.ts';
import {
  isReleaseBuild,
  policies,
  publishedMarkdown,
  releaseProblems,
  sourceDigest,
  type AcceptedVersion,
  type PolicySlug,
} from './policies.ts';

export interface PublishedPolicy {
  slug: PolicySlug;
  source: string;
  digest: string;
  markdown: string;
  /** Marker keys still unfilled; a release build refuses any. */
  unfilled: string[];
}

/** Read the sources in `directory`, fill them from `facts` and list what a release would refuse. */
export function readPolicies(
  directory: URL,
  facts: LegalFacts = legalFacts,
  accepted: readonly AcceptedVersion[] = POLICY_VERSIONS,
): { published: PublishedPolicy[]; problems: string[] } {
  const slots = slotsFor(facts);
  const published = policies.map(({ slug, source }) => {
    const text = readFileSync(new URL(source, directory), 'utf8');
    const { markdown, unfilled } = publishedMarkdown(slug, text, slots);
    return { slug, source: `docs/legal/${source}`, digest: sourceDigest(text), markdown, unfilled };
  });
  const problems = releaseProblems({
    unfilled: published.map(({ slug, unfilled }) => ({ slug, keys: unfilled })),
    emptyFacts: emptyFacts(facts),
    digests: published,
    accepted,
  });
  return { published, problems };
}

/**
 * The policies as a content collection. A release build throws when the facts
 * are incomplete or a source no longer matches the digest sign-up records;
 * a development build renders them under a "draft, not in force" banner.
 */
export function legalLoader(): Loader {
  return {
    name: 'rezics-legal',
    async load({ config, store, renderMarkdown, logger }) {
      const { published, problems } = readPolicies(new URL('../../docs/legal/', config.root));
      const release = isReleaseBuild();
      if (release && problems.length) {
        throw new Error(
          `Release build refused: ${problems.length} legal problem(s):\n- ${problems.join('\n- ')}`,
        );
      }
      if (problems.length)
        logger.warn(`${problems.length} legal problem(s); this build is a draft.`);
      store.clear();
      for (const policy of published) {
        store.set({
          id: policy.slug,
          data: {
            slug: policy.slug,
            source: policy.source,
            digest: policy.digest,
            draft: !release,
          },
          body: policy.markdown,
          rendered: await renderMarkdown(policy.markdown),
          digest: sourceDigest(`${policy.digest}\n${policy.markdown}\n${release}`),
        });
      }
    },
  };
}
