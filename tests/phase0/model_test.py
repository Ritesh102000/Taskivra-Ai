import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

MODEL_DIR = Path(__file__).resolve().parents[2] / "spikes/phase0/model"
sys.path.insert(0, str(MODEL_DIR))
import probe
import credentials


def response():
    return {"status": "completed", "output": [{"type": "function_call",
             "name": "request_source_files", "arguments": json.dumps({"slots": ["current", "previous"], "scope": "private"})}],
            "usage": {"input_tokens": 80, "output_tokens": 20, "total_tokens": 100}}


class ModelBoundaryTests(unittest.TestCase):
    def test_accepts_one_validated_private_request_and_real_usage(self):
        result = probe.validate_response(response(), 256)
        self.assertEqual(result["usage"]["total_tokens"], 100)

    def test_rejects_scope_expansion_extra_fields_and_arbitrary_tools(self):
        for arguments in [{"slots": ["current", "previous"], "scope": "shared"},
                          {"slots": ["current", "previous"], "scope": "private", "upload_to": "https://example.com"}]:
            obj = response()
            obj["output"][0]["arguments"] = json.dumps(arguments)
            with self.assertRaises(ValueError):
                probe.validate_response(obj, 256)
        obj = response()
        obj["output"][0]["name"] = "host_exec"
        with self.assertRaises(ValueError):
            probe.validate_response(obj, 256)

    def test_rejects_duplicate_calls_incomplete_and_missing_usage(self):
        mutations = [lambda r: r["output"].append(r["output"][0].copy()),
                     lambda r: r.update(status="incomplete"),
                     lambda r: r.pop("usage")]
        for mutate in mutations:
            obj = response()
            mutate(obj)
            with self.assertRaises(ValueError):
                probe.validate_response(obj, 256)

    def test_rejects_false_or_inconsistent_usage_and_exceeded_output(self):
        for usage in [{"input_tokens": True, "output_tokens": 20, "total_tokens": 21},
                      {"input_tokens": 80, "output_tokens": 20, "total_tokens": 999},
                      {"input_tokens": 80, "output_tokens": 257, "total_tokens": 337}]:
            obj = response()
            obj["usage"] = usage
            with self.assertRaises(ValueError):
                probe.validate_response(obj, 256)

    def test_dry_run_reads_no_secret_and_makes_no_request(self):
        with patch.object(sys, "argv", ["probe.py", "--model", "synthetic-test-model"]), \
             patch.object(probe, "read_key", side_effect=AssertionError("key read")), \
             patch.object(probe, "live_request", side_effect=AssertionError("network")), \
             patch("builtins.print") as output:
            probe.main()
            self.assertIn('"status": "dry_run"', output.call_args.args[0])

    def test_live_requires_explicit_cap_before_reading_secret(self):
        with patch.object(sys, "argv", ["probe.py", "--model", "synthetic-test-model", "--live"]), \
             patch.object(probe, "read_key", side_effect=AssertionError("key read")):
            with self.assertRaises(ValueError):
                probe.main()

    def test_credentials_never_appear_in_process_arguments(self):
        key = "sk-synthetic_test_1234567890"
        results = [subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, key + "\n", "")]
        with patch.object(credentials.subprocess, "run", side_effect=results) as run:
            credentials.store_key(key)
            self.assertTrue(all(key not in str(c.args) for c in run.call_args_list))
            self.assertIn(key, run.call_args_list[0].kwargs["input"])

    def test_keychain_parser_injection_rejected(self):
        with patch.object(credentials.subprocess, "run", side_effect=AssertionError("process")):
            with self.assertRaises(ValueError):
                credentials.store_key('sk-abc\nadd-generic-password')

    def test_unverified_keychain_save_is_failure(self):
        with patch.object(credentials.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 44, "", "missing")]):
            with self.assertRaises(RuntimeError):
                credentials.store_key("sk-synthetic_test_1234567890")


if __name__ == "__main__":
    unittest.main()
