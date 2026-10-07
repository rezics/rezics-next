import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { commandProfiles } from '../../compiler/generate.ts';
import type { ProfileDefinition } from '../../compiler/ir.ts';
import { parseTurtleProfile, type TurtleDeclaration } from '../../compiler/shacl.ts';

export const registryProbeDirectory = resolve(import.meta.dir,
  '../../../infra/jena/command-module/src/test/resources/registry-probe');

const registryProbeDeclaration = {
  id: 'registry-probe-v1',
  canonical: {
    item: { types: ['rv:RegistryProbe'] },
    'sealed-item': { types: ['rv:RegistryProbe'], when: [{ path: 'rv:probeState', value: 'rv:Sealed' }] },
    record: { types: ['rv:RegistryProbeRecord'] },
  },
  binding: {
    required: ['item', 'record', 'label'], optional: ['note'], roles: ['item', 'record'],
    demandedBy: ['rv:RegistryProbeRecord'],
  },
} satisfies TurtleDeclaration;

/**
 * The command module's retained exact Turtle fixture is the author. Only its
 * registry metadata lives here; no module code names this synthetic profile.
 */
export const registryProbeProfile = parseTurtleProfile(registryProbeDeclaration.id,
  readFileSync(join(registryProbeDirectory, 'shapes/registry-probe-v1.ttl'), 'utf8'),
  registryProbeDeclaration) as ProfileDefinition & { binding: typeof registryProbeDeclaration.binding };

/** The probe's command-module profile directory, relative to that directory. */
export function registryProbeFiles(): Map<string, string> {
  const command = commandProfiles([registryProbeProfile],
    { canonicalOrder: [], demandOrder: [] });
  return new Map([...command.shapes, ['manifest.json', `${JSON.stringify(command.manifest, null, 2)}\n`]]);
}

if (import.meta.main) {
  for (const [file, content] of registryProbeFiles()) {
    const path = join(registryProbeDirectory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
