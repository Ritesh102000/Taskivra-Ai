#!/usr/bin/env python3
"""One explicit Responses API request with a fixed synthetic tool-call fixture."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

from credentials import read_key

ROOT = Path(__file__).resolve().parents[3]
ENDPOINT = "https://api.openai.com/v1/responses"
TOOL = {
    "type": "function", "name": "request_source_files", "strict": True,
    "description": "Request the two synthetic source-file slots needed to compare periods.",
    "parameters": {"type": "object", "additionalProperties": False,
                   "properties": {"slots": {"type": "array", "items": {"type": "string",
                                    "enum": ["current", "previous"]}},
                                  "scope": {"type": "string", "enum": ["private"]}},
                   "required": ["slots", "scope"]}
}


def request_body(model, output_cap):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", model):
        raise ValueError("Specify an exact OpenAI model ID.")
    if type(output_cap) is not int or not 64 <= output_cap <= 2048:
        raise ValueError("The spike output limit must be 64–2048 tokens.")
    body = {"model": model, "store": False, "max_output_tokens": output_cap,
            "parallel_tool_calls": False, "tools": [TOOL],
            "tool_choice": {"type": "function", "name": "request_source_files"},
            "input": "Synthetic Phase 0 test: request both current and previous source files, in that order, privately. No actual user files exist."}
    if len(json.dumps(body).encode()) > 8192:
        raise ValueError("Request exceeds the fixed 8 KiB spike limit.")
    return body


def validate_response(response, output_cap):
    if response.get("status") != "completed":
        raise ValueError("The model did not complete the response; do not execute any tool.")
    outputs = response.get("output")
    if not isinstance(outputs, list):
        raise ValueError("Missing model output array.")
    calls = [x for x in outputs if isinstance(x, dict) and x.get("type") == "function_call"]
    if len(calls) != 1 or calls[0].get("name") != TOOL["name"]:
        raise ValueError("Expected exactly the allowed tool call.")
    raw = calls[0].get("arguments")
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError("Invalid or oversized tool arguments.")
    args = json.loads(raw)
    if args != {"slots": ["current", "previous"], "scope": "private"}:
        raise ValueError("Tool arguments failed independent host validation.")
    usage = response.get("usage")
    if not isinstance(usage, dict):
        raise ValueError("Provider did not report token usage.")
    counts = {k: usage.get(k) for k in ("input_tokens", "output_tokens", "total_tokens")}
    if any(type(v) is not int or v < 0 for v in counts.values()):
        raise ValueError("Provider token usage is malformed.")
    if counts["total_tokens"] != counts["input_tokens"] + counts["output_tokens"]:
        raise ValueError("Provider token totals are inconsistent.")
    if counts["output_tokens"] > output_cap:
        raise ValueError("Provider exceeded output-token limit.")
    return {"tool": TOOL["name"], "arguments": args, "usage": counts}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Refused redirect from the configured model endpoint.")


def live_request(body, key):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + key,
                                          "Content-Type": "application/json"})
    # No automatic retries: a timed-out request may already be billable.
    with opener.open(req, timeout=45) as result:
        content = result.read(1_048_577)
        if len(content) > 1_048_576:
            raise ValueError("Provider response exceeded 1 MiB.")
        return json.loads(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--max-output-tokens", type=int, default=256)
    parser.add_argument("--live", action="store_true", help="Send one billed request; otherwise inspect the fixed request only")
    parser.add_argument("--accept-token-cap", action="store_true", help="Explicitly choose one-request/output-token limits; no dollar cap is claimed")
    args = parser.parse_args()
    body = request_body(args.model, args.max_output_tokens)
    if not args.live:
        print(json.dumps({"status": "dry_run", "endpoint": ENDPOINT, "request": body,
                          "notice": "No credential read and no network request performed."}, indent=2))
        return
    if not args.accept_token_cap:
        raise ValueError("Choose the model and accept the explicit token/request cap before a billed probe. A dollar spend cap remains a separate setup decision.")
    response = live_request(body, read_key())
    validated = validate_response(response, args.max_output_tokens)
    report = {"recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(), "status": "passed",
              "provider": "openai", "requested_model": args.model, "requests": 1,
              "output_token_limit": args.max_output_tokens, "max_request_bytes": 8192,
              "cost_usd": None, "cost_note": "No price inferred; actual provider token counts recorded.",
              "tool_execution": "Validated only; no actual task, file request, or container launched.", **validated}
    path = ROOT / "docs/phase0/evidence/model.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as exc:
        print(f"Model probe failed: HTTP {exc.code}. Response body and credentials are not logged.", file=sys.stderr)
        sys.exit(1)
    except (ValueError, RuntimeError, OSError, urllib.error.URLError, subprocess.SubprocessError) as exc:
        # Avoid printing transport objects which can contain request details.
        print(f"Model probe did not pass ({type(exc).__name__}). Check model choice, key setup, explicit limits, or connectivity. No retry was sent.", file=sys.stderr)
        sys.exit(1)
