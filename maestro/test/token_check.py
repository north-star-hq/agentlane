"""Checks that the iOS runner of a Maestro build serves only its token holder.

Starts `maestro mcp --no-viewer` with MAESTRO_RUNNER_TOKEN set to a fresh token,
warms one booted simulator, and then:

- calls the runner's port directly without the token header and with a wrong
  token, including a tap on the home screen's Files icon, and expects 401 every
  time and no change on the device;
- calls it with the token and expects it served, and the same tap to open Files;
- runs the MCP tools inspect_screen, take_screenshot and run (a tap);
- runs a flow that needs both a MAESTRO_* variable from the server's environment
  and one from the call's env, and expects the result to echo only the call's;
- points a second Maestro process, started without the token, at the runner's
  port, and expects it to fail without driving the simulator or touching the
  runner, after which the MCP session keeps working on the same runner;
- checks that the token appears in no log Maestro wrote.

Usage: maestro/README.md, "Live checks".
"""

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_check import Mcp, booted, runner_listeners, xcodebuild_runs  # noqa: E402

HEADER = "X-Maestro-Runner-Token"
FILES_APP = "com.apple.DocumentsApp"
TAP_FILES_FLOW = 'appId: com.apple.springboard\n---\n- tapOn: "Files"\n- pressKey: Home\n'


def runner_call(port, path, body=None, token=None):
    """(status, body text) of one request to the runner on 127.0.0.1:port."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}/{path}", data=data,
                                     method="GET" if data is None else "POST")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if token is not None:
        request.add_header(HEADER, token)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, response.read().decode(errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors="replace")


def find_label(element, label):
    if element.get("label") == label and element.get("frame"):
        return element
    for child in element.get("children") or []:
        found = find_label(child, label)
        if found:
            return found
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--maestro", required=True, help="path to the built bin/maestro")
    parser.add_argument("--sim", required=True, help="UDID of a booted simulator no other Maestro is using")
    parser.add_argument("--work-dir", required=True, help="directory for logs and the JSON report")
    args = parser.parse_args()
    udid = args.sim

    if not os.environ.get("JAVA_HOME"):
        sys.exit("set JAVA_HOME to a JDK 17 home")
    if not booted(udid):
        sys.exit(f"simulator {udid} is not booted; boot it with 'xcrun simctl boot {udid}'")
    if runner_listeners([udid])[udid] or xcodebuild_runs([udid]):
        sys.exit(f"a runner or xcodebuild already serves {udid}; stop it first")
    os.makedirs(args.work_dir, exist_ok=True)

    report = {"maestro": args.maestro, "sim": udid, "checks": {}}
    checks = report["checks"]

    def check(name, ok, detail=None):
        checks[name] = {"ok": bool(ok), "detail": detail}
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail is not None else ""), flush=True)

    token = "check-" + secrets.token_hex(16)
    wrong = "check-" + secrets.token_hex(16)
    shell_only = "shell-" + secrets.token_hex(8)
    started_at = time.time()
    env = dict(os.environ, MAESTRO_RUNNER_TOKEN=token, MAESTRO_CHECK_SHELL_ONLY=shell_only)
    mcp = Mcp([args.maestro, "mcp", "--no-viewer"], env, os.path.join(args.work_dir, "mcp.stderr"))
    tool_outputs = []
    call_tool = mcp.call_tool

    def recording_call_tool(name, arguments):
        result = call_tool(name, arguments)
        tool_outputs.append(result[2])
        return result

    mcp.call_tool = recording_call_tool
    try:
        mcp.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "token-check", "version": "0"},
        })
        mcp.notify("notifications/initialized", {})
        elapsed, error, text = mcp.call_tool("inspect_screen", {"device_id": udid})
        check("first inspect_screen starts the runner", not error, f"{elapsed:.2f} s" if not error else text[-300:])

        runners = runner_listeners([udid])[udid]
        if len(runners) != 1:
            sys.exit(f"expected one runner listening for {udid}, found {runners}")
        (runner_pid, ports), = runners.items()
        port = ports[0]
        xcodebuild_before = xcodebuild_runs([udid])
        report["runner"] = {"pid": runner_pid, "port": port, "xcodebuild": [x.split()[0] for x in xcodebuild_before]}
        print(f"    runner pid {runner_pid} on 127.0.0.1:{port}", flush=True)

        def foreground():
            status, body = runner_call(port, "runningApp", {"appIds": [FILES_APP]}, token)
            return json.loads(body)["runningAppBundleId"] if status == 200 else f"HTTP {status}"

        status, body = runner_call(port, "status", token=token)
        check("the token from MAESTRO_RUNNER_TOKEN is served: GET /status", status == 200, f"{status} {body.strip()[:80]}")
        status, body = runner_call(port, "deviceInfo", {}, token)
        check("the token is served: POST /deviceInfo", status == 200 and "widthPoints" in body, f"{status} {body[:120]}")
        status, body = runner_call(port, "viewHierarchy", {"appIds": [], "excludeKeyboardElements": False}, token)
        check("the token is served: POST /viewHierarchy", status == 200, f"{status}, {len(body)} bytes")
        icon = find_label(json.loads(body)["axElement"], "Files") if status == 200 else None
        if not icon:
            sys.exit("the runner's view hierarchy has no element labelled Files; go to the home screen's first page")
        frame = icon["frame"]
        tap = {"x": frame["X"] + frame["Width"] / 2, "y": frame["Y"] + frame["Height"] / 2, "duration": None}
        report["files_tap"] = tap
        check("SpringBoard is in front before the refused calls", foreground() == "com.apple.springboard", foreground())

        refused = {}
        for label, presented in (("no header", None), ("a wrong token", wrong)):
            for path, body in (("status", None), ("deviceInfo", {}), ("touch", tap), ("noSuchRoute", None)):
                status, text = runner_call(port, path, body, presented)
                refused[f"{label} /{path}"] = (status, text.strip())
                check(f"{label}: /{path} gets 401", status == 401, f"{status} {text.strip()[:120]}")
        report["refused"] = refused
        time.sleep(2.0)
        check("the refused taps changed nothing: SpringBoard is still in front", foreground() == "com.apple.springboard",
              foreground())
        status, _ = runner_call(port, "noSuchRoute", None, token)
        check("with the token an unknown path is 404, so 401 hides which routes exist", status == 404, status)

        status, text = runner_call(port, "touch", tap, token)
        deadline = time.time() + 10
        while time.time() < deadline and foreground() != FILES_APP:
            time.sleep(0.5)
        check("with the token the same tap opens Files", status == 200 and foreground() == FILES_APP,
              f"{status}, front: {foreground()}")
        elapsed, error, text = mcp.call_tool("run", {"device_id": udid, "yaml": "appId: com.apple.springboard\n---\n- pressKey: Home\n"})
        check("MCP run pressKey Home", not error and foreground() == "com.apple.springboard", text[-200:])

        elapsed, error, text = mcp.call_tool("inspect_screen", {"device_id": udid})
        check("MCP inspect_screen", not error and "Files" in text, f"{elapsed:.2f} s")
        reply = mcp.request("tools/call", {"name": "take_screenshot", "arguments": {"device_id": udid}})
        images = [c for c in reply.get("result", {}).get("content", []) if c.get("type") == "image"]
        check("MCP take_screenshot", images and not reply["result"].get("isError"),
              f"{len(images[0]['data']) if images else 0} base64 chars")
        elapsed, error, text = mcp.call_tool("run", {"device_id": udid, "yaml": TAP_FILES_FLOW})
        check("MCP run tapOn Files, then Home", not error, f"{elapsed:.2f} s; {text[-160:]}")
        env_flow = ('appId: com.apple.springboard\n---\n'
                    f'- assertTrue: ${{MAESTRO_CHECK_SHELL_ONLY == "{shell_only}" && CHECK_CALLER == "from-the-call"}}\n')
        elapsed, error, text = mcp.call_tool("run", {"device_id": udid, "yaml": env_flow,
                                                     "env": {"CHECK_CALLER": "from-the-call"}})
        try:
            echoed = json.loads(text).get("env_vars")
        except ValueError:
            echoed = None
        check("MCP run hands the flow the server's MAESTRO_* variables and echoes only the call's env",
              not error and echoed == {"CHECK_CALLER": "from-the-call"} and shell_only not in text, text[-200:])

        flow = os.path.join(args.work_dir, "tap-files.yaml")
        with open(flow, "w") as f:
            f.write('appId: com.apple.springboard\n---\n- tapOn: "Files"\n')
        other_env = {k: v for k, v in os.environ.items() if k != "MAESTRO_RUNNER_TOKEN"}
        other_log = os.path.join(args.work_dir, "second-maestro.log")
        with open(other_log, "w") as log:
            other = subprocess.run([args.maestro, "--device", udid, "--driver-host-port", str(port), "test", flow],
                                   stdout=log, stderr=subprocess.STDOUT, env=other_env, timeout=300)
        with open(other_log) as log:
            other_output = log.read()
        report["second_maestro"] = {"exit": other.returncode, "tail": other_output[-1500:]}
        check("a second Maestro without the token, pointed at the runner's port, fails",
              other.returncode != 0 and "refuses this process's token" in other_output,
              f"exit {other.returncode}")
        check("it didn't drive the simulator: SpringBoard is still in front", foreground() == "com.apple.springboard",
              foreground())
        after = runner_listeners([udid])[udid]
        check("the first session's runner wasn't stopped or replaced", after == runners, after)
        check("no xcodebuild was started or stopped", xcodebuild_runs([udid]) == xcodebuild_before,
              [x.split()[0] for x in xcodebuild_runs([udid])])
        elapsed, error, text = mcp.call_tool("inspect_screen", {"device_id": udid})
        check("the MCP session keeps working on the same runner",
              not error and runner_listeners([udid])[udid] == runners, f"{elapsed:.2f} s")
    finally:
        code, close_s = mcp.close(timeout=60)
        report["mcp_exit"] = code

    leaks = []
    for root in (os.path.expanduser("~/.maestro/tests"), args.work_dir):
        for directory, _, files in os.walk(root):
            for name in files:
                path = os.path.join(directory, name)
                try:
                    if os.path.getmtime(path) < started_at - 1:
                        continue
                    with open(path, "rb") as f:
                        if token.encode() in f.read():
                            leaks.append(path)
                except OSError:
                    continue
    check("the token appears in no log written during the run", not leaks, leaks or None)
    check("the token appears in no MCP tool output", tool_outputs and not any(token in t for t in tool_outputs),
          f"{len(tool_outputs)} tool calls")
    check("the server's other MAESTRO_* variables appear in no MCP tool output",
          tool_outputs and not any(shell_only in t for t in tool_outputs), f"{len(tool_outputs)} tool calls")
    check("MCP server exited cleanly", code == 0, f"exit {code} after {close_s:.2f} s")
    deadline = time.time() + 30
    while time.time() < deadline and (runner_listeners([udid])[udid] or xcodebuild_runs([udid])):
        time.sleep(0.5)
    check("no runner or xcodebuild left after the server exits",
          not runner_listeners([udid])[udid] and not xcodebuild_runs([udid]))

    with open(os.path.join(args.work_dir, "token-check.json"), "w") as f:
        json.dump(report, f, indent=2)
    failed = [name for name, c in checks.items() if not c["ok"]]
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
