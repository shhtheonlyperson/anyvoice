from __future__ import annotations

import argparse
import errno
import hashlib
import json
import mimetypes
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"JSON is not an object: {path}")
    return payload


def same_path(raw_path: Any, expected: Path) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    return Path(raw_path).expanduser().resolve(strict=False) == expected.resolve(strict=False)


def validate_review(payload: dict[str, Any], report_json: Path, review_json: Path) -> None:
    expected_sha = sha256_file(report_json)
    if payload.get("reportSha256") != expected_sha:
        raise ValueError("review reportSha256 does not match report.json")
    if not (same_path(payload.get("reportPath"), report_json) or same_path(payload.get("report"), report_json)):
        raise ValueError("review reportPath does not match report.json")
    if not same_path(payload.get("expectedSaveAs"), review_json):
        raise ValueError("review expectedSaveAs does not match review.json")
    if payload.get("status") not in {"pass", "review"}:
        raise ValueError("review status must be 'pass' or 'review'")
    if not isinstance(payload.get("reasons"), list):
        raise ValueError("review reasons must be an array")
    stats = payload.get("stats")
    if not isinstance(stats, dict):
        raise ValueError("review stats must be an object")
    if stats.get("reportSha256") != expected_sha:
        raise ValueError("review stats.reportSha256 does not match report.json")
    for key in ("rounds", "reviewedRounds", "candidateWins", "baselineWins", "ties", "rerenders"):
        if not isinstance(stats.get(key), int) or int(stats.get(key)) < 0:
            raise ValueError(f"review stats.{key} must be a non-negative integer")
    for key in ("candidateWinRate", "minCandidateWinRate"):
        if not isinstance(stats.get(key), (int, float)):
            raise ValueError(f"review stats.{key} must be numeric")
    if not isinstance(payload.get("missingChoices"), list):
        raise ValueError("review missingChoices must be an array")
    if not isinstance(payload.get("invalidChoices"), list):
        raise ValueError("review invalidChoices must be an array")
    if not isinstance(payload.get("choices"), dict):
        raise ValueError("review choices must be an object")


def make_handler(root: Path, report_html: Path, report_json: Path, review_json: Path) -> type[BaseHTTPRequestHandler]:
    class ReviewHandler(BaseHTTPRequestHandler):
        server_version = "AnyVoiceReview/1.0"

        def log_message(self, format: str, *args: Any) -> None:
            print(f"{self.address_string()} - {format % args}")

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if urlparse(self.path).path != "/review":
                self.send_json(404, {"error": "not found"})
                return
            try:
                size = int(self.headers.get("Content-Length") or "0")
                if size <= 0 or size > 2_000_000:
                    raise ValueError("invalid review payload size")
                payload = json.loads(self.rfile.read(size).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("review payload must be a JSON object")
                validate_review(payload, report_json, review_json)
                review_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            except Exception as exc:
                self.send_json(400, {"error": str(exc)})
                return
            self.send_json(200, {"status": "saved", "path": str(review_json)})

        def do_GET(self) -> None:
            raw_path = unquote(urlparse(self.path).path)
            if raw_path in {"", "/"}:
                target = report_html
            else:
                candidate = (root / raw_path.lstrip("/")).resolve(strict=False)
                try:
                    candidate.relative_to(root)
                except ValueError:
                    self.send_error(403)
                    return
                target = candidate
            if not target.is_file():
                self.send_error(404)
                return
            content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return ReviewHandler


def bind_server(
    *,
    host: str,
    port: int,
    handler: type[BaseHTTPRequestHandler],
    port_retries: int,
    strict_port: bool,
) -> ThreadingHTTPServer:
    attempts = [port] if port == 0 or strict_port else list(range(port, port + max(1, port_retries + 1)))
    last_error: OSError | None = None
    for candidate_port in attempts:
        try:
            return ThreadingHTTPServer((host, candidate_port), handler)
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
            last_error = exc
    raise SystemExit(f"could not bind review server on {host}:{port}; port is in use") from last_error


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve an AnyVoice blind review report and save review.json beside it.")
    parser.add_argument("--report-html", required=True, help="Path to generated report.html")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--port-retries", type=int, default=20, help="Try the next N ports if --port is already in use.")
    parser.add_argument("--strict-port", action="store_true", help="Fail instead of trying the next port when --port is busy.")
    parser.add_argument("--open", action="store_true", help="Open the local review URL in the default browser")
    args = parser.parse_args()

    report_html = Path(args.report_html).expanduser().resolve()
    if not report_html.is_file():
        raise SystemExit(f"report HTML not found: {report_html}")
    report_json = report_html.with_suffix(".json")
    if not report_json.is_file():
        raise SystemExit(f"sibling report JSON not found: {report_json}")
    load_json(report_json)
    root = report_html.parent.resolve()
    review_json = root / "review.json"

    httpd = bind_server(
        host=args.host,
        port=args.port,
        handler=make_handler(root, report_html, report_json, review_json),
        port_retries=args.port_retries,
        strict_port=args.strict_port,
    )
    url = f"http://{args.host}:{httpd.server_port}/"
    print(json.dumps({"status": "serving", "url": url, "reviewJson": str(review_json)}, ensure_ascii=False), flush=True)
    if args.open:
        subprocess.run(["open", url], check=False)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
