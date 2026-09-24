// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const classificationContextFixture = {
  "id": "classification-context-v1",
  "sha256": "41aa65a8f1f780d5902b858a8e9238d7e932afc88add4b23d731c51cfcd0bd20",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-context-v1/global-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
        }
      ]
    },
    "missing-context-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-context-v1/global-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
        }
      ]
    },
    "wrong-realm-link": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000013> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
      },
      "expected": false,
      "pathHint": "rv:classificationContext",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-context-v1/global-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
        }
      ]
    },
    "wrong-inheritance-policy": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
      },
      "expected": false,
      "pathHint": "rv:inheritancePolicy",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-context-v1/global-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
        }
      ]
    },
    "wrong-fallback": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000013> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
      },
      "expected": false,
      "pathHint": "rv:fallbackContext",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-context-v1/global-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
        }
      ]
    },
    "global-fallback-cycle": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> ; rv:fallbackContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
      },
      "expected": false,
      "pathHint": "rv:fallbackContext",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-context-v1/global-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011"
        },
        {
          "shape": "https://rezics.com/definition/classification-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
