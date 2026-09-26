import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { commandProfiles } from '../../compiler/generate.ts';
import type { ProfileDefinition } from '../../compiler/ir.ts';

/**
 * A synthetic profile that reaches the command module through the generated
 * registry alone: canonical types, a discriminated shape and a binding demand,
 * with no module code naming it. It is never shipped in the image.
 */
export const registryProbeProfile = {
  id: 'registry-probe-v1',
  comments: ['Synthetic profile proving registry-only command routing; test fixture only.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/registry-probe-v1/item-shape',
      canonical: { types: ['rv:RegistryProbe'] },
      properties: [{ path: 'rv:probeLabel', minCount: 1, maxCount: 1, datatype: 'xsd:string' }],
    },
    {
      iri: 'https://rezics.com/definition/registry-probe-v1/sealed-item-shape',
      canonical: { types: ['rv:RegistryProbe'], when: [{ path: 'rv:probeState', value: 'rv:Sealed' }] },
      properties: [
        { path: 'rv:probeLabel', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sealedBy', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/registry-probe-v1/record-shape',
      canonical: { types: ['rv:RegistryProbeRecord'] },
      properties: [{ path: 'rv:item', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' }],
    },
  ],
  binding: {
    required: ['item', 'record', 'label'], optional: ['note'], roles: ['item', 'record'],
    demandedBy: ['rv:RegistryProbeRecord'],
  },
} satisfies ProfileDefinition;

export const registryProbeDirectory = resolve(import.meta.dir,
  '../../../infra/jena/command-module/src/test/resources/registry-probe');

/** The probe's command-module profile directory, relative to that directory. */
export function registryProbeFiles(): Map<string, string> {
  const command = commandProfiles([registryProbeProfile],
    { established: {}, canonicalOrder: [], demandOrder: [] });
  return new Map([...command.shapes, ['manifest.json', `${JSON.stringify(command.manifest, null, 2)}\n`]]);
}

if (import.meta.main) {
  for (const [file, content] of registryProbeFiles()) {
    const path = join(registryProbeDirectory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
