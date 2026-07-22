#!/usr/bin/env python3
"""Fetch portal credentials from GCP Secret Manager into a root-only runtime file."""

from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

METADATA_ROOT = "http://metadata.google.internal/computeMetadata/v1"
OUTPUT_PATH = Path(os.environ.get(
    "PORTAL_CREDENTIALS_OUTPUT",
    "/run/darven-worker-secrets/portal-credentials.json",
))
SECRET_NAMES = {
    "username": os.environ.get("PORTAL_USERNAME_SECRET", "darven-portal-username"),
    "password": os.environ.get("PORTAL_PASSWORD_SECRET", "darven-portal-password"),
}


def request_json(url: str, headers: dict[str, str], timeout: int = 20) -> dict:
    request = Request(url, headers=headers)
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def metadata_text(path: str) -> str:
    request = Request(f"{METADATA_ROOT}/{path}", headers={"Metadata-Flavor": "Google"})
    with urlopen(request, timeout=10) as response:
        return response.read().decode("utf-8").strip()


def fetch_secret(project_id: str, access_token: str, secret_name: str) -> str:
    name = quote(secret_name, safe="")
    project = quote(project_id, safe="")
    payload = request_json(
        f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{name}/versions/latest:access",
        {"Authorization": f"Bearer {access_token}"},
    )
    encoded = payload.get("payload", {}).get("data")
    if not encoded:
        raise RuntimeError(f"Secret {secret_name} has no enabled latest version")
    value = base64.b64decode(encoded, validate=True).decode("utf-8")
    if not value:
        raise RuntimeError(f"Secret {secret_name} is empty")
    return value


def atomic_write_secret(path: Path, value: dict[str, str]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o400)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    project_id = metadata_text("project/project-id")
    token_payload = request_json(
        f"{METADATA_ROOT}/instance/service-accounts/default/token",
        {"Metadata-Flavor": "Google"},
        timeout=10,
    )
    access_token = str(token_payload.get("access_token") or "")
    if not access_token:
        raise RuntimeError("VM service-account access token is unavailable")
    credentials = {
        field: fetch_secret(project_id, access_token, secret_name)
        for field, secret_name in SECRET_NAMES.items()
    }
    atomic_write_secret(OUTPUT_PATH, credentials)
    print("portal credentials prepared")


if __name__ == "__main__":
    main()
