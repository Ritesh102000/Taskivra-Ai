"""Host-only adversarial protocol/commit tests; these never run payload code."""
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "spikes/phase0/code"))
from export_protocol import ExportRejected, commit_export, export_tree, safe_path, validate_export, write_header


def protocol(records, *, ending=True):
    output = io.BytesIO()
    total = 0
    for metadata, data in records:
        write_header(output, metadata)
        output.write(data)
        total += len(data)
    if ending:
        write_header(output, {"type": "end", "count": len(records), "bytes": total})
    return output.getvalue()


def record(path="outputs/result.txt", data=b"checked\n"):
    return {"type": "file", "path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}, data


class ExportProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def reject(self, data, **limits):
        destination = self.root / "stage"
        destination.mkdir()
        with self.assertRaises((ExportRejected, OSError)):
            validate_export(io.BytesIO(data), destination, **limits)

    def test_roundtrip_and_independent_hash(self):
        source = self.root / "source"
        source.mkdir()
        (source / "result.txt").write_bytes(b"verified")
        output = io.BytesIO()
        export_tree(source, output)
        revisions = self.root / "revisions"
        committed = commit_export(io.BytesIO(output.getvalue()), revisions)
        self.assertEqual((revisions / committed["revision"] / "result.txt").read_bytes(), b"verified")
        self.assertEqual(committed["files"][0]["sha256"], hashlib.sha256(b"verified").hexdigest())

    def test_path_escapes(self):
        for path in ["/etc/passwd", "../outside", "a/../../outside", "a//b", "a/./b", "a\\b", "a:b", "a\0b", "a/" * 30]:
            with self.subTest(path=path), self.assertRaises(ExportRejected):
                safe_path(path)

    def test_hash_mismatch(self):
        metadata, data = record()
        metadata["sha256"] = "0" * 64
        self.reject(protocol([(metadata, data)]))

    def test_truncated_bytes(self):
        self.reject(protocol([record()], ending=False)[:-1])

    def test_trailing_bytes(self):
        self.reject(protocol([record()]) + b"fake publication")

    def test_duplicate_case_collision(self):
        self.reject(protocol([record("Report.txt"), record("report.txt")]))

    def test_file_directory_collision(self):
        self.reject(protocol([record("a"), record("a/b")]))

    def test_file_count_limit(self):
        self.reject(protocol([record("a"), record("b")]), max_files=1)

    def test_byte_limit(self):
        self.reject(protocol([record()]), max_bytes=2)

    def test_unbounded_or_unknown_header(self):
        self.reject(struct.pack("!I", 100000000))

    def test_payload_cannot_claim_special_file(self):
        self.reject(protocol([({"type": "symlink", "path": "a", "target": "/etc/passwd"}, b"")]))

    def test_source_symlink_rejected(self):
        source = self.root / "source"
        source.mkdir()
        (source / "link").symlink_to("/etc/passwd")
        with self.assertRaises(ExportRejected):
            export_tree(source, io.BytesIO())

    def test_source_hardlink_rejected(self):
        source = self.root / "source"
        source.mkdir()
        (source / "a").write_text("same")
        os.link(source / "a", source / "b")
        with self.assertRaises(ExportRejected):
            export_tree(source, io.BytesIO())

    def test_source_fifo_rejected_without_hanging(self):
        source = self.root / "source"
        source.mkdir()
        os.mkfifo(source / "pipe")
        with self.assertRaises(ExportRejected):
            export_tree(source, io.BytesIO())

    def test_failed_export_preserves_previous_revision(self):
        revisions = self.root / "revisions"
        previous = commit_export(io.BytesIO(protocol([record("old", b"preserve")])), revisions)
        pointer = (revisions / "current.json").read_bytes()
        with self.assertRaises(ExportRejected):
            commit_export(io.BytesIO(protocol([record("new")])[:-3]), revisions)
        self.assertEqual((revisions / "current.json").read_bytes(), pointer)
        self.assertEqual((revisions / previous["revision"] / "old").read_bytes(), b"preserve")
        self.assertFalse(list(revisions.glob(".staging-*")))

    def test_source_mutation_during_export_rejected(self):
        source = self.root / "source"
        source.mkdir()
        target = source / "a"
        target.write_bytes(b"original")
        class MutatingStream(io.BytesIO):
            def write(self, data):
                if self.tell() == 0:
                    target.write_bytes(b"modified")
                return super().write(data)
        with self.assertRaises(ExportRejected):
            export_tree(source, MutatingStream())


if __name__ == "__main__":
    unittest.main()
