import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { workMetadataProfile } from '../definitions/work-metadata-v1.ts';

test('MODEL17: compiler rejects unsupported executable and unreviewed shape terms', () => {
  const shape = workMetadataProfile.shapes[0]!;
  const property = shape.properties[0]!;
  expect(renderProfile(workMetadataProfile)).toContain('sh:NodeShape');
  expect(() => renderProfile({ ...workMetadataProfile, shapes: [] }))
    .toThrow('distinct named NodeShapes');
  expect(() => renderProfile({ ...workMetadataProfile, shapes: [{ ...shape,
    properties: [{ ...property, js: 'return true' }] }] }))
    .toThrow('Unsupported profile field js');
  expect(() => renderProfile({ ...workMetadataProfile, shapes: [{ ...shape,
    sparql: 'SELECT ?this WHERE {}' }] }))
    .toThrow('Unsupported profile field sparql');
  expect(() => renderProfile({ ...workMetadataProfile,
    script: 'https://example.org/unreviewed-validator' }))
    .toThrow('Unsupported profile field script');
});

test('MODEL13: authored profiles cannot confuse resource, vocabulary or Schema.org namespaces', () => {
  const prefixes = workMetadataProfile.prefixes;
  expect(() => renderProfile({ ...workMetadataProfile,
    prefixes: [...prefixes, ['rv', 'https://rezics.com/id/']],
  })).toThrow('duplicate prefixes');
  expect(() => renderProfile({ ...workMetadataProfile,
    prefixes: prefixes.map(([name, iri]) => [name, name === 'rv' ? 'https://rezics.com/id/' : iri]),
  })).toThrow('binds rv');
  expect(() => renderProfile({ ...workMetadataProfile,
    prefixes: prefixes.map(([name, iri]) => [name, name === 'schema' ? 'http://schema.org/' : iri]),
  })).toThrow('binds schema');
  expect(() => renderProfile({ ...workMetadataProfile,
    prefixes: [...prefixes, ['rezics', 'https://rezics.com/vocab/']],
  })).toThrow('binds rezics');
});
