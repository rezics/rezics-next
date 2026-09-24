#!/usr/bin/env python3
"""Exercise the separate Global/Realm classification context profile with Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_classification_context.py"
GLOBAL = "urn:rezics:classification-context:global"
REALM = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000011"
CONTEXT = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000012"
OTHER = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000013"
POLICY = "https://rezics.com/definition/"


def candidate():
    return ("@prefix rv: <https://rezics.com/vocab/> .\n"
            f"<{GLOBAL}> a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ; "
            f"rv:contextState rv:Active ; rv:inheritancePolicy <{POLICY}classification-isolate-v1> .\n"
            f"<{REALM}> a rv:Realm ; rv:realmState rv:Active ; "
            f"rv:classificationContext <{CONTEXT}> .\n"
            f"<{CONTEXT}> a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; "
            f"rv:contextState rv:Active ; rv:realm <{REALM}> ; "
            f"rv:inheritancePolicy <{POLICY}classification-inherit-global-v1> ; "
            f"rv:fallbackContext <{GLOBAL}> .\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    valid = candidate()
    cases = {
        "valid": (valid, True, None),
        "missing-context-type": (valid.replace(
            f"<{CONTEXT}> a rv:ClassificationContext ; ", f"<{CONTEXT}> "),
                                 False, "rdf:type"),
        "wrong-realm-link": (valid.replace(f"rv:classificationContext <{CONTEXT}> .",
                                           f"rv:classificationContext <{OTHER}> ."),
                             False, "rv:classificationContext"),
        "wrong-inheritance-policy": (valid.replace(
            f"rv:inheritancePolicy <{POLICY}classification-inherit-global-v1> ;",
            f"rv:inheritancePolicy <{POLICY}classification-isolate-v1> ;"),
                                     False, "rv:inheritancePolicy"),
        "wrong-fallback": (valid.replace(f"rv:fallbackContext <{GLOBAL}> .",
                                         f"rv:fallbackContext <{OTHER}> ."),
                           False, "rv:fallbackContext"),
        "global-fallback-cycle": (valid.replace(
            f"rv:inheritancePolicy <{POLICY}classification-isolate-v1> .",
            f"rv:inheritancePolicy <{POLICY}classification-isolate-v1> ; "
            f"rv:fallbackContext <{CONTEXT}> ."), False, "rv:fallbackContext"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="classification-context-", dir=ROOT / ".temp") as temp:
        for name, (source, expected, path_hint) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text(source)
            completed = subprocess.run([
                sys.executable, str(HELPER), "--data", str(data),
                "--realm", REALM, "--context", CONTEXT,
                "--jena-home", str(args.jena_home), "--java-home", str(args.java_home),
                "--temp-root", temp,
            ], cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (
                name, completed.stdout, completed.stderr)
            report = json.loads(completed.stdout)
            assert report["conforms"] is expected, (name, report)
            if path_hint:
                assert "sh:resultPath" in report["report"] and path_hint in report["report"], (
                    name, report)
            outcomes[name] = {"conforms": report["conforms"],
                              "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-classification-context-profile",
                                "MODEL17-explicit-three-focus-validation"],
                      "profile_sha256": report["profile_sha256"],
                      "jena_shacl": report["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
