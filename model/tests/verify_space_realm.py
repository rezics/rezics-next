#!/usr/bin/env python3
"""Exercise the fixed Space and Realm capability profile with Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_space_realm.py"
IDS = [f"https://rezics.com/id/019cb49e-0ea2-7000-8000-{i:012d}" for i in range(1, 4)]
SPACE, REALM, OWNER = IDS
POLICY = "https://rezics.com/definition/"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    base = ("@prefix rv: <https://rezics.com/vocab/> .\n"
            + f"<{SPACE}> a rv:Space ; rv:owner <{OWNER}> ; rv:realmCapability <{REALM}> .\n")
    realm = (f"<{REALM}> a rv:Realm ; rv:space <{SPACE}> ; rv:realmState rv:Active ; "
             f"rv:selectionPolicy <{POLICY}realm-manager-fixed-main-fallback-v1> ; "
             f"rv:membershipPolicy <{POLICY}realm-closed-v1> ; "
             f"rv:reviewPolicy <{POLICY}realm-manager-reviewed-v1> .\n")
    cases = {
        "valid": (base + realm, True, None),
        "missing-owner": (base.replace(f"rv:owner <{OWNER}> ; ", "") + realm,
                          False, "rv:owner"),
        "missing-realm-type": (base + realm.replace("a rv:Realm ; ", ""),
                               False, "rdf:type"),
        "wrong-policy": (base + realm.replace("realm-manager-reviewed-v1", "unknown-review-v1"),
                         False, "rv:reviewPolicy"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="space-realm-", dir=ROOT / ".temp") as temp:
        for name, (candidate, expected, path) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text(candidate)
            completed = subprocess.run([
                sys.executable, str(HELPER), "--data", str(data),
                "--space", SPACE, "--realm", REALM,
                "--jena-home", str(args.jena_home),
                "--java-home", str(args.java_home), "--temp-root", temp,
            ], cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (name, completed.stdout, completed.stderr)
            result = json.loads(completed.stdout)
            assert result["conforms"] is expected, (name, result)
            if path:
                assert "sh:resultPath" in result["report"] and path in result["report"], (name, result)
            outcomes[name] = {"conforms": result["conforms"], "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-space-realm-profile", "MODEL17-two-focus-validation"],
                      "profile_sha256": result["profile_sha256"],
                      "jena_shacl": result["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
