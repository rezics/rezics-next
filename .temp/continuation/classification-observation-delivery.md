---
{
  'goal': 'imports',
  'manager': 'imports',
  'kind': 'implementation',
  'paths':
    [
      'services/importer/src/source-classification*.ts',
      'services/importer/src/source-observation*.ts',
      'services/importer/src/import-contract.ts',
      'services/importer/src/import-client.ts',
      'services/importer/src/importer.ts',
      'services/importer/src/run-store.ts',
      'services/importer/src/source-registry.ts',
      'services/importer/src/cli.ts',
      'services/importer/src/record-bindings.ts',
      'services/importer/src/inspection-store.ts',
      'services/importer/src/binding-inspection-store.ts',
      'services/importer/src/import-progress.ts',
      'services/importer/src/state-backup-schema.ts',
      'packages/conversion/src/source-classification.ts',
      'packages/conversion/src/support.ts',
      'packages/conversion/src/index.ts',
      'services/importer/tests/source-classification*.test.ts',
      'services/importer/tests/source-observation*.test.ts',
      'services/importer/tests/import-client.test.ts',
      'services/kernel/test/imports/source-classification*.ts',
      'services/kernel/test/imports/api-runtime.ts',
      'services/importer/README.md',
    ],
  'riskAreas': [],
  'criticalPath': false,
  'waiting': [],
  'estimate': { 'lines': 2400, 'files': 27 },
  'after': ['f0e8f3e9-17ae-4f3f-b91b-6cdb8f8a70e7', '9d57beb9-94ea-447a-9878-5227d4942189'],
  'acceptance':
    {
      'tests':
        [
          'Import an admitted classification observation through the production converter/coordinator and mounted generated native client; bind the authentic Semantic association, preserve separate provenance/native ballots, recover unknown delivery and deliberate CAS resolution with immutable original intent, and independently read the result. Unadmitted VNDB payload/licence combinations have zero native effects.',
        ],
    },
}
---

# Continue classification observation import and delivery

The partial change adds a bounded, validated conversion projection for classification values and their provenance. Continue by carrying trusted converter output through importer staging, binding it to authentic Semantic association outcomes, and persisting one immutable classification operation in the existing aggregate journal. Add the operator review, independent head read, deliberate CAS resolution, sealed retry, snapshot retention and bounded CLI inspection described in the original imports brief.

The current base has the internal classification producer and mounted Kernel routes, but `packages/client` has no generated classification methods or DTO declarations. Use the Content owner’s delivered generated contract when it lands; the route handoff and reached native outcomes remain unproven. Keep public VNDB fields unavailable until the reviewed payload and rights admission exists. Use authored, truthfully attributed fixtures to prove consumer behaviour without describing them as VNDB data. Complete the original CLI, recovery, backup, binding-inspection, retention and mounted-native acceptance before closing this continuation.
