"""Regression cases for defects in document links and navigation."""
import tempfile
import unittest
from pathlib import Path

from check_docs import anchors, check, destinations


class DocumentationChecks(unittest.TestCase):
    def test_missing_file_and_fragment_report_source_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / 'one.md'
            second = root / 'two.md'
            first.write_text('# Entry\n[missing](lost.md)\n[bad](two.md#lost)\n')
            second.write_text('# Present\n')
            errors = check(root, [first, second], navigation=False)
            self.assertEqual(len(errors), 2)
            self.assertIn('one.md:2: missing target', errors[0])
            self.assertIn('one.md:3: missing fragment', errors[1])

    def test_code_examples_do_not_create_links_or_headings(self):
        source = ('# Actual\n```md\n# Fake\n[x](missing.md)\n```\n'
                  '~~~text\n[y](missing.md)\n~~~\n`[z](missing.md)`\n')
        self.assertEqual(anchors(source), {'actual'})
        self.assertEqual(list(destinations(source)), [])

    def test_heading_collision_unicode_and_inline_markup(self):
        source = '# 重建 `TDB2` / Lucene\n## Same\n## Same\n## Same-1\n'
        self.assertEqual(anchors(source), {'重建-tdb2--lucene', 'same', 'same-1', 'same-1-1'})

    def test_destinations_keep_nested_parentheses_and_reference_definitions(self):
        source = '[API](https://example.org/a(b)/c "title")\n[ref]: guide.md#read\n'
        self.assertEqual(list(destinations(source)),
                         [(1, 'https://example.org/a(b)/c'), (2, 'guide.md#read')])

    def test_encoded_paths_root_paths_and_html_anchors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'docs'
            folder.mkdir()
            index = folder / 'README.md'
            target = folder / 'with space.md'
            index.write_text('[a](</docs/with%20space.md#named>)\n')
            target.write_text('<a id="named"></a>\n# Content\n')
            self.assertEqual(check(root, [index, target]), [])

    def test_navigation_detects_isolated_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'docs'
            folder.mkdir()
            index = folder / 'README.md'
            target = folder / 'owner.md'
            index.write_text('# Start\n')
            target.write_text('# Owner\n')
            self.assertEqual(check(root, [index, target]),
                             ['docs/owner.md: unreachable from docs/README.md'])
            index.write_text('[Owner](owner.md)\n')
            self.assertEqual(check(root, [index, target]), [])

    def test_external_links_are_not_treated_as_local_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'README.md'
            source.write_text('[web](https://example.org/missing)\n[mail](mailto:test@example.org)\n')
            self.assertEqual(check(root, [source], navigation=False), [])


if __name__ == '__main__':
    unittest.main()
