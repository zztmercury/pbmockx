#!/usr/bin/env python3
"""E2E test: breakpoint + mock + resume + abort.

Starts test_server + mitmweb+addon, sends requests through proxy,
verifies breakpoint pause/mock/resume/abort flow.

Usage: .venv/bin/python test_breakpoint_e2e.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY = "http://127.0.0.1:8080"
CONTROL = "http://127.0.0.1:9090"
VENV_PY = os.path.join(PROJECT_DIR, ".venv", "bin", "python")
VENV_MITMWEB = os.path.join(PROJECT_DIR, ".venv", "bin", "mitmdump")
TEST_SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_server.py")
ADDON = os.path.join(PROJECT_DIR, "addon", "pbmockx_addon.py")
TEST_SERVER_PORT = 8889

procs = []

def cleanup():
    for p in procs:
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()

def ctrl(method, path, body=None):
    url = CONTROL + path
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(url, data=data, method=method)
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else None
    except Exception as e:
        return {"error": str(e)}

def proxy_get(path):
    """Send GET through mitmproxy to test_server."""
    url = f"http://127.0.0.1:{TEST_SERVER_PORT}{path}"
    proxy_handler = urllib.request.ProxyHandler({"http": PROXY})
    opener = urllib.request.build_opener(proxy_handler)
    try:
        with opener.open(url, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()

def wait_for(url, label, timeout=15):
    for _ in range(timeout * 2):
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except Exception:
            time.sleep(0.5)
    print(f"  [FAIL] {label} not ready within {timeout}s")
    return False

def main():
    # 1. Start test server
    print("[1] Starting test server...")
    p = subprocess.Popen(
        [VENV_PY, TEST_SERVER],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    procs.append(p)
    if not wait_for(f"http://127.0.0.1:{TEST_SERVER_PORT}/api/data", "test_server"):
        cleanup()
        return 1

    # 2. Start mitmweb + addon
    print("[2] Starting mitmweb + pbmockx_addon...")
    p = subprocess.Popen(
        [VENV_MITMWEB, "-s", ADDON,
         "--mode", f"regular@127.0.0.1:8080",
         "--set", "pbmockx_control_port=9090",
         "--set", "pbmockx_control_host=127.0.0.1",
         "-q"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    procs.append(p)
    if not wait_for(f"{CONTROL}/health", "control API"):
        cleanup()
        return 1

    health = ctrl("GET", "/health")
    print(f"  health: {health}")

    passed = 0
    failed = 0

    # 3. Test: normal request (no breakpoint)
    print("\n[3] Test: normal request through proxy...")
    status, body = proxy_get("/api/data")
    if status == 200:
        data = json.loads(body)
        if data.get("game", {}).get("name") == "TapTap":
            print("  [PASS] normal request works")
            passed += 1
        else:
            print(f"  [FAIL] unexpected response: {data}")
            failed += 1
    else:
        print(f"  [FAIL] status={status}")
        failed += 1

    # Clear flows
    ctrl("DELETE", "/flows")
    time.sleep(0.5)

    # 4. Test: breakpoint pause
    print("\n[4] Test: breakpoint pause...")
    # Add breakpoint rule
    r = ctrl("POST", "/rules", {"url_pattern": "api/data", "type": "breakpoint", "phase": "response"})
    print(f"  breakpoint rule: {r}")

    # Send request (should be paused by breakpoint)
    import threading
    result = {}
    def send_req():
        result["status"], result["body"] = proxy_get("/api/data")
    t = threading.Thread(target=send_req)
    t.start()
    time.sleep(1)  # wait for request to hit breakpoint

    # Check if flow is paused
    flows = ctrl("GET", "/flows?paused=1")
    if isinstance(flows, list) and len(flows) > 0:
        fid = flows[0]["id"]
        paused = flows[0].get("paused", False)
        print(f"  [PASS] flow paused: id={fid[:8]}, paused={paused}")
        passed += 1
    else:
        print(f"  [FAIL] no paused flow found. flows={flows}")
        # Check all flows
        all_flows = ctrl("GET", "/flows")
        print(f"  all flows: {all_flows}")
        failed += 1
        t.join(timeout=5)
        cleanup()
        return 1

    # 5. Test: decode paused flow
    print("\n[5] Test: decode paused flow...")
    dec = ctrl("GET", f"/flows/{fid}")
    if dec and dec.get("data"):
        game_name = dec["data"].get("game", {}).get("name")
        print(f"  [PASS] decoded data: game.name={game_name}")
        passed += 1
    else:
        print(f"  [FAIL] decode failed: {dec}")
        failed += 1

    # 6. Test: mock field on paused flow
    print("\n[6] Test: mock field on paused flow...")
    r = ctrl("POST", f"/flows/{fid}/mock", {"path": "game.name", "value": "MockedGame"})
    if isinstance(r, dict) and r.get("ok"):
        print("  [PASS] mock applied")
        passed += 1
    else:
        print(f"  [FAIL] mock failed: {r}")
        failed += 1

    # 7. Test: resume flow
    print("\n[7] Test: resume flow...")
    r = ctrl("POST", f"/flows/{fid}/resume", {})
    if isinstance(r, dict) and r.get("ok"):
        print("  [PASS] resumed")
        passed += 1
    else:
        print(f"  [FAIL] resume failed: {r}")
        failed += 1

    # Wait for client to receive response
    t.join(timeout=5)
    if result.get("status") == 200:
        try:
            resp_data = json.loads(result["body"])
            if resp_data.get("game", {}).get("name") == "MockedGame":
                print("  [PASS] client received mocked response")
                passed += 1
            else:
                print(f"  [FAIL] unexpected response: {resp_data}")
                failed += 1
        except Exception:
            print(f"  [FAIL] can't parse response: {result.get('body')}")
            failed += 1
    else:
        print(f"  [FAIL] client status={result.get('status')}")
        failed += 1

    # 8. Test: breakpoint + abort
    print("\n[8] Test: breakpoint + abort...")
    ctrl("DELETE", "/flows")
    time.sleep(0.5)

    result2 = {}
    def send_req2():
        result2["status"], result2["body"] = proxy_get("/api/data")
    t2 = threading.Thread(target=send_req2)
    t2.start()
    time.sleep(1)

    flows = ctrl("GET", "/flows?paused=1")
    if isinstance(flows, list) and len(flows) > 0:
        fid2 = flows[0]["id"]
        r = ctrl("POST", f"/flows/{fid2}/abort", {})
        if isinstance(r, dict) and r.get("ok"):
            print("  [PASS] aborted")
            passed += 1
        else:
            print(f"  [FAIL] abort failed: {r}")
            failed += 1
        t2.join(timeout=5)
        # Client should get an error (status 0 or exception)
        if result2.get("status", 0) != 200:
            print(f"  [PASS] client got error (status={result2.get('status', 0)})")
            passed += 1
        else:
            print(f"  [FAIL] client got 200 after abort")
            failed += 1
    else:
        print(f"  [FAIL] no paused flow for abort test")
        failed += 1
        t2.join(timeout=5)

    # 9. Cleanup breakpoint rule
    print("\n[9] Cleanup breakpoint rule...")
    rules = ctrl("GET", "/rules?type=breakpoint")
    if isinstance(rules, list):
        for rule in rules:
            ctrl("DELETE", f"/rules/{rule.get('id')}")
        print(f"  Cleared {len(rules)} breakpoint rules")

    # Summary
    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed")
    print(f"{'='*50}")

    cleanup()
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
