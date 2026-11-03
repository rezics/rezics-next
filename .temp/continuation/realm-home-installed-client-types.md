---
{
  "goal": "content",
  "manager": "content",
  "kind": "claim",
  "paths": [
    "packages/client/src/kernel/community/routes.d.ts",
    "packages/client/src/index.ts",
    "apps/web/src/community/realm-home-native.ts",
    "apps/web/tests/realm-home-native-visit.test.tsx",
    "services/kernel/src/community/README.md"
  ],
  "riskAreas": [
    "authorization",
    "disclosure",
    "rights",
    "deletion",
    "account"
  ],
  "criticalPath": false,
  "waiting": [],
  "after": [
    "29aeb54f-be93-4112-8c92-73301b263e72",
    "70cd2a89-afd1-437c-ba19-d9ebe380cc19",
    "29d1ca61-bc34-463a-a1d3-5d70ca19409d"
  ],
  "estimate": {
    "lines": 80,
    "files": 5
  },
  "inseparable": true,
  "acceptance": [
    "The installed KernelClient exposes the mounted home, boardShelf and publicationShelf methods and response DTOs from supported generated declarations.",
    "The Community Web receiver removes its local DTO and route seam and binds the installed methods directly while retaining current native membership, authority, source and media checks.",
    "The focused receiver test and apps/web typecheck pass with the installed declaration surface."
  ]
}
---

# Finish installed Realm Home client typing

The existing receiver now uses a narrow local DTO and route seam because the checked-in KernelClient declaration is missing the mounted Home and shelf methods. Deliver the shared generated route and root-export surface, then replace the seam with the installed route types. Preserve the existing mounted reader, UI, source binding, membership commands, retry behavior and receiver tests. Do not introduce another reader or writer.
