"""Live check of a patched Maestro build on two booted iOS simulators.

Drives one `maestro mcp --no-viewer` process: warm both simulators, alternate
inspect_screen between them, kill simulator A's runner and expect the next call
to rebuild the session on a new port, then close the server and expect no
runner to remain. Usage: maestro/README.md, "Live check".
"""

import argparse
import json
import math
import os
import re
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time

RUNNER_COMMAND_PREFIX = "maestro-d"
UDID_IN_PATH = re.compile(r"/Devices/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/")


class Mcp:
    def __init__(self, argv, env, stderr_path):
        self.stderr = open(stderr_path, "w")
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True, env=env
        )
        self.next_id = 0

    def request(self, method, params=None):
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"MCP server closed stdout while waiting for {method}")
            try:
                reply = json.loads(line)
            except json.JSONDecodeError:
                continue
            if reply.get("id") == self.next_id:
                return reply

    def notify(self, method, params=None):
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def call_tool(self, name, arguments):
        started = time.perf_counter()
        reply = self.request("tools/call", {"name": name, "arguments": arguments})
        elapsed = time.perf_counter() - started
        if "error" in reply:
            return elapsed, True, json.dumps(reply["error"])
        result = reply.get("result", {})
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        return elapsed, bool(result.get("isError")), text

    def _send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def close(self, timeout):
        started = time.perf_counter()
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            code = self.proc.wait(timeout=timeout)
        finally:
            if self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait()
            self.stderr.close()
        return code, time.perf_counter() - started


class Jdb:
    """Reads a private field of the running MCP server through JDWP."""

    PROMPT = re.compile(r"(^|\n)(> |\S+\[\d+\] )$")

    def __init__(self, jdb_path, port):
        self.proc = subprocess.Popen(
            [jdb_path, "-attach", f"127.0.0.1:{port}"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=0,
        )
        self.buffer = ""
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()
        self._wait_from(0, timeout=30)

    def _read(self):
        while True:
            chunk = self.proc.stdout.read(1)
            if not chunk:
                return
            with self.lock:
                self.buffer += chunk

    def _wait_from(self, mark, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                tail = self.buffer[mark:]
            if self.PROMPT.search(tail):
                time.sleep(0.2)
                with self.lock:
                    if self.buffer[mark:] == tail:
                        return tail
            time.sleep(0.05)
        raise RuntimeError(f"jdb gave no prompt; output so far: {self.buffer[mark:][-500:]!r}")

    def command(self, line, timeout=20):
        with self.lock:
            mark = len(self.buffer)
        self.proc.stdin.write(line + "\n")
        return self._wait_from(mark, timeout)

    def read_int_set(self, frame_method, expression):
        """Integers in a ConcurrentHashMap key set held by a local of the main thread.

        jdb can't call toString() on a thread it suspended with `suspend` (JDI invokes methods
        only on threads stopped by an event), so this walks the map's bins field by field.
        """
        threads = self.command("threads")
        match = re.search(r"\(java\.lang\.Thread\)(\S+)\s+main\s", threads)
        if not match:
            raise RuntimeError(f"no main thread in jdb output: {threads[-500:]!r}")
        thread = match.group(1)
        self.command(f"suspend {thread}")
        try:
            self.command(f"thread {thread}")
            frames = self.command("where")
            index = next(
                (int(m.group(1)) for m in re.finditer(r"\[(\d+)\] (\S+) ", frames) if m.group(2) == frame_method),
                None,
            )
            if index is None:
                raise RuntimeError(f"{frame_method} is not on the main thread's stack")
            if index > 1:
                self.command(f"up {index - 1}")
            table = f"{expression}.map.table"
            if self._value(table, command="dump") == "null":
                return []
            values = []
            for bin_index in range(int(self._value(f"{table}.length"))):
                node = f"{table}[{bin_index}]"
                while self._value(node, command="dump") != "null":
                    values.append(int(self._value(f"{node}.key.value")))
                    node += ".next"
            return sorted(values)
        finally:
            self.command(f"resume {thread}")

    def _value(self, expression, command="print"):
        printed = self.command(f"{command} {expression}")
        match = re.search(re.escape(expression) + r" = (.*)", printed)
        if not match:
            raise RuntimeError(f"jdb printed no value for {expression}: {printed[-500:]!r}")
        return match.group(1).strip()

    def close(self):
        try:
            self.proc.stdin.write("quit\n")
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
            self.proc.wait()


def free_loopback_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def runner_listeners(udids):
    """{udid: {pid: sorted listening ports}} for maestro runner processes of the given simulators."""
    out = subprocess.run(
        ["lsof", "-nP", "+c", "0", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], capture_output=True, text=True
    ).stdout
    by_pid, pid, command = {}, None, ""
    for line in out.splitlines():
        if line.startswith("p"):
            pid, command = int(line[1:]), ""
        elif line.startswith("c"):
            command = line[1:]
        elif line.startswith("n") and pid is not None and command.startswith(RUNNER_COMMAND_PREFIX):
            by_pid.setdefault(pid, set()).add(int(line.rsplit(":", 1)[1]))
    found = {udid: {} for udid in udids}
    for runner_pid, ports in by_pid.items():
        path = subprocess.run(["ps", "-o", "command=", "-p", str(runner_pid)], capture_output=True, text=True).stdout
        match = UDID_IN_PATH.search(path)
        if match and match.group(1) in found:
            found[match.group(1)][runner_pid] = sorted(ports)
    return found


def port_listening(port):
    out = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True
    ).stdout
    return bool(out.strip())


def xcodebuild_runs(udids):
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    return [
        line.strip() for line in out.splitlines()
        if "xcodebuild" in line and "test-without-building" in line and any(u in line for u in udids)
    ]


def booted(udid):
    out = subprocess.run(["xcrun", "simctl", "list", "devices", "-j"], capture_output=True, text=True, check=True).stdout
    for devices in json.loads(out)["devices"].values():
        for device in devices:
            if device["udid"] == udid:
                return device["state"] == "Booted"
    return False


def latency_stats(samples):
    ordered = sorted(samples)
    p90 = ordered[max(0, math.ceil(0.9 * len(ordered)) - 1)]
    return {
        "n": len(ordered),
        "median_s": round(statistics.median(ordered), 3),
        "p90_s": round(p90, 3),
        "min_s": round(ordered[0], 3),
        "max_s": round(ordered[-1], 3),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--maestro", required=True, help="path to the built bin/maestro")
    parser.add_argument("--sim-a", required=True, help="UDID of a booted simulator")
    parser.add_argument("--sim-b", required=True, help="UDID of a second booted simulator")
    parser.add_argument("--rounds", type=int, default=100, help="alternating inspect_screen rounds (default 100)")
    parser.add_argument("--after-rounds", type=int, default=10, help="rounds after the runner kill (default 10)")
    parser.add_argument("--work-dir", required=True, help="directory for logs and the JSON report")
    parser.add_argument("--no-reserved-check", action="store_true",
                        help="skip reading the server's reserved-port set through jdb")
    args = parser.parse_args()

    a, b = args.sim_a, args.sim_b
    udids = (a, b)
    os.makedirs(args.work_dir, exist_ok=True)
    report = {"maestro": args.maestro, "sim_a": a, "sim_b": b, "checks": {}}
    checks = report["checks"]

    def check(name, ok, detail=None):
        checks[name] = {"ok": bool(ok), "detail": detail}
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail is not None else ""), flush=True)

    for udid in udids:
        if not booted(udid):
            sys.exit(f"simulator {udid} is not booted; boot it with 'xcrun simctl boot {udid}'")
    before = runner_listeners(udids)
    if any(before[u] for u in udids) or xcodebuild_runs(udids):
        sys.exit(f"a runner or xcodebuild already serves these simulators: {before}; stop it first")

    java_home = os.environ.get("JAVA_HOME")
    if not java_home:
        sys.exit("set JAVA_HOME to a JDK 17 home")
    env = dict(os.environ)
    jdb = None
    jdwp_port = None
    if not args.no_reserved_check:
        jdwp_port = free_loopback_port()
        env["JAVA_OPTS"] = (env.get("JAVA_OPTS", "") +
                            f" -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:{jdwp_port}").strip()

    started = time.perf_counter()
    mcp = Mcp([args.maestro, "mcp", "--no-viewer"], env, os.path.join(args.work_dir, "mcp.stderr"))
    report["mcp_pid"] = mcp.proc.pid
    try:
        init = mcp.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "live-check", "version": "0"},
        })
        mcp.notify("notifications/initialized", {})
        report["initialize_s"] = round(time.perf_counter() - started, 3)
        report["server_info"] = init.get("result", {}).get("serverInfo")
        tools = [t["name"] for t in mcp.request("tools/list", {})["result"]["tools"]]
        report["tools"] = tools
        _, error, listed = mcp.call_tool("list_devices", {})
        check("list_devices shows both simulators", not error and a in listed and b in listed)

        report["first_inspect_s"] = {}
        for udid in udids:
            elapsed, error, text = mcp.call_tool("inspect_screen", {"device_id": udid})
            report["first_inspect_s"][udid] = round(elapsed, 3)
            check(f"first inspect_screen on {udid}", not error, f"{elapsed:.2f} s" if not error else text[-300:])

        runners_start = runner_listeners(udids)
        report["runners_start"] = {u: {str(p): ports for p, ports in r.items()} for u, r in runners_start.items()}
        check("one runner per simulator after warm-up",
              all(len(runners_start[u]) == 1 for u in udids), report["runners_start"])
        xcodebuild_start = {u: xcodebuild_runs([u]) for u in udids}
        report["xcodebuild_start"] = xcodebuild_start
        check("one xcodebuild per simulator after warm-up",
              all(len(xcodebuild_start[u]) == 1 for u in udids), {u: len(x) for u, x in xcodebuild_start.items()})

        if jdwp_port:
            jdb = Jdb(os.path.join(java_home, "bin", "jdb"), jdwp_port)
            reserved = jdb.read_int_set(
                "maestro.cli.mcp.McpServerKt.runMaestroMcpServer", "sessionManager.reservedXCTestPorts")
            report["reserved_start"] = reserved
            listening = sorted(p for u in udids for ports in runners_start[u].values() for p in ports)
            check("reserved ports are the two runner ports", reserved == listening,
                  f"reserved {reserved}, listening {listening}")

        latencies = {u: [] for u in udids}
        errors = []
        for round_index in range(args.rounds):
            for udid in udids:
                elapsed, error, text = mcp.call_tool("inspect_screen", {"device_id": udid})
                latencies[udid].append(elapsed)
                if error:
                    errors.append({"round": round_index, "udid": udid, "text": text[-300:]})
        report["rounds"] = args.rounds
        report["latency"] = {u: latency_stats(latencies[u]) for u in udids}
        report["errors"] = errors
        check(f"{2 * args.rounds} alternating inspect_screen calls without an error", not errors,
              f"{len(errors)} errors" if errors else None)
        for udid in udids:
            print(f"    {udid}: {report['latency'][udid]}", flush=True)

        runners_end = runner_listeners(udids)
        report["runners_end"] = {u: {str(p): ports for p, ports in r.items()} for u, r in runners_end.items()}
        check("runner pids and ports unchanged across the rounds", runners_end == runners_start,
              report["runners_end"])

        (old_pid, old_ports), = runners_start[a].items()
        old_port = old_ports[0]
        os.kill(old_pid, signal.SIGKILL)
        deadline = time.time() + 10
        while time.time() < deadline and port_listening(old_port):
            time.sleep(0.1)
        report["killed_runner"] = {"udid": a, "pid": old_pid, "port": old_port}

        elapsed, error, text = mcp.call_tool("inspect_screen", {"device_id": a})
        report["recovery_call_s"] = round(elapsed, 3)
        check("inspect_screen on A after its runner was killed", not error,
              f"{elapsed:.2f} s" if not error else text[-300:])

        runners_after = runner_listeners(udids)
        report["runners_after_kill"] = {u: {str(p): ports for p, ports in r.items()} for u, r in runners_after.items()}
        new_a = runners_after[a]
        check("A has one new runner on a new port",
              len(new_a) == 1 and old_pid not in new_a and old_port not in next(iter(new_a.values()), []),
              report["runners_after_kill"][a])
        check("old runner port is not listening", not port_listening(old_port), old_port)
        check("B's runner untouched", runners_after[b] == runners_start[b], report["runners_after_kill"][b])
        xcodebuild_after = {u: xcodebuild_runs([u]) for u in udids}
        report["xcodebuild_after_kill"] = xcodebuild_after
        check("one xcodebuild per simulator after the recovery, and A's is new",
              all(len(xcodebuild_after[u]) == 1 for u in udids)
              and xcodebuild_after[a] != xcodebuild_start[a] and xcodebuild_after[b] == xcodebuild_start[b],
              {u: [line.split()[0] for line in x] for u, x in xcodebuild_after.items()})
        if jdb:
            reserved = jdb.read_int_set(
                "maestro.cli.mcp.McpServerKt.runMaestroMcpServer", "sessionManager.reservedXCTestPorts")
            report["reserved_after_kill"] = reserved
            listening = sorted(p for u in udids for ports in runners_after[u].values() for p in ports)
            check("old port released and the reserved ports are the live runner ports",
                  old_port not in reserved and reserved == listening,
                  f"reserved {reserved}, listening {listening}, old {old_port}")

        after_errors = []
        for round_index in range(args.after_rounds):
            for udid in udids:
                _, error, text = mcp.call_tool("inspect_screen", {"device_id": udid})
                if error:
                    after_errors.append({"round": round_index, "udid": udid, "text": text[-300:]})
        report["after_kill_errors"] = after_errors
        check(f"{2 * args.after_rounds} more alternating calls after the recovery", not after_errors,
              f"{len(after_errors)} errors" if after_errors else None)
    finally:
        if jdb:
            jdb.close()
        code, close_s = mcp.close(timeout=60)
        report["mcp_exit_code"] = code
        report["mcp_close_s"] = round(close_s, 3)

    deadline = time.time() + 30
    remaining = runner_listeners(udids)
    while time.time() < deadline and (any(remaining[u] for u in udids) or xcodebuild_runs(udids)):
        time.sleep(0.5)
        remaining = runner_listeners(udids)
    report["runners_after_exit"] = {u: {str(p): ports for p, ports in r.items()} for u, r in remaining.items()}
    report["xcodebuild_after_exit"] = xcodebuild_runs(udids)
    check("MCP server exited cleanly", code == 0, f"exit {code} after {close_s:.2f} s")
    check("no runner listener or xcodebuild left for either simulator",
          not any(remaining[u] for u in udids) and not report["xcodebuild_after_exit"],
          {"runners": report["runners_after_exit"], "xcodebuild": report["xcodebuild_after_exit"]})

    with open(os.path.join(args.work_dir, "live-check.json"), "w") as f:
        json.dump(report, f, indent=2)
    failed = [name for name, c in checks.items() if not c["ok"]]
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
