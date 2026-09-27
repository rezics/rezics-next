import type { CaseDeclarations } from './declaration.ts';

const unit = 'tests/qa/unit/mod-profiles.test.ts';
const api = { tier: 'integration' as const, file: 'tests/qa/integration/mod-capture-api.test.ts',
  name: 'PKG07/PKG08/PKG09/PKG10/PKG11/IAM10: real Account, Access, Main and Content protect mod capture receipts' };
const named = (name: string) => ({ tier: 'unit' as const, file: unit, name });

/** PKG09-PKG11 relation-modeling declarations live in pkg-mod-providers.ts. */
export const pkgModsCases: CaseDeclarations = {
  PKG07: [api,
    named('PKG07: native Fabric side filtering and declared nested child'),
    named('PKG07: Fabric conflicts warn while breaks fail'),
    named('PKG07: Fabric provided IDs and alternative ranges follow native resolver limits'),
    named('PKG07/PKG08/PKG09/PKG10/PKG11: bad digest and duplicate identities cannot create a solved outcome'),
    named('PKG07/PKG08/PKG09/PKG10/PKG11: bounded counters grow with captures and relations only')],
  PKG08: [api,
    named('PKG08: native feature side and NeoForge conditional mixin semantics'),
    named('PKG08: optional loader dependency is hard when an installed version is outside range'),
    named('PKG08: Forge/NeoForge keep different fields, sides, ranges and ordering cycles'),
    named('PKG07/PKG08/PKG09/PKG10/PKG11: bad digest and duplicate identities cannot create a solved outcome'),
    named('PKG07/PKG08/PKG09/PKG10/PKG11: bounded counters grow with captures and relations only')],
};
