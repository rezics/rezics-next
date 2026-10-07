import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const ballotProxyDeclaration = {
  id: 'ballot-proxy-v1',
  canonical: {
    route: { types: ['rv:ProxyRoute'] },
    revision: { types: ['rv:ProxyRouteRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const ballotProxyProfile = parseTurtleProfile(
  ballotProxyDeclaration.id,
  readFileSync(new URL('./ballot-proxy-v1.ttl', import.meta.url), 'utf8'),
  ballotProxyDeclaration,
);
