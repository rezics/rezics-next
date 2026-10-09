import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { mechanismMapErrors, mechanisms, type Mechanism } from './mechanisms.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the mechanism map has one owner per concept and resolvable entry points', () => {
  expect(mechanismMapErrors(mechanisms, root)).toEqual([]);
  expect(mechanisms.map(entry => entry.id)).toEqual([
    'rights-evaluation', 'governance-restriction', 'language-parsing', 'access-authority',
  ]);
});

test('a duplicate id or owner, an unresolved entry point, or an empty selector fails', () => {
  const [rights, governance, language] = mechanisms;
  const broken = (patch: Partial<Mechanism>, index = 0): Mechanism[] => mechanisms.map((entry, at) =>
    at === index ? { ...entry, ...patch } : entry);
  expect(mechanismMapErrors([...mechanisms, { ...rights!, id: 'rights-again' }], root))
    .toContain('duplicate mechanism owner: services/main/src/modules/rights');
  expect(mechanismMapErrors([...mechanisms, { ...governance!, id: rights!.id, owner: 'services/main/src/modules/other' }], root))
    .toContain('duplicate mechanism id: rights-evaluation');
  expect(mechanismMapErrors(broken({ entryPoints: ['store.ts#missingExport'] }), root))
    .toContain('rights-evaluation: entry point does not resolve: store.ts#missingExport');
  expect(mechanismMapErrors(broken({ entryPoints: [] }), root)).toContain('rights-evaluation: empty selector entryPoints');
  expect(mechanismMapErrors(broken({ ownedState: [''] }, 1), root))
    .toContain('governance-restriction: empty selector in ownedState');
  expect(mechanismMapErrors(broken({ conformanceTests: [] }, 2), root))
    .toContain('language-parsing: empty selector conformanceTests');
  expect(mechanismMapErrors(broken({ protectedEffects: [] }), root))
    .toContain('rights-evaluation: empty selector protectedEffects');
  expect(language!.owner).toBe('services/main/src/modules/display-language');
});
