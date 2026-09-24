#!/usr/bin/env python3
"""Run the isolated native compose stack. Never reads the application's .env."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.request
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parents[1]
KEYS = ("sourceId", "runId", "genesisHash", "chainId")
ENV_KEYS = ("SIMULATOR_SOURCE_ID", "SIMULATOR_RUN_ID", "SIMULATOR_GENESIS_HASH", "SIMULATOR_CHAIN_ID")
LOCALHOST = ("localhost", "127.0.0.1", "[::1]")


def read_env(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line and not line.startswith("#"))


def write_env(path, values):
    for key, value in values.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise SystemExit(f"Unsupported environment key {key!r}")
        if any(c in value for c in "\n\r\0$#'\""):
            raise SystemExit(f"Unsupported environment character in {key}")
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write("# Private simulator configuration. Do not commit.\n")
        out.writelines(f"{k}={v}\n" for k, v in values.items())
    os.replace(temporary, path)


def origin_host(origin):
    try:
        parsed = urllib.request.urlparse(origin)
    except ValueError:
        raise SystemExit("Invalid --auth-public-origin")
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise SystemExit("--auth-public-origin must be an exact origin such as https://example.net")
    return parsed.hostname or ""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "Redirect refused", headers, fp)


def status(url):
    req = urllib.request.Request(url.rstrip("/") + "/sim/v1/status")
    with urllib.request.build_opener(NoRedirect).open(req, timeout=5) as response:
        raw = response.read(131073)
        if len(raw) > 131072:
            raise ValueError("oversized status")
        data = json.loads(raw)
    if data.get("authentication") != "unsigned-simulator-v1" or data.get("role") not in ("producer", "full"):
        raise ValueError("unexpected source profile")
    return data


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["init", "up", "stop", "status", "control", "compose"])
    p.add_argument("action", nargs="?", help="control: pause|step|resume; compose: first compose argument")
    p.add_argument("arguments", nargs="*", help="compose: remaining compose arguments (put `--` before any that start with a dash)")
    p.add_argument("--state-dir", type=Path, default=ROOT / ".simulator")
    p.add_argument("--peer", help="Remote HTTPS source; all four identity pins are required")
    p.add_argument("--source-id")
    p.add_argument("--run-id")
    p.add_argument("--genesis-hash")
    p.add_argument("--chain-id", default="9001")
    p.add_argument("--public-port", type=int, default=9400)
    p.add_argument("--frontend-port", type=int, default=23561)
    p.add_argument("--explorer-frontend-port", type=int, default=23562, help="Loopback port of the hosted-explorer frontend")
    p.add_argument("--auth-public-origin", help="Exact browser origin of the primary UI (default: http://localhost:FRONTEND_PORT)")
    p.add_argument("--ui-mode", choices=["explorer", "debug"], default="explorer", help="View served by the primary frontend")
    p.add_argument("--hosted-explorer", action="store_true", help="Also run the read-only explorer backend/frontend pair for a second origin")
    p.add_argument("--producer-start", choices=["paused", "running"], default="paused", help="Producer startup policy after every (re)start")
    p.add_argument("--private-env", type=Path, help="KEY=VALUE file merged into the private configuration (Google OAuth credentials, public URLs); never pass secrets as arguments")
    p.add_argument("--local-login", action="store_true", help="Explicit test-only localhost token login; secret stays in the private env file")
    args = p.parse_args()
    directory = args.state_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    env_file = directory / ".env.simulator.local"
    if args.command == "init":
        if env_file.exists():
            p.error("state already initialized; use up, or a NEW --state-dir for a separate retained run")
        if args.peer and (not args.peer.startswith("https://") or not all([args.source_id, args.run_id, args.genesis_hash])):
            p.error("remote mode requires HTTPS and explicit --source-id, --run-id, --genesis-hash, --chain-id")
        if args.peer and args.producer_start == "running":
            p.error("--producer-start applies to the local producer only")
        origin = args.auth_public_origin or f"http://localhost:{args.frontend_port}"
        local_origin = origin_host(origin) in LOCALHOST
        if args.local_login and not local_origin:
            p.error("--local-login is a localhost-only testing option; never enable it on a public origin")
        values = {
            "SIMULATOR_MODE": "remote" if args.peer else "local",
            "SIMULATOR_SCHEMA": "sim_v1",
            "SIMULATOR_ALLOW_PRIVATE_HTTP": "false" if args.peer else "true",
            "SIMULATOR_DB_PASSWORD": secrets.token_hex(24),
            "SIMULATOR_CONTROL_TOKEN": secrets.token_hex(32),
            "SIMULATOR_CONTROL_URL": "" if args.peer else "http://producer:9401",
            "SIMULATOR_URL": args.peer or "http://producer:9400",
            "SIMULATOR_FULL_URL": "" if args.peer else "http://full:9403",
            "SIMULATOR_LIGHT_URL": "http://light:9402",
            "SIMULATOR_RUST_REPO": str(ROOT.parent / "arkiv-db-pure-astra"),
            "SIMULATOR_SOURCE_ID": args.source_id or str(uuid.uuid4()),
            "SIMULATOR_RUN_ID": args.run_id or "0" * 32,
            "SIMULATOR_GENESIS_HASH": args.genesis_hash or "0x" + "0" * 64,
            "SIMULATOR_CHAIN_ID": args.chain_id,
            "SIMULATOR_PUBLIC_PORT": str(args.public_port),
            "SIMULATOR_FRONTEND_PORT": str(args.frontend_port),
            "SIMULATOR_EXPLORER_FRONTEND_PORT": str(args.explorer_frontend_port),
            "SIMULATOR_UI_MODE": args.ui_mode,
            "SIMULATOR_HOSTED_EXPLORER": "true" if args.hosted_explorer else "false",
            "SIMULATOR_PRODUCER_START": args.producer_start,
            # The light process is local to the browser only when the UI is opened on this machine.
            "SIMULATOR_VERIFIER_LOCATION": "local" if local_origin else "server",
            "SIMULATOR_PUBLIC_NODE_URL": args.peer or "",
            "SIMULATOR_PEER_UI_URL": "",
            "SIMULATOR_EXPLORER_PEER_UI_URL": "",
            "AUTH_PUBLIC_ORIGIN": origin,
            "AUTH_INSECURE_LOCALHOST": "true" if args.local_login else "false",
            "AUTH_TOKEN_LOGIN_ENABLED": "true" if args.local_login else "false",
            "AUTH_TOKEN_LOGIN_TOKEN": secrets.token_hex(32) if args.local_login else "",
            "AUTH_ADMIN_EMAILS": "operator@example.test" if args.local_login else "sieciech.czajka@golem.network",
        }
        if args.private_env:
            # Deployment-only settings and secrets come from a file, never from argv.
            extra = read_env(args.private_env.resolve())
            for key in extra:
                if key in ENV_KEYS or key in ("SIMULATOR_MODE", "SIMULATOR_DB_PASSWORD", "SIMULATOR_CONTROL_TOKEN"):
                    raise SystemExit(f"{key} is generated or pinned by the launcher; remove it from --private-env")
            values.update(extra)
        write_env(env_file, values)
    elif not env_file.exists():
        p.error("run init first; no production .env is read")
    values = read_env(env_file)
    project = "arkiv-sim-" + hashlib.sha256(str(directory).encode()).hexdigest()[:10]
    base = ["docker", "compose", "--env-file", str(env_file), "--project-name", project, "--file", str(ROOT / "compose.simulator.yml")]
    if values["SIMULATOR_MODE"] == "local":
        base += ["--profile", "local"]
    if values.get("SIMULATOR_HOSTED_EXPLORER") == "true":
        base += ["--profile", "hosted-explorer"]
    # Explicit env overrides must never accidentally import live application credentials.
    child_env = {k: v for k, v in os.environ.items() if not (k.startswith(("SIMULATOR_", "AUTH_", "GOOGLE_")) or k == "DATABASE_URL")}
    def compose(*arguments, capture=False):
        return subprocess.run(base + list(arguments), cwd=ROOT, env=child_env, check=True,
                              text=True, stdout=subprocess.PIPE if capture else None)
    peer = values["SIMULATOR_URL"] if values["SIMULATOR_MODE"] == "remote" else f'http://127.0.0.1:{values["SIMULATOR_PUBLIC_PORT"]}'
    if args.command in ["init", "up"]:
        compose("up", "--build", "-d", "postgres", *(["producer"] if values["SIMULATOR_MODE"] == "local" else []))
        deadline = time.monotonic() + 60
        while True:
            try:
                source = status(peer)
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise SystemExit("Source unavailable; configuration and volumes retained. Inspect docker compose logs, then use up.")
                time.sleep(1)
        expected = dict(zip(KEYS, (values[k] for k in ENV_KEYS)))
        if values["SIMULATOR_RUN_ID"] == "0" * 32 and values["SIMULATOR_MODE"] == "local":
            if source["sourceId"] != expected["sourceId"] or source["chainId"] != expected["chainId"]:
                raise SystemExit("Initial source identity mismatch; consumers remain stopped")
            values.update({key: source[field] for field, key in zip(KEYS, ENV_KEYS)})
            write_env(env_file, values)
        elif any(source.get(k) != v for k, v in expected.items()):
            raise SystemExit("Pinned run mismatch. No automatic reset or rebinding; use a new state directory for a new run.")
        # Every remaining service of the active profiles: followers, scanner, APIs and UIs.
        compose("up", "--build", "-d")
        print(f'Primary UI ({values.get("SIMULATOR_UI_MODE", "explorer")}): http://localhost:{values["SIMULATOR_FRONTEND_PORT"]}')
        if values.get("SIMULATOR_HOSTED_EXPLORER") == "true":
            print(f'Hosted explorer UI: http://localhost:{values.get("SIMULATOR_EXPLORER_FRONTEND_PORT", "23562")}')
        print("Local producer starts " + values.get("SIMULATOR_PRODUCER_START", "paused") if values["SIMULATOR_MODE"] == "local" else "Remote source pinned; local controls disabled")
        print(f"Private configuration: {env_file}; volumes retained under compose project {project}")
    elif args.command == "stop":
        compose("stop")  # Never down -v: historical data is retained.
    elif args.command == "status":
        print(json.dumps(status(peer), indent=2))
    elif args.command == "compose":
        # Operator passthrough with the same env file, project name and profiles (ps, logs, restart ...).
        compose(*([args.action] if args.action else []), *args.arguments)
    elif args.command == "control":
        if values["SIMULATOR_MODE"] != "local" or args.action not in ("pause", "step", "resume"):
            p.error("control needs local mode and pause|step|resume")
        # Operator invocation inside the isolated network; private bearer never appears in argv or output.
        code = '''const action=process.argv[1];const s=await(await fetch(process.env.SIMULATOR_URL+"/sim/v1/status")).json();const body={commandId:"0x"+crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-",""),runId:s.runId,expectedRevision:s.configRevision,expectedHeight:action==="step"?s.head.height:null,action,config:null};const r=await fetch(process.env.SIMULATOR_CONTROL_URL+"/sim/v1/control",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.SIMULATOR_CONTROL_TOKEN},body:JSON.stringify(body)});console.log(await r.text());if(!r.ok)process.exit(1);'''
        compose("exec", "-T", "backend", "bun", "--no-env-file", "-e", code, args.action)


if __name__ == "__main__":
    main()
