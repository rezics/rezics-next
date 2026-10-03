import type { Discovery } from '../manage/settings-api.ts';

/** G-943 must apply these to its route response as well as mounting SpaceDiscovery. */
export function spaceDiscoveryHeaders(discovery: Discovery): Record<string, string> {
  return { ...discovery.robots === 'noindex' ? { 'X-Robots-Tag': 'noindex' } : {},
    ...discovery.referrerPolicy ? { 'Referrer-Policy': discovery.referrerPolicy } : {} };
}

/** React hoists the document policy when Main asks for it, including client transitions. */
export function SpaceDiscovery({ discovery }: { discovery: Discovery }) {
  return <>
    {discovery.robots === 'noindex' ? <meta name="robots" content="noindex" /> : null}
    {discovery.referrerPolicy ? <meta name="referrer" content={discovery.referrerPolicy} /> : null}
  </>;
}
