#!/usr/bin/env python3
"""ADR-0010 capability-stack acceptance runner.

All cases start UNTESTED. Probes become real only after Voice/Documents
adapters exist. Claiming Phase 1/2 "done" while exit code is 2 is forbidden.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent
CASES_PATH = ROOT / "cases.json"
ADAPTER_HINT = os.environ.get("ATLAS_VOICE_DOCS_ADAPTER_URL", "").strip()


def load_cases() -> dict[str, Any]:
    raw = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    if raw.get("schemaVersion") != "atlas-capability-acceptance/v0":
        raise SystemExit("harness misconfiguration: bad schemaVersion")
    cases = raw.get("cases")
    if not isinstance(cases, list) or len(cases) != 18:
        raise SystemExit("harness misconfiguration: expected 18 cases (10 voice + 8 OCR)")
    voice = [c for c in cases if c.get("lane") == "voice"]
    docs = [c for c in cases if c.get("lane") == "documents"]
    if len(voice) != 10 or len(docs) != 8:
        raise SystemExit("harness misconfiguration: lane counts must be 10 voice + 8 documents")
    return raw


def probe_untested(_case: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "UNTESTED",
        "reason": "adapter/fixtures not implemented; ADR-0010 forbids claiming done",
        "adapterUrl": ADAPTER_HINT or None,
    }


def probe_python312_venv(case: dict[str, Any]) -> dict[str, Any]:
    """Soft pre-check: record interpreter version; still UNTESTED until docs venv exists."""
    ver = sys.version_info
    note = f"runner_python={ver.major}.{ver.minor}.{ver.micro}"
    # Do not PASS merely because system python is 3.12 — documents venv must be proven.
    return {
        "status": "UNTESTED",
        "reason": f"documents Python 3.12 venv not verified yet ({note})",
        "detail": note,
    }


PROBES: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "adapter_stt_primary": probe_untested,
    "adapter_stt_fallback": probe_untested,
    "adapter_vad": probe_untested,
    "adapter_tts": probe_untested,
    "adapter_ptt": probe_untested,
    "adapter_no_brain": probe_untested,
    "cli_voice_client": probe_untested,
    "morning_report_roundtrip": probe_untested,
    "cloud_fallback_policy": probe_untested,
    "voice_vram_budget": probe_untested,
    "python312_venv": probe_python312_venv,
    "paddleocr_vl_load": probe_untested,
    "pp_structure_v3_table": probe_untested,
    "tesseract_fallback": probe_untested,
    "az_diacritics_guard": probe_untested,
    "docs_adapter_pattern": probe_untested,
    "disk_budget_5gb": probe_untested,
    "vram_contention_gate": probe_untested,
}


def run_case(case: dict[str, Any]) -> dict[str, Any]:
    probe_name = case.get("probe")
    fn = PROBES.get(str(probe_name), probe_untested)
    result = fn(case)
    return {
        "id": case["id"],
        "lane": case["lane"],
        "title": case["title"],
        "criterion": case["criterion"],
        "probe": probe_name,
        "declaredStatus": case.get("status"),
        "resultStatus": result.get("status", "UNTESTED"),
        "reason": result.get("reason"),
        "detail": result.get("detail"),
    }


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {"PASS": 0, "FAIL": 0, "UNTESTED": 0, "SKIP": 0}
    for r in results:
        st = r["resultStatus"]
        counts[st] = counts.get(st, 0) + 1
    if counts.get("FAIL", 0) > 0:
        exit_code = 1
    elif counts.get("UNTESTED", 0) > 0 or counts.get("SKIP", 0) > 0:
        exit_code = 2
    else:
        exit_code = 0
    return {"counts": counts, "exitCode": exit_code, "results": results}


def main() -> int:
    parser = argparse.ArgumentParser(description="ADR-0010 capability acceptance runner")
    parser.add_argument("--json", action="store_true", help="Emit JSON report only")
    parser.add_argument(
        "--require-pass",
        action="store_true",
        help="Treat UNTESTED as FAIL (exit 1) — use only when claiming done",
    )
    args = parser.parse_args()

    try:
        bundle = load_cases()
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return 3

    results = [run_case(c) for c in bundle["cases"]]
    report = summarize(results)
    report["adr"] = bundle.get("adr")
    report["schemaVersion"] = bundle.get("schemaVersion")
    report["northStar"] = bundle.get("northStar")

    if args.require_pass and report["exitCode"] == 2:
        report["exitCode"] = 1
        report["counts"]["FAIL"] = report["counts"].get("FAIL", 0) + report["counts"].get(
            "UNTESTED", 0
        )
        report["note"] = "UNTESTED promoted to FAIL via --require-pass"

    def emit(text: str) -> None:
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        try:
            print(text)
        except UnicodeEncodeError:
            print(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))

    if args.json:
        emit(json.dumps(report, ensure_ascii=True, indent=2))
    else:
        emit(f"ADR-0010 capability acceptance - {report['counts']}")
        for r in results:
            emit(f"  [{r['resultStatus']}] {r['id']} {r['title']}")
            if r.get("reason"):
                emit(f"           {r['reason']}")
        emit(f"exitCode={report['exitCode']} (0=all PASS, 1=FAIL, 2=UNTESTED remaining)")
        if report["exitCode"] == 2:
            emit("NOT DONE: implement adapters/fixtures until all cases PASS.")

    return int(report["exitCode"])


if __name__ == "__main__":
    sys.exit(main())
