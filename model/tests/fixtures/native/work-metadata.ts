// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const workMetadataFixture = {
  "id": "work-metadata-v1",
  "sha256": "ac918cf0458150520bf03f9683e6a363ad702376ebc50eaa729f98d84b3b8760",
  "cases": {
    "valid": {
      "turtle": "@prefix schema: <https://schema.org/> .\n@prefix rv: <https://rezics.com/vocab/> .\n@prefix ex: <https://example.org/rezics-test/> .\n\nex:work a schema:CreativeWork ;\n    rv:mainVersion ex:main ;\n    rv:continuityProfile ex:continuity-v1 .\n\nex:main a rv:MainVersion ;\n    rv:work ex:work ;\n    rv:hostingPolicy rv:MetadataOnly .\n",
      "args": {
        "work": "https://example.org/rezics-test/work",
        "main": "https://example.org/rezics-test/main"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/work-metadata-v1/work-shape",
          "focus": "https://example.org/rezics-test/work"
        },
        {
          "shape": "https://rezics.com/definition/work-metadata-v1/main-version-shape",
          "focus": "https://example.org/rezics-test/main"
        }
      ]
    },
    "missing-type": {
      "turtle": "@prefix schema: <https://schema.org/> .\n@prefix rv: <https://rezics.com/vocab/> .\n@prefix ex: <https://example.org/rezics-test/> .\n\n# Removing the selected Work type must not bypass its required shape.\nex:work rv:mainVersion ex:main ;\n    rv:continuityProfile ex:continuity-v1 .\n\nex:main a rv:MainVersion ;\n    rv:work ex:work ;\n    rv:hostingPolicy rv:MetadataOnly .\n",
      "args": {
        "work": "https://example.org/rezics-test/work",
        "main": "https://example.org/rezics-test/main"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/work-metadata-v1/work-shape",
          "focus": "https://example.org/rezics-test/work"
        },
        {
          "shape": "https://rezics.com/definition/work-metadata-v1/main-version-shape",
          "focus": "https://example.org/rezics-test/main"
        }
      ]
    },
    "scalar-valid": {
      "turtle": "@prefix schema: <https://schema.org/> .\n@prefix rv: <https://rezics.com/vocab/> .\n@prefix ex: <https://example.org/rezics-test/> .\n\nex:work a schema:CreativeWork ; rv:mainVersion ex:main ; rv:continuityProfile ex:continuity-v1 ; rv:scalarValue rv:ExplicitNoValue .\nex:main a rv:MainVersion ; rv:work ex:work ; rv:hostingPolicy rv:MetadataOnly .\n",
      "args": { "work": "https://example.org/rezics-test/work", "main": "https://example.org/rezics-test/main" },
      "expected": true, "pathHint": null,
      "focus": [
        { "shape": "https://rezics.com/definition/work-metadata-v1/work-shape", "focus": "https://example.org/rezics-test/work" },
        { "shape": "https://rezics.com/definition/work-metadata-v1/main-version-shape", "focus": "https://example.org/rezics-test/main" }
      ]
    },
    "scalar-blank-node": {
      "turtle": "@prefix schema: <https://schema.org/> .\n@prefix rv: <https://rezics.com/vocab/> .\n@prefix ex: <https://example.org/rezics-test/> .\n\nex:work a schema:CreativeWork ; rv:mainVersion ex:main ; rv:continuityProfile ex:continuity-v1 ; rv:scalarValue [ a rv:Unsupported ] .\nex:main a rv:MainVersion ; rv:work ex:work ; rv:hostingPolicy rv:MetadataOnly .\n",
      "args": { "work": "https://example.org/rezics-test/work", "main": "https://example.org/rezics-test/main" },
      "expected": false, "pathHint": "rv:scalarValue",
      "focus": [
        { "shape": "https://rezics.com/definition/work-metadata-v1/work-shape", "focus": "https://example.org/rezics-test/work" },
        { "shape": "https://rezics.com/definition/work-metadata-v1/main-version-shape", "focus": "https://example.org/rezics-test/main" }
      ]
    },
    "scalar-multiple": {
      "turtle": "@prefix schema: <https://schema.org/> .\n@prefix rv: <https://rezics.com/vocab/> .\n@prefix ex: <https://example.org/rezics-test/> .\n\nex:work a schema:CreativeWork ; rv:mainVersion ex:main ; rv:continuityProfile ex:continuity-v1 ; rv:scalarValue rv:ExplicitUnknown, rv:ExplicitNoValue .\nex:main a rv:MainVersion ; rv:work ex:work ; rv:hostingPolicy rv:MetadataOnly .\n",
      "args": { "work": "https://example.org/rezics-test/work", "main": "https://example.org/rezics-test/main" },
      "expected": false, "pathHint": "rv:scalarValue",
      "focus": [
        { "shape": "https://rezics.com/definition/work-metadata-v1/work-shape", "focus": "https://example.org/rezics-test/work" },
        { "shape": "https://rezics.com/definition/work-metadata-v1/main-version-shape", "focus": "https://example.org/rezics-test/main" }
      ]
    },
    "missing-main": {
      "turtle": "@prefix schema: <https://schema.org/> .\n@prefix rv: <https://rezics.com/vocab/> .\n@prefix ex: <https://example.org/rezics-test/> .\n\nex:work a schema:CreativeWork ;\n    rv:continuityProfile ex:continuity-v1 .\n\nex:main a rv:MainVersion ;\n    rv:work ex:work ;\n    rv:hostingPolicy rv:MetadataOnly .\n",
      "args": {
        "work": "https://example.org/rezics-test/work",
        "main": "https://example.org/rezics-test/main"
      },
      "expected": false,
      "pathHint": "rv:mainVersion",
      "focus": [
        {
          "shape": "https://rezics.com/definition/work-metadata-v1/work-shape",
          "focus": "https://example.org/rezics-test/work"
        },
        {
          "shape": "https://rezics.com/definition/work-metadata-v1/main-version-shape",
          "focus": "https://example.org/rezics-test/main"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
