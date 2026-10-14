"""Checks that a Maestro build opens no connection off the machine during local use.

Runs a `maestro mcp` session (every local tool once, the Viewer left on) and then
`maestro test` on a flow and on a missing flow, against one booted simulator. Each
run starts with MAESTRO_CLI_NO_ANALYTICS and MAESTRO_DISABLE_UPDATE_CHECK removed and
XDG_STATE_HOME pointed at a fresh empty directory, so the build sees a first run with
no opt-out anywhere, and `lsof -i` samples the java process every 0.25 s from spawn
to exit. Usage: maestro/README.md, "Live checks".
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_check import Mcp, booted, runner_listeners, xcodebuild_runs  # noqa: E402

OPT_OUTS = ("MAESTRO_CLI_NO_ANALYTICS", "MAESTRO_DISABLE_UPDATE_CHECK")
FLOW = 'appId: com.apple.springboard\n---\n- tapOn: "Files"\n- pressKey: Home\n'


def first_run_env():
    env = {k: v for k, v in os.environ.items() if k not in OPT_OUTS}
    env["XDG_STATE_HOME"] = tempfile.mkdtemp(prefix="maestro-state-")
    return env


def is_loopback(endpoint):
    host = endpoint.rsplit(":", 1)[0]
    return host in ("localhost", "[::1]") or host.startswith("127.")


class SocketSampler:
    """Every non-loopback endpoint `lsof -i` shows for one process while it runs."""

    def __init__(self, pid, is_running):
        self.pid, self.is_running = pid, is_running
        self.samples, self.seen = [], {}
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while not self.stop.is_set() and self.is_running():
            started = time.time()
            out = subprocess.run(["lsof", "-nP", "-a", "-p", str(self.pid), "-i"], capture_output=True, text=True).stdout
            self.samples.append(started)
            for line in out.splitlines()[1:]:
                parts = line.split()
                name = parts[8] if len(parts) > 8 else line
                if all(is_loopback(end) for end in name.split("->")):
                    continue
                key = " ".join(parts[7:])
                entry = self.seen.setdefault(key, {"first": started, "count": 0, "line": line})
                entry["count"] += 1
            time.sleep(max(0.0, 0.25 - (time.time() - started)))

    def finish(self):
        self.stop.set()
        self.thread.join(timeout=5)
        gaps = [round(b - a, 3) for a, b in zip(self.samples, self.samples[1:])]
        return {"samples": len(self.samples), "max_gap_s": max(gaps) if gaps else None, "non_loopback": self.seen}


def mcp_session(maestro, udid, work_dir):
    proc_env = first_run_env()
    mcp = Mcp([maestro, "mcp"], proc_env, os.path.join(work_dir, "mcp.stderr"))
    sampler = SocketSampler(mcp.proc.pid, lambda: mcp.proc.poll() is None)
    calls = []

    def call(label, name, arguments, expect_error=False, must_contain=None):
        elapsed, error, text = mcp.call_tool(name, arguments)
        ok = error == expect_error and (must_contain is None or must_contain in text)
        calls.append({
            "label": label, "tool": name, "secs": round(elapsed, 3), "is_error": error, "pass": ok,
            "viewer_instruction": "surface" in text.lower() or "Important: Maestro Viewer" in text,
            "text_head": text[:300],
        })

    try:
        time.sleep(1.0)
        mcp.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "no-egress-check", "version": "0"},
        })
        mcp.notify("notifications/initialized", {})
        mcp.request("tools/list", {})
        call("list_devices", "list_devices", {}, must_contain=udid)
        call("inspect_screen", "inspect_screen", {"device_id": udid})
        call("take_screenshot", "take_screenshot", {"device_id": udid})
        call("run tap Files", "run", {"device_id": udid, "yaml": FLOW})
        call("run invalid yaml", "run", {"device_id": udid, "yaml": "appId: [unclosed\n---\n- tapOn: {\n"},
             expect_error=True)
        call("inspect_screen again", "inspect_screen", {"device_id": udid})
        call("open_maestro_viewer", "open_maestro_viewer", {}, must_contain="http://127.0.0.1:")
        time.sleep(2.0)
    finally:
        code, _ = mcp.close(timeout=60)
    sockets = sampler.finish()
    return {"exit": code, "calls": calls, **sockets,
            "pass": code == 0 and all(c["pass"] and not c["viewer_instruction"] for c in calls)}


def maestro_test(maestro, udid, flow_path, expected_exit, log_path):
    with open(log_path, "w") as log:
        proc = subprocess.Popen([maestro, "--device", udid, "test", flow_path], stdout=log, stderr=subprocess.STDOUT,
                                env=first_run_env())
        sampler = SocketSampler(proc.pid, lambda: proc.poll() is None)
        try:
            code = proc.wait(timeout=300)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = proc.wait()
    sockets = sampler.finish()
    return {"flow": flow_path, "exit": code, "expected_exit": expected_exit, **sockets, "pass": code == expected_exit}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--maestro", required=True, help="path to the built bin/maestro")
    parser.add_argument("--sim", required=True, help="UDID of a booted simulator no other Maestro is using")
    parser.add_argument("--work-dir", required=True, help="directory for logs and the JSON report")
    args = parser.parse_args()

    if not os.environ.get("JAVA_HOME"):
        sys.exit("set JAVA_HOME to a JDK 17 home")
    if not booted(args.sim):
        sys.exit(f"simulator {args.sim} is not booted; boot it with 'xcrun simctl boot {args.sim}'")
    if runner_listeners([args.sim])[args.sim] or xcodebuild_runs([args.sim]):
        sys.exit(f"a runner or xcodebuild already serves {args.sim}; stop it first")
    os.makedirs(args.work_dir, exist_ok=True)
    flow = os.path.join(args.work_dir, "flow.yaml")
    with open(flow, "w") as f:
        f.write(FLOW)

    runs = {
        "mcp session": mcp_session(args.maestro, args.sim, args.work_dir),
        "maestro test, a flow": maestro_test(args.maestro, args.sim, flow, 0, os.path.join(args.work_dir, "test-flow.log")),
        "maestro test, a missing flow": maestro_test(args.maestro, args.sim, os.path.join(args.work_dir, "no-such-flow.yaml"),
                                                     1, os.path.join(args.work_dir, "test-missing.log")),
    }
    failed = []
    for label, run in runs.items():
        verdict = run["pass"] and not run["non_loopback"]
        if not verdict:
            failed.append(label)
        print(f"[{'PASS' if verdict else 'FAIL'}] {label}: exit {run['exit']}, {run['samples']} lsof samples "
              f"(max gap {run['max_gap_s']} s), {len(run['non_loopback'])} non-loopback endpoints", flush=True)
        for endpoint, seen in run["non_loopback"].items():
            print(f"    {endpoint} (samples={seen['count']})")
        for c in run.get("calls", []):
            print(f"    {c['label']}: pass={c['pass']} is_error={c['is_error']} "
                  f"viewer_instruction={c['viewer_instruction']} {c['secs']} s")
    with open(os.path.join(args.work_dir, "no-egress.json"), "w") as f:
        json.dump(runs, f, indent=2)
    print(f"{len(runs) - len(failed)}/{len(runs)} runs passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
