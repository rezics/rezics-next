// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const classificationDirectDecisionFixture = {
  "id": "classification-direct-decision-v1",
  "sha256": "c33d12713979c86a3d29aa2fc6ebd4952f37bdece02a5aa6ba485fc48bda468b",
  "cases": {
    "global-accepted": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <urn:rezics:classification-context:global> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Accepted ; rv:decisionBasis rv:GlobalCuratorReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "urn:rezics:classification-context:global",
        "context-kind": "global",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "accepted"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "realm-rejected": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:RealmManagerReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> ; rv:contextRevision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006",
        "context-kind": "realm",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "rejected",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005",
        "context-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "realm-revised": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Accepted ; rv:decisionBasis rv:RealmManagerReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> ; rv:contextRevision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> ; rv:predecessor <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006",
        "context-kind": "realm",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "accepted",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005",
        "context-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007",
        "predecessor": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "missing-application-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <urn:rezics:classification-context:global> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Accepted ; rv:decisionBasis rv:GlobalCuratorReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "urn:rezics:classification-context:global",
        "context-kind": "global",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "accepted"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "wrong-application-context": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:RealmManagerReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> ; rv:contextRevision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006",
        "context-kind": "realm",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "rejected",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005",
        "context-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007"
      },
      "expected": false,
      "pathHint": "rv:classificationContext",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "wrong-review-basis": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:GlobalCuratorReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> ; rv:contextRevision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006",
        "context-kind": "realm",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "rejected",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005",
        "context-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007"
      },
      "expected": false,
      "pathHint": "rv:decisionBasis",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "wrong-realm-fallback": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:inheritancePolicy <https://rezics.com/definition/classification-inherit-global-v1> ; rv:fallbackContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:RealmManagerReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> ; rv:contextRevision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006",
        "context-kind": "realm",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "rejected",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005",
        "context-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000007"
      },
      "expected": false,
      "pathHint": "rv:fallbackContext",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "stale-sense-revision": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <urn:rezics:classification-context:global> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Accepted ; rv:decisionBasis rv:GlobalCuratorReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "urn:rezics:classification-context:global",
        "context-kind": "global",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "accepted"
      },
      "expected": false,
      "pathHint": "rv:head",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    },
    "unexpected-predecessor": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> a rv:ClassificationSense ; rv:senseState rv:Active ; rv:interpretationScope <urn:rezics:classification-context:global> ; rv:head <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n<urn:rezics:classification-context:global> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ; rv:inheritancePolicy <https://rezics.com/definition/classification-isolate-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> a rv:ClassificationApplication ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:sense <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:classificationContext <urn:rezics:classification-context:global> ; rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ; rv:applicationKey <urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:proposer <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009> a rv:ClassificationDecision ; rv:application <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008> ; rv:outcome rv:Accepted ; rv:decisionBasis rv:GlobalCuratorReview ; rv:decidedBy <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010> ; rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1> ; rv:predecessor <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099> .\n",
      "args": {
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002",
        "sense": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003",
        "sense-revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004",
        "context": "urn:rezics:classification-context:global",
        "context-kind": "global",
        "application": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008",
        "decision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009",
        "slot": "urn:rezics:classification-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "proposer": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "decider": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000010",
        "outcome": "accepted"
      },
      "expected": false,
      "pathHint": "rv:predecessor",
      "focus": [
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/sense-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/context-shape",
          "focus": "urn:rezics:classification-context:global"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/application-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000008"
        },
        {
          "shape": "https://rezics.com/definition/classification-direct-decision-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000009"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
