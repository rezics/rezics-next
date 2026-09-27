"""The published inventory follows source pins and rejects copied drift."""

import tempfile
import unittest
from pathlib import Path

from toolchain_inventory import ROOT, check, commands, direct_packages, render, update


class ToolchainInventoryTest(unittest.TestCase):
    def test_live_inventory_is_current(self):
        self.assertEqual([], check(ROOT))
        rendered = render(ROOT)
        self.assertIn("### Runtime pins", rendered)
        self.assertIn("### Direct workspace packages", rendered)
        self.assertIn("### Service and Fuseki build images", rendered)
        self.assertIn("### Other pinned images", rendered)
        self.assertIn("### Shared development ports", rendered)
        self.assertIn("| `task dev:seed` |", rendered)
        self.assertIn("rezics/fuseki:", rendered)

    def test_manifest_pins_reject_conflicts(self):
        (ROOT / ".temp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".temp") as directory:
            root = Path(directory)
            (root / "package.json").write_text('{"workspaces":["app"],"dependencies":{"example":"1.0.0"}}')
            (root / "app").mkdir()
            (root / "app/package.json").write_text('{"dependencies":{"example":"2.0.0"}}')
            with self.assertRaisesRegex(ValueError, "Conflicting direct pins"):
                direct_packages(root)

    def test_task_descriptions_and_marker_are_required(self):
        self.assertEqual([("dev", "Start service.")], commands("  dev:\n    desc: Start service.\n"))
        with self.assertRaisesRegex(ValueError, "no one-line description"):
            commands("  dev:\n    cmds:\n")
        with self.assertRaisesRegex(ValueError, "one inventory marker pair"):
            update("# Missing markers", "table")


if __name__ == "__main__":
    unittest.main()
