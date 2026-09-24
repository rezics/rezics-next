#!/usr/bin/env python3
"""Exercise the five-focus shared proposition profile against pinned Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_classification_proposition.py"
ROLES = ("scheme", "concept", "path", "expression", "sense")
FOCUSES = {role: f"https://rezics.com/id/019cb49e-0ea2-7000-8000-{n:012d}"
           for n, role in enumerate(ROLES, start=1)}
OTHER = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000099"
GLOBAL = "urn:rezics:classification-context:global"


def candidate():
    scheme, concept, path, expression, sense = (FOCUSES[role] for role in ROLES)
    return ("@prefix rv: <https://rezics.com/vocab/> .\n"
            "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n"
            f"<{scheme}> a skos:ConceptScheme ; rv:schemeState rv:Active .\n"
            f"<{concept}> a skos:Concept ; skos:inScheme <{scheme}> ; "
            'skos:prefLabel "Mystery"@en ; rv:conceptState rv:Active .\n'
            f"<{path}> a rv:ConceptPath ; rv:pathKind rv:SingleConcept ; "
            f"rv:pathLength 1 ; rv:terminalConcept <{concept}> ; rv:pathState rv:Active .\n"
            f"<{expression}> a rv:ClassificationExpression ; rv:path <{path}> ; "
            f"rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept <{concept}> ; "
            "rv:expressionState rv:Active .\n"
            f"<{sense}> a rv:ClassificationSense ; rv:path <{path}> ; "
            f"rv:expression <{expression}> ; rv:interpretationScope <{GLOBAL}> ; "
            "rv:senseState rv:Active .\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    valid = candidate()
    path = FOCUSES["path"]
    cases = {
        "valid": (valid, True, None),
        "missing-path-type": (valid.replace(f"<{path}> a rv:ConceptPath ; ",
                                            f"<{path}> "), False, "rdf:type"),
        "wrong-expression-path": (valid.replace(
            f"rv:ClassificationExpression ; rv:path <{path}> ; ",
            f"rv:ClassificationExpression ; rv:path <{OTHER}> ; "), False, "rv:path"),
        "wrong-interpretation-scope": (valid.replace(f"<{GLOBAL}> ; ",
                                                      f"<{OTHER}> ; "),
                                       False, "rv:interpretationScope"),
        "ambiguous-interpretation-scope": (valid.replace(f"<{GLOBAL}> ; ",
                                                          f"<{GLOBAL}>, <{OTHER}> ; "),
                                           False, "rv:interpretationScope"),
        "duplicate-english-label": (valid.replace('skos:prefLabel "Mystery"@en ;',
                                                   'skos:prefLabel "Mystery"@en, "Puzzle"@en ;'),
                                    False, "skos:prefLabel"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="classification-proposition-", dir=ROOT / ".temp") as temp:
        for name, (source, expected, path_hint) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text(source)
            completed = subprocess.run([
                sys.executable, str(HELPER), "--data", str(data),
                *(item for role in ROLES for item in (f"--{role}", FOCUSES[role])),
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
    print(json.dumps({"cases": ["MODEL15-classification-proposition-profile",
                                "MODEL17-explicit-five-focus-validation"],
                      "profile_sha256": report["profile_sha256"],
                      "jena_shacl": report["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
