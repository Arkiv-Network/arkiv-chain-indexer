#!/usr/bin/env python3
"""A throwaway UDC chain for the explorer end-to-end harness (docs/udc-e2e.md).

One arkiv-state-db-experiment producer runs in docker as container
`udc-e2e-node` on network `arkiv-udc-e2e`, its public JSON-RPC/REST on
127.0.0.1:28545 and its private control listener on 127.0.0.1:28546. Explorer
containers on the same network reach it as http://udc-e2e-node:8545.

The genesis is the node repo's UDC SDK smoke fixture (chain 9405, three
prefilled entities with bytes, 500 ms blocks, 200,000 storage units per block),
taken from NODE_DIR/scripts/genesis-bundle-smoke.py and edited exactly as
NODE_DIR/scripts/udc-sdk-smoke.py edits it, plus three fresh funded keys (the
SDK network-health key and two traffic accounts) and a start time a few seconds
ahead. The producer does not wait for start_time and stamps block h with
start_time + h * period, so the container starts early and a wrapper inside it
execs the producer at exactly start_time.

    udc-devnet.py up      [--run-dir DIR] [--lead SECONDS] [--block-period-ms MS]
    udc-devnet.py status  [--run-dir DIR]
    udc-devnet.py down    [--run-dir DIR] [--purge]

Environment:
    NODE_DIR            arkiv-state-db-experiment checkout (read only)
    ARKIV_PROPOSER_BIN  arkiv-proposer binary (default NODE_DIR/target/release/arkiv-proposer)
    UDC_E2E_DIR         harness state (default ~/.cache/arkiv-udc-e2e); run dir = UDC_E2E_DIR/devnet
    UDC_E2E_NODE_IMAGE  runtime image (default arkiv-prefill-runtime:20261023)

The run dir holds devnet.json (public facts) and secrets.json (0600: every
account key and the private-control token). Nothing secret is printed.
`down` removes only the container and network carrying this run's label;
`--purge` also deletes the run dir. `--block-period-ms` departs from the
smoke's 500 ms (the node's udc-sdk-smoke.ts exercise asserts 500 ms values;
the SDK network-health test assumes 2 s blocks in two of its checks).
"""

import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

IDX = Path(__file__).resolve().parents[1]
NODE_DIR = Path(os.environ.get("NODE_DIR", IDX.parent / "arkiv-state-db-experiment")).resolve()
BINARY = Path(
    os.environ.get("ARKIV_PROPOSER_BIN", NODE_DIR / "target/release/arkiv-proposer")
).resolve()
STATE = Path(os.environ.get("UDC_E2E_DIR", Path.home() / ".cache/arkiv-udc-e2e")).resolve()
IMAGE = os.environ.get("UDC_E2E_NODE_IMAGE", "arkiv-prefill-runtime:20261023")
CONTAINER = "udc-e2e-node"
NETWORK = "arkiv-udc-e2e"
PUBLIC = ("127.0.0.1", 28545)
PRIVATE = ("127.0.0.1", 28546)
LABEL = "network.arkiv.udc-e2e"
DEFAULT_PERIOD_MS = 500
# Fixture identities from genesis-bundle-smoke.py: public, disposable keys.
FIXTURE_KEYS = {"proposer": 0x01, "alice": 0x02, "bob": 0x03}
# Fresh keys funded at genesis: (secrets.json name, genesis label, balance in GLM).
FRESH = (("health", "health", 100), ("trafficA", "traffic_a", 100), ("trafficB", "traffic_b", 100))
GLM = 10**18


def fail(message):
    print(f"udc-devnet: {message}", file=sys.stderr)
    sys.exit(1)


def docker(*args, check=True, capture=True):
    """Runs `docker ARGS` through `sg docker` (sessions predating the group change)."""
    command = " ".join(_quote(a) for a in ("docker", *map(str, args)))
    result = subprocess.run(
        ["sg", "docker", "-c", command], capture_output=capture, text=True, timeout=300
    )
    if check and result.returncode != 0:
        fail(f"docker {args[0]} failed: {(result.stderr or '').strip()[-2000:]}")
    return result


def _quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def replace_once(source, old, new):
    count = source.count(old)
    if count != 1:
        fail(f"fixture changed upstream: expected one {old!r}, found {count}")
    return source.replace(old, new)


def load_fixture():
    path = NODE_DIR / "scripts/genesis-bundle-smoke.py"
    if not path.is_file():
        fail(f"{path} not found; set NODE_DIR to an arkiv-state-db-experiment checkout")
    spec = importlib.util.spec_from_file_location("genesis_fixture", path)
    module = importlib.util.module_from_spec(spec)
    # NODE_DIR is read only: no __pycache__ next to its scripts.
    sys.dont_write_bytecode = True
    spec.loader.exec_module(module)
    return module.FIXTURE


def chain_source(start_time, fresh, period_ms):
    """The UDC smoke's genesis (udc-sdk-smoke.py's edits), plus our start time and keys."""
    source = load_fixture()
    # As udc-sdk-smoke.py: 500 ms blocks, prefills alive for the run, the 200k cap.
    source = replace_once(source, 'block_period_ms = "5000"', f'block_period_ms = "{period_ms}"')
    for old, new in ((4, 10000), (5, 10001), (6, 10002)):
        source = replace_once(source, f'expires_at_height = "{old}"', f'expires_at_height = "{new}"')
    source = replace_once(
        source,
        'profile = { preset = "arkiv-entity-v3/glm-v2@4" }',
        'profile = { path = "profile.toml" }',
    )
    # The harness: a start time just ahead, and funded fresh keys.
    source = replace_once(source, 'start_time = "2026-09-25T00:00:00Z"', f'start_time = "{start_time}"')
    match = re.search(r'expected_initial_supply_wei = "(\d+)"', source)
    if not match:
        fail("fixture changed upstream: no expected_initial_supply_wei")
    supply = int(match.group(1)) + sum(glm * GLM for _, _, glm in FRESH)
    source = replace_once(source, match.group(0), f'expected_initial_supply_wei = "{supply}"')
    entries = "".join(
        f'\n[[allocations.entry]]\nlabel = "{label}"\naddress = "{fresh[name]}"\n'
        f'balance_wei = "{glm * GLM}"\n'
        for name, label, glm in FRESH
    )
    return replace_once(source, "\n[prefill]\n", entries + "\n[prefill]\n")


def profile_source():
    """The fixed-glm-v2 profile with the UDC smoke's 200,000-unit per-block storage cap."""
    profile = (NODE_DIR / "docs/examples/genesis-bundle/profiles/fixed-glm-v2.toml").read_text()
    return replace_once(
        profile,
        'max_new_storage_units_per_block = "1500000"',
        'max_new_storage_units_per_block = "200000"',
    )


def cli(*args):
    result = subprocess.run(
        [str(BINARY), *map(str, args)], capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        fail(f"arkiv-proposer {args[0]} {args[1] if len(args) > 1 else ''} failed: "
             f"{result.stderr.strip()[-2000:]}")
    return result.stdout


def write_private(path, text):
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(text)


def http_json(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def rpc(method, params=()):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)})
    request = urllib.request.Request(
        f"http://{PUBLIC[0]}:{PUBLIC[1]}", data=body.encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        answer = json.load(response)
    if "error" in answer:
        raise RuntimeError(f"{method}: {answer['error']}")
    return answer["result"]


def node_status():
    return http_json(f"http://{PUBLIC[0]}:{PUBLIC[1]}/signed/v1/status")


def container_info():
    result = docker("inspect", CONTAINER, check=False)
    if result.returncode != 0:
        return None
    return json.loads(result.stdout)[0]


def network_info():
    result = docker("network", "inspect", NETWORK, check=False)
    if result.returncode != 0:
        return None
    return json.loads(result.stdout)[0]


def git_commit(path):
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "--short", "HEAD"], capture_output=True, text=True
    )
    return result.stdout.strip() or None


def up(run, lead, period_ms):
    if not BINARY.is_file():
        fail(f"{BINARY} not found; build it or set ARKIV_PROPOSER_BIN")
    if container_info() is not None:
        fail(f"container {CONTAINER} exists; run `udc-devnet.py down` first")
    network = network_info()
    if network is not None and (network.get("Labels") or {}).get(LABEL) is None:
        fail(f"network {NETWORK} exists and was not created by this harness; not touching it")
    if run.exists() and any(run.iterdir()):
        if not (run / "devnet.json").is_file():
            fail(f"{run} is not empty and holds no devnet.json; refusing to reuse it")
        shutil.rmtree(run)
    run.mkdir(parents=True, mode=0o700)
    run.chmod(0o700)
    keys = run / "keys"
    keys.mkdir(mode=0o700)
    accounts = {}
    for name, byte in FIXTURE_KEYS.items():
        write_private(keys / f"{name}.key", "0x" + f"{byte:02x}" * 32)
    for name, _, _ in FRESH:
        address = cli("keygen", "--out", keys / f"{name}.key").strip()
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
            fail("unexpected keygen output")
        accounts[name] = address.lower()
    fixture_addresses = {
        "proposer": "0x1a642f0e3c3af545e7acbd38b07251b3990914f1",
        "alice": "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c",
        "bob": "0x3325a78425f17a7e487eb5666b2bfd93abb06c70",
    }
    accounts = {**fixture_addresses, **accounts}
    (run / "profile.toml").write_text(profile_source())

    # Build the bundle for a start time a few whole seconds ahead; rebuild if
    # building ate the margin.
    for _ in range(3):
        start = int(time.time()) + lead
        start_time = datetime.datetime.fromtimestamp(start, datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        (run / "chain.toml").write_text(chain_source(start_time, accounts, period_ms))
        for stale in ("genesis.lock.toml", "bundle"):
            target = run / stale
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
        cli("genesis", "lock", run / "chain.toml")
        cli("genesis", "build", run / "chain.toml", "--out", run / "bundle", "--locked")
        if start - time.time() >= 2.5:
            break
    else:
        fail("genesis build keeps overrunning the start lead; raise --lead")

    token = secrets.token_hex(32)
    write_private(run / "node.env", f"ARKIV_PROPOSER_TOKEN={token}\n")
    write_private(
        run / "secrets.json",
        json.dumps(
            {
                "privateControlToken": token,
                "accounts": {
                    name: {
                        "address": accounts[name],
                        "privateKey": (keys / f"{name}.key").read_text().strip(),
                    }
                    for name in accounts
                },
            },
            indent=2,
        )
        + "\n",
    )
    (run / "node").mkdir()

    # Written before any docker resource exists, so `down` can always find this run.
    facts = {
        "container": CONTAINER,
        "network": NETWORK,
        "createdNetwork": False,
        "image": IMAGE,
        "binary": str(BINARY),
        "nodeDir": str(NODE_DIR),
        "nodeCommit": git_commit(NODE_DIR),
        "rpcUrl": f"http://{PUBLIC[0]}:{PUBLIC[1]}",
        "privateUrl": f"http://{PRIVATE[0]}:{PRIVATE[1]}",
        "dockerRpcUrl": f"http://{CONTAINER}:8545",
        "chainId": 9405,
        "startTime": start_time,
        "startTimeMs": start * 1000,
        "blockPeriodMs": period_ms,
        "maxNewStorageUnitsPerBlock": 200000,
        "addresses": accounts,
        "secretsFile": str(run / "secrets.json"),
    }
    (run / "devnet.json").write_text(json.dumps(facts, indent=2) + "\n")
    if network is None:
        docker("network", "create", "--label", f"{LABEL}={run}", NETWORK)
        facts["createdNetwork"] = True
        (run / "devnet.json").write_text(json.dumps(facts, indent=2) + "\n")
    labels = ["--label", f"{LABEL}={run}"]
    # The producer starts at exactly start_time: the wrapper sleeps the rest of
    # the lead inside the container, then execs it.
    wrapper = (
        'now=$(date +%s%N); d=$(($1 - now)); shift; '
        'if [ "$d" -gt 0 ]; then '
        'sleep "$(printf "%d.%09d" $((d / 1000000000)) $((d % 1000000000)))"; fi; '
        'exec "$@"'
    )
    docker(
        "run", "-d", "--name", CONTAINER, "--network", NETWORK, "--user",
        f"{os.getuid()}:{os.getgid()}", *labels,
        "-p", f"{PUBLIC[0]}:{PUBLIC[1]}:8545", "-p", f"{PRIVATE[0]}:{PRIVATE[1]}:8546",
        "-v", f"{run / 'bundle'}:/run/job/bundle:ro",
        "-v", f"{run / 'node'}:/run/job/node",
        "-v", f"{keys / 'proposer.key'}:/run/job/proposer.key:ro",
        "-v", f"{BINARY}:/opt/arkiv/arkiv-proposer:ro",
        "--env-file", run / "node.env",
        IMAGE, "sh", "-c", wrapper, "sh", str(start * 10**9),
        "/opt/arkiv/arkiv-proposer", "producer", "--run-dir", "/run/job/node",
        "--bundle", "/run/job/bundle", "--key-file", "/run/job/proposer.key",
        "--listen", "0.0.0.0:8545", "--private-listen", "0.0.0.0:8546", "--start", "running",
    )

    deadline = time.time() + lead + 30
    first = None
    while time.time() < deadline:
        info = container_info()
        if info and not info["State"]["Running"]:
            logs = docker("logs", "--tail", "50", CONTAINER, check=False)
            fail(f"producer exited: {(logs.stdout + logs.stderr)[-2000:]}")
        try:
            status = node_status()
            if int(status["head"]["height"]) >= 2:
                first = status
                break
        except (OSError, urllib.error.URLError, ValueError, KeyError):
            pass
        time.sleep(0.05)
    if first is None:
        fail("the producer did not reach block 2 in time; see `docker logs udc-e2e-node`")
    identity = first["identity"]
    facts.update(
        genesisHash=identity["genesisHash"],
        runId=identity["runId"],
        sourceId=identity["sourceId"],
        proposer=first["proposer"],
    )
    (run / "devnet.json").write_text(json.dumps(facts, indent=2) + "\n")
    print(json.dumps({**summary(run, facts), "ok": True}, indent=2))


def summary(run, facts):
    """Public facts plus the producer's lag behind its own schedule (no secrets)."""
    out = {
        "runDir": str(run),
        "container": facts["container"],
        "rpcUrl": facts["rpcUrl"],
        "privateUrl": facts["privateUrl"],
        "dockerRpcUrl": facts["dockerRpcUrl"],
        "network": facts["network"],
        "chainId": facts["chainId"],
        "startTime": facts["startTime"],
        "genesisHash": facts.get("genesisHash"),
        "secretsFile": facts["secretsFile"],
    }
    try:
        head = int(rpc("eth_blockNumber"), 16)
        block = rpc("eth_getBlockByNumber", [hex(head), False])
        stamp = int(block["timestamp"], 16)
        scheduled_ms = facts["startTimeMs"] + head * facts["blockPeriodMs"]
        out.update(
            head=head,
            headTimestamp=stamp,
            # Block timestamps are start + h * period; a positive lag means the
            # chain runs behind wall clock (pauses, slow starts).
            scheduleLagMs=int(time.time() * 1000) - scheduled_ms,
            timestampMatchesSchedule=stamp == scheduled_ms // 1000,
        )
    except (OSError, urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
        out["rpcError"] = str(error)
    return out


def status(run):
    facts_path = run / "devnet.json"
    info = container_info()
    out = {
        "container": None
        if info is None
        else {"state": info["State"]["Status"], "ours": (info["Config"]["Labels"] or {}).get(LABEL) == str(run)},
    }
    if facts_path.is_file():
        out.update(summary(run, json.loads(facts_path.read_text())))
    else:
        out["runDir"] = str(run)
        out["note"] = "no devnet.json in the run dir"
    print(json.dumps(out, indent=2))


def down(run, purge):
    removed = []
    info = container_info()
    if info is not None:
        if (info["Config"]["Labels"] or {}).get(LABEL) == str(run):
            docker("rm", "-f", CONTAINER)
            removed.append(f"container {CONTAINER}")
        else:
            print(f"udc-devnet: {CONTAINER} is not this run's; left alone", file=sys.stderr)
    network = network_info()
    if network is not None:
        if (network.get("Labels") or {}).get(LABEL) == str(run):
            attached = list((network.get("Containers") or {}).values())
            if attached:
                names = ", ".join(c.get("Name", "?") for c in attached)
                print(f"udc-devnet: network {NETWORK} still has {names}; bring the explorer down "
                      "first, then rerun down", file=sys.stderr)
            else:
                docker("network", "rm", NETWORK)
                removed.append(f"network {NETWORK}")
        else:
            print(f"udc-devnet: network {NETWORK} is not this run's; left alone", file=sys.stderr)
    if purge and run.exists():
        if (run / "devnet.json").is_file():
            shutil.rmtree(run)
            removed.append(f"run dir {run}")
        else:
            print(f"udc-devnet: {run} holds no devnet.json; not deleting it", file=sys.stderr)
    print(json.dumps({"removed": removed}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("up", "status", "down"))
    parser.add_argument("--run-dir", type=Path, default=STATE / "devnet")
    parser.add_argument("--lead", type=int, default=6, help="seconds between now and start_time")
    parser.add_argument("--purge", action="store_true", help="down: also delete the run dir")
    parser.add_argument("--block-period-ms", type=int, default=DEFAULT_PERIOD_MS)
    args = parser.parse_args()
    run = args.run_dir.resolve()
    if args.action == "up":
        up(run, max(args.lead, 4), args.block_period_ms)
    elif args.action == "status":
        status(run)
    else:
        down(run, args.purge)


if __name__ == "__main__":
    main()
