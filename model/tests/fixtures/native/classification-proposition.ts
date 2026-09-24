// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const classificationPropositionFixture = {
  "id": "classification-proposition-v1",
  "sha256": "8bc799783d7d2c43da737b01d2b1f10bba4dc643716f1ac09524d1ef0e86dbd0",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a skos:ConceptScheme ; rv:schemeState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a skos:Concept ; skos:inScheme <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; skos:prefLabel \"Mystery\"@en ; rv:conceptState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ConceptPath ; rv:pathKind rv:SingleConcept ; rv:pathLength 1 ; rv:terminalConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:pathState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> a rv:ClassificationExpression ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:expressionState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:ClassificationSense ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:expression <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:senseState rv:Active .\n",
      "args": {
        "scheme": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "concept": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "path": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "expression": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/scheme-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/concept-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/path-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/expression-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "missing-path-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a skos:ConceptScheme ; rv:schemeState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a skos:Concept ; skos:inScheme <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; skos:prefLabel \"Mystery\"@en ; rv:conceptState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> rv:pathKind rv:SingleConcept ; rv:pathLength 1 ; rv:terminalConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:pathState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> a rv:ClassificationExpression ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:expressionState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:ClassificationSense ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:expression <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:senseState rv:Active .\n",
      "args": {
        "scheme": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "concept": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "path": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "expression": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/scheme-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/concept-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/path-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/expression-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "wrong-expression-path": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a skos:ConceptScheme ; rv:schemeState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a skos:Concept ; skos:inScheme <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; skos:prefLabel \"Mystery\"@en ; rv:conceptState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ConceptPath ; rv:pathKind rv:SingleConcept ; rv:pathLength 1 ; rv:terminalConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:pathState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> a rv:ClassificationExpression ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> ; rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:expressionState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:ClassificationSense ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:expression <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:senseState rv:Active .\n",
      "args": {
        "scheme": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "concept": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "path": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "expression": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "rv:path",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/scheme-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/concept-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/path-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/expression-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "wrong-interpretation-scope": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a skos:ConceptScheme ; rv:schemeState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a skos:Concept ; skos:inScheme <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; skos:prefLabel \"Mystery\"@en ; rv:conceptState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ConceptPath ; rv:pathKind rv:SingleConcept ; rv:pathLength 1 ; rv:terminalConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:pathState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> a rv:ClassificationExpression ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:expressionState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:ClassificationSense ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:expression <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:interpretationScope <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> ; rv:senseState rv:Active .\n",
      "args": {
        "scheme": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "concept": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "path": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "expression": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "rv:interpretationScope",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/scheme-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/concept-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/path-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/expression-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "ambiguous-interpretation-scope": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a skos:ConceptScheme ; rv:schemeState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a skos:Concept ; skos:inScheme <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; skos:prefLabel \"Mystery\"@en ; rv:conceptState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ConceptPath ; rv:pathKind rv:SingleConcept ; rv:pathLength 1 ; rv:terminalConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:pathState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> a rv:ClassificationExpression ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:expressionState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:ClassificationSense ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:expression <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:interpretationScope <urn:rezics:classification-context:global>, <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> ; rv:senseState rv:Active .\n",
      "args": {
        "scheme": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "concept": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "path": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "expression": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "rv:interpretationScope",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/scheme-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/concept-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/path-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/expression-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "duplicate-english-label": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a skos:ConceptScheme ; rv:schemeState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a skos:Concept ; skos:inScheme <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; skos:prefLabel \"Mystery\"@en, \"Puzzle\"@en ; rv:conceptState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ConceptPath ; rv:pathKind rv:SingleConcept ; rv:pathLength 1 ; rv:terminalConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:pathState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> a rv:ClassificationExpression ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:expressionState rv:Active .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:ClassificationSense ; rv:path <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:expression <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:senseState rv:Active .\n",
      "args": {
        "scheme": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "concept": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "path": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "expression": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "skos:prefLabel",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/scheme-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/concept-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/path-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/expression-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004"
        },
        {
          "shape": "https://rezics.com/definition/classification-proposition-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
