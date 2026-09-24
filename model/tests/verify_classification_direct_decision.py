#!/usr/bin/env python3
"""Exercise curated Global and Realm classification decisions with pinned Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_classification_direct_decision.py"
RV = "https://rezics.com/vocab/"
GLOBAL = "urn:rezics:classification-context:global"
ISOLATE = "https://rezics.com/definition/classification-isolate-v1"
INHERIT = "https://rezics.com/definition/classification-inherit-global-v1"
PROFILE = "https://rezics.com/definition/classification-direct-decision-v1"
ROLES = ("work", "main", "sense", "sense_revision", "realm", "context",
         "context_revision", "application", "decision", "proposer")
IDS = {role: f"https://rezics.com/id/019cb49e-0ea2-7000-8000-{n:012d}"
       for n, role in enumerate(ROLES, start=1)}
OTHER = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099"
SLOT = "urn:rezics:classification-slot:" + "a" * 64


def candidate(context_kind="global", outcome="accepted", predecessor=None):
    context = GLOBAL if context_kind == "global" else IDS["context"]
    basis = "GlobalCuratorReview" if context_kind == "global" else "RealmManagerReview"
    context_revision = (f" ; rv:contextRevision <{IDS['context_revision']}>"
                        if context_kind == "realm" else "")
    prior = f" ; rv:predecessor <{predecessor}>" if predecessor else ""
    realm = (f"<{IDS['realm']}> a rv:Realm ; rv:realmState rv:Active ; "
             f"rv:classificationContext <{context}> .\n"
             f"<{context}> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; "
             f"rv:contextState rv:Active ; rv:realm <{IDS['realm']}> ; "
             f"rv:inheritancePolicy <{INHERIT}> ; rv:fallbackContext <{GLOBAL}> ; "
             f"rv:head <{IDS['context_revision']}> .\n" if context_kind == "realm" else "")
    return ("@prefix rv: <https://rezics.com/vocab/> .\n"
            "@prefix schema: <https://schema.org/> .\n"
            f"<{IDS['work']}> a schema:CreativeWork ; rv:mainVersion <{IDS['main']}> .\n"
            f"<{IDS['main']}> a rv:MainVersion ; rv:work <{IDS['work']}> .\n"
            f"<{IDS['sense']}> a rv:ClassificationSense ; rv:senseState rv:Active ; "
            f"rv:interpretationScope <{GLOBAL}> ; rv:head <{IDS['sense_revision']}> .\n"
            f"<{GLOBAL}> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; "
            f"rv:contextState rv:Active ; rv:inheritancePolicy <{ISOLATE}> .\n"
            + realm +
            f"<{IDS['application']}> a rv:ClassificationApplication ; "
            f"rv:targetMainVersion <{IDS['main']}> ; rv:sense <{IDS['sense']}> ; "
            f"rv:classificationContext <{context}> ; rv:applicationChannel rv:Curated ; "
            f"rv:applicationState rv:Active ; rv:applicationKey <{SLOT}> ; "
            f"rv:proposer <{IDS['proposer']}> ; rv:decisionHead <{IDS['decision']}> .\n"
            f"<{IDS['decision']}> a rv:ClassificationDecision ; "
            f"rv:application <{IDS['application']}> ; "
            f"rv:outcome rv:{'Accepted' if outcome == 'accepted' else 'Rejected'} ; "
            f"rv:decisionBasis rv:{basis} ; rv:decidedBy <{IDS['proposer']}> ; "
            f"rv:decisionPolicy <{PROFILE}>{context_revision}{prior} .\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    global_valid = candidate()
    realm_valid = candidate("realm", "rejected")
    cases = {
        "global-accepted": (global_valid, "global", "accepted", None, True, None),
        "realm-rejected": (realm_valid, "realm", "rejected", None, True, None),
        "realm-revised": (candidate("realm", "accepted", OTHER),
                          "realm", "accepted", OTHER, True, None),
        "missing-application-type": (global_valid.replace(
            "a rv:ClassificationApplication ; ", ""),
            "global", "accepted", None, False, "rdf:type"),
        "wrong-application-context": (realm_valid.replace(
            f"rv:classificationContext <{IDS['context']}> ; rv:applicationChannel",
            f"rv:classificationContext <{OTHER}> ; rv:applicationChannel"),
            "realm", "rejected", None, False, "rv:classificationContext"),
        "wrong-review-basis": (realm_valid.replace("rv:RealmManagerReview", "rv:GlobalCuratorReview"),
                               "realm", "rejected", None, False, "rv:decisionBasis"),
        "wrong-realm-fallback": (realm_valid.replace(
            f"rv:fallbackContext <{GLOBAL}> ;", f"rv:fallbackContext <{OTHER}> ;"),
            "realm", "rejected", None, False, "rv:fallbackContext"),
        "stale-sense-revision": (global_valid.replace(
            f"rv:head <{IDS['sense_revision']}> .", f"rv:head <{OTHER}> ."),
            "global", "accepted", None, False, "rv:head"),
        "unexpected-predecessor": (global_valid.replace(
            f"rv:decisionPolicy <{PROFILE}> .",
            f"rv:decisionPolicy <{PROFILE}> ; rv:predecessor <{OTHER}> ."),
            "global", "accepted", None, False, "rv:predecessor"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="classification-decision-", dir=ROOT / ".temp") as temp:
        for name, (source, kind, outcome, predecessor, expected, path_hint) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text(source)
            command = [sys.executable, str(HELPER), "--data", str(data),
                       "--work", IDS["work"], "--main", IDS["main"],
                       "--sense", IDS["sense"], "--sense-revision", IDS["sense_revision"],
                       "--context", GLOBAL if kind == "global" else IDS["context"],
                       "--context-kind", kind, "--application", IDS["application"],
                       "--decision", IDS["decision"], "--slot", SLOT,
                       "--proposer", IDS["proposer"], "--decider", IDS["proposer"],
                       "--outcome", outcome, "--jena-home", str(args.jena_home),
                       "--java-home", str(args.java_home), "--temp-root", temp]
            if kind == "realm":
                command.extend(("--realm", IDS["realm"],
                                "--context-revision", IDS["context_revision"]))
            if predecessor:
                command.extend(("--predecessor", predecessor))
            completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (
                name, completed.stdout, completed.stderr)
            report = json.loads(completed.stdout)
            assert report["conforms"] is expected, (name, report)
            if path_hint:
                assert "sh:resultPath" in report["report"] and path_hint in report["report"], (
                    name, report)
            outcomes[name] = {"conforms": report["conforms"],
                              "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-classification-direct-decision-profile",
                                "MODEL17-explicit-application-decision-dependencies"],
                      "profile_sha256": report["profile_sha256"],
                      "jena_shacl": report["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
