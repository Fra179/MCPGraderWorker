"""
Minimal Python client for the grader-worker admin API, e.g. for use inside MCPGrader.

Requires `cryptography` and `requests`. Usage:

    python examples/client.py https://grader-api.example.com keys/grader.key [assignment_name]

The signing scheme must match canonicalRequest() in src/auth.ts.
"""

import base64
import hashlib
import json
import sys
import time
from datetime import datetime
from urllib.parse import urlencode

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature


class GraderApi:
    def __init__(self, base_url: str, private_key_pem: bytes):
        self.base_url = base_url.rstrip("/")
        self.key = serialization.load_pem_private_key(private_key_pem, password=None)
        if not isinstance(self.key, ec.EllipticCurvePrivateKey) or self.key.curve.name != "secp256r1":
            raise ValueError("Admin key must be an ECDSA P-256 private key")

    def _signature_headers(self, method: str, path: str, body: bytes) -> dict[str, str]:
        timestamp = str(int(time.time()))
        message = f"{method}\n{path}\n{timestamp}\n{hashlib.sha256(body).hexdigest()}".encode()
        # cryptography returns a DER signature; the worker expects raw r||s (32 bytes each), like WebCrypto.
        r, s = decode_dss_signature(self.key.sign(message, ec.ECDSA(hashes.SHA256())))
        raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return {"X-Grader-Timestamp": timestamp, "X-Grader-Signature": base64.b64encode(raw).decode()}

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        body = b"" if payload is None else json.dumps(payload, allow_nan=False).encode()
        headers = self._signature_headers(method, path, body)
        if payload is not None:
            headers["Content-Type"] = "application/json"
        response = requests.request(method, self.base_url + path, data=body or None, headers=headers, timeout=30)
        if not response.ok:
            raise RuntimeError(f"{method} {path} failed with {response.status_code}: {response.text}")
        return response.json()

    def submissions(
        self,
        assignment_name: str | None = None,
        pushed_after: datetime | str | int | None = None,
        order_by: str | None = None,
    ) -> list[dict]:
        """
        List submissions. All filters are optional:
        - assignment_name: only this assignment
        - pushed_after: only submissions whose last push is later than this. A timezone-aware datetime,
          an ISO 8601 string with a timezone, or unix seconds.
        - order_by: "created_at" (the default) or "last_push"
        """
        payload: dict = {}
        if assignment_name is not None:
            payload["assignment_name"] = assignment_name
        if pushed_after is not None:
            if isinstance(pushed_after, datetime):
                if pushed_after.tzinfo is None:
                    raise ValueError("pushed_after must be timezone-aware, e.g. datetime.now(timezone.utc)")
                pushed_after = pushed_after.isoformat()
            payload["pushed_after"] = pushed_after
        if order_by is not None:
            payload["order_by"] = order_by
        return self._request("POST", "/submissions", payload or None)["submissions"]

    def delete_submission(self, submission_id: str) -> int:
        return self._request("DELETE", "/submissions", {"id": submission_id})["deleted"]

    def delete_assignment(self, assignment_name: str) -> int:
        return self._request("DELETE", "/assignment", {"assignment_name": assignment_name})["deleted"]

    def rotate_webhook_secret(self, submission_id: str) -> str:
        """Give a submission a new push-webhook secret (the old one stops working). Returns the new secret."""
        return self._request("POST", "/webhook-secret", {"id": submission_id})["webhook_secret"]

    def updates(self) -> list[dict]:
        """
        Pending submissions, including their update_id. Reading does not consume them.
        Keep the fetched update_id with the fixed repository snapshot throughout grading.
        """
        return self._request("GET", "/updates")["submissions"]

    def mark_grading(
        self, submission_id: str, task: str, run_id: str, previous_run_id: str | None,
        name: str, commit_hash: str, perf_hash: str, *, update_id: int | None = None,
    ) -> dict:
        """Start one evaluation. Persist run_id before calling; scheduler retries retain it.

        Discover previous_run_id through grading_tasks(). Use null for a first run.
        An identical retry returns the original run's current state.
        """
        return self._request("POST", "/updates/grading", {
            "id": submission_id, "task": task, "run_id": run_id,
            "previous_run_id": previous_run_id, "update_id": update_id,
            "name": name, "commit_hash": commit_hash, "perf_hash": perf_hash,
        })

    def mark_graded(self, submission_id: str, task: str, run_id: str, grading: dict) -> dict:
        """Publish the evaluation's immutable result; this never acknowledges a push.

        Persist the result and pending publication together before deleting result files.
        Retry with identical values and the same run_id; corrected results need a new run.
        """
        return self._request("POST", "/updates/graded", {
            "id": submission_id, "task": task, "run_id": run_id, "grading": grading,
        })

    def cancel_grading(self, submission_id: str, task: str, run_id: str, reason: str) -> dict:
        """Abandon an evaluation, preserving its previous result. Does not stop scheduler jobs."""
        return self._request("POST", "/updates/cancelled", {
            "id": submission_id, "task": task, "run_id": run_id, "reason": reason,
        })

    def grading_run(self, run_id: str) -> dict:
        return self._request("GET", "/grading?" + urlencode({"run_id": run_id}))

    def grading_tasks(self, submission_id: str) -> dict:
        """Latest predecessors, active metadata and last completed run IDs by task."""
        return self._request("GET", "/grading?" + urlencode({"id": submission_id}))["tasks"]

    def acknowledge(self, submission_id: str, update_id: int, runs: dict[str, str]) -> dict:
        """Declare this snapshot satisfied using one completed run per applicable task.

        Existing runs may have older/null update_id. The coordinator must first compare
        repository, pinned commit and task fingerprints locally. Empty runs means no tasks.
        Retire an outbox entry for acknowledged/already_acknowledged/superseded;
        retain active_runs and reconcile errors instead of blindly retrying.
        """
        return self._request("POST", "/updates/acknowledged", {
            "id": submission_id, "update_id": update_id, "runs": runs,
        })

    def leaderboard(self, assignment_name: str | None = None) -> dict:
        """Public leaderboard, grouped by assignment; no admin signature is needed."""
        path = "/leaderboard"
        if assignment_name is not None:
            path += "?" + urlencode({"assignment_name": assignment_name})
        response = requests.get(self.base_url + path, timeout=30)
        response.raise_for_status()
        return response.json()


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    with open(sys.argv[2], "rb") as f:
        api = GraderApi(sys.argv[1], f.read())
    for s in api.submissions(sys.argv[3] if len(sys.argv) == 4 else None):
        print(f"{s['assignment_name']:<20} {s['student_id']:<10} {s['repo_ssh_url']:<50} last push: {s['last_push'] or 'never'}")
