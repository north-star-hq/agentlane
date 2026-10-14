"""Checks that inspect_screen on iOS says what kind of element each node is.

Starts `maestro mcp --no-viewer`, opens Settings (com.apple.Preferences) on one
booted simulator, and expects inspect_screen to give its cells and buttons a `cls`
value (the XCUIElement.ElementType raw value; 9 is a button, 75 a cell) and the iOS
ui_schema to name `cls`. Usage: maestro/README.md, "Live checks".
"""

import argparse
import collections
import json
import os
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_check import Mcp, booted, runner_listeners, xcodebuild_runs  # noqa: E402

BUTTON, CELL = "9", "75"
OPEN_SETTINGS = "appId: com.apple.Preferences\n---\n- launchApp\n"
CLOSE_SETTINGS = "appId: com.apple.Preferences\n---\n- stopApp\n- pressKey: Home\n"


def walk(elements):
    for element in elements:
        yield element
        yield from walk(element.get("c") or [])


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

    mcp = Mcp([args.maestro, "mcp", "--no-viewer"], dict(os.environ), os.path.join(args.work_dir, "mcp.stderr"))
    try:
        mcp.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "element-type-check", "version": "0"},
        })
        mcp.notify("notifications/initialized", {})
        _, error, text = mcp.call_tool("run", {"device_id": udid, "yaml": OPEN_SETTINGS})
        check("MCP run launches Settings", not error, text[-160:])
        time.sleep(2.0)
        elapsed, error, text = mcp.call_tool("inspect_screen", {"device_id": udid})
        check("MCP inspect_screen on Settings", not error, f"{elapsed:.2f} s, {len(text)} chars")
        with open(os.path.join(args.work_dir, "inspect_screen.json"), "w") as f:
            f.write(text)
        screen = json.loads(text[text.index("{"):])
        nodes = list(walk(screen.get("elements", [])))
        classes = collections.Counter(node.get("cls") for node in nodes)
        report["nodes"] = len(nodes)
        report["cls_counts"] = {str(k): v for k, v in classes.most_common()}
        check("the iOS ui_schema names cls", screen.get("ui_schema", {}).get("abbreviations", {}).get("cls") == "class",
              screen.get("ui_schema", {}).get("abbreviations"))
        check("every node carries a cls", nodes and None not in classes, f"{len(nodes)} nodes, cls counts {report['cls_counts']}")
        labelled = [n for n in nodes if n.get("cls") in (BUTTON, CELL)]
        report["labelled_buttons_and_cells"] = [{"cls": n["cls"], "a11y": n.get("a11y"), "txt": n.get("txt")}
                                                for n in labelled][:20]
        check("Settings' cells and buttons are marked 75 and 9", classes[CELL] > 0 and classes[BUTTON] > 0,
              f"cells {classes[CELL]}, buttons {classes[BUTTON]}; e.g. {report['labelled_buttons_and_cells'][:4]}")
        _, error, text = mcp.call_tool("run", {"device_id": udid, "yaml": CLOSE_SETTINGS})
        check("MCP run closes Settings", not error, text[-160:])
    finally:
        code, close_s = mcp.close(timeout=60)
    check("MCP server exited cleanly", code == 0, f"exit {code} after {close_s:.2f} s")
    deadline = time.time() + 30
    while time.time() < deadline and (runner_listeners([udid])[udid] or xcodebuild_runs([udid])):
        time.sleep(0.5)
    check("no runner or xcodebuild left after the server exits",
          not runner_listeners([udid])[udid] and not xcodebuild_runs([udid]))

    with open(os.path.join(args.work_dir, "element-type-check.json"), "w") as f:
        json.dump(report, f, indent=2)
    failed = [name for name, c in checks.items() if not c["ok"]]
    print(f"{len(checks) - len(failed)}/{len(checks)} checks passed" + (f"; failed: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
