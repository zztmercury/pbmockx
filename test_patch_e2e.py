#!/usr/bin/env python3
"""E2E test: PB patch rule — verify response.content (delivered PB bytes) is modified.
Also verifies --original shows pre-patch data.

Uses test_server's Person class to decode PB bytes (no flowmock_addon import).
"""
import json
import subprocess
import sys
import time
import urllib.request

PROXY = "http://127.0.0.1:8080"
CONTROL = "http://127.0.0.1:9090"
VENV_PY = ".venv/bin/python"
VENV_MITMDUMP = ".venv/bin/mitmdump"
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
    url = f"http://127.0.0.1:{TEST_SERVER_PORT}{path}"
    proxy_handler = urllib.request.ProxyHandler({"http": PROXY})
    opener = urllib.request.build_opener(proxy_handler)
    try:
        with opener.open(url, timeout=10) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")
    except Exception as e:
        return 0, str(e).encode(), ""

def wait_for(url, label, timeout=15):
    for _ in range(timeout * 2):
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except Exception:
            time.sleep(0.5)
    print(f"  [FAIL] {label} not ready")
    return False

def decode_pb_person(raw_bytes):
    """Decode PB Person bytes using test_server's descriptor pool."""
    sys.path.insert(0, ".")
    from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
    from google.protobuf.json_format import MessageToDict
    fd = descriptor_pb2.FileDescriptorProto()
    fd.name = "person.proto"
    fd.package = "demo"
    fd.syntax = "proto3"
    msg = fd.message_type.add()
    msg.name = "Person"
    for name, num, typ in [("name", 1, descriptor_pb2.FieldDescriptorProto.TYPE_STRING),
                           ("id", 2, descriptor_pb2.FieldDescriptorProto.TYPE_INT32)]:
        f = msg.field.add()
        f.name = name; f.number = num; f.type = typ
        f.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
    pool = descriptor_pool.DescriptorPool()
    pool.Add(fd)
    Person = message_factory.GetMessageClass(pool.FindMessageTypeByName("demo.Person"))
    p = Person()
    p.ParseFromString(raw_bytes)
    return MessageToDict(p, preserving_proto_field_name=True,
                         always_print_fields_with_no_presence=True)

def main():
    passed = 0
    failed = 0

    # 1. Start test server
    print("[1] Starting test server...")
    p = subprocess.Popen([VENV_PY, "test_server.py"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    procs.append(p)
    if not wait_for(f"http://127.0.0.1:{TEST_SERVER_PORT}/api/data", "test_server"):
        cleanup(); return 1

    # 2. Start mitmdump + addon
    print("[2] Starting mitmdump + addon...")
    p = subprocess.Popen(
        [VENV_MITMDUMP, "-s", "flowmock_addon.py",
         "--mode", "regular@127.0.0.1:8080",
         "--set", "flowmock_control_port=9090",
         "--set", "flowmock_control_host=127.0.0.1",
         "-q"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    procs.append(p)
    if not wait_for(f"{CONTROL}/health", "control API"):
        cleanup(); return 1

    # 3. Capture original PB request
    print("\n[3] Original PB request (no rules)...")
    ctrl("DELETE", "/flows")
    time.sleep(0.3)
    status, body, ct = proxy_get("/api/person")
    if status != 200:
        print(f"  [FAIL] status={status}"); failed += 1; cleanup(); return 1
    orig = decode_pb_person(body)
    print(f"  original: {orig}")
    if orig.get("name") == "Alice":
        print("  [PASS] original name=Alice"); passed += 1
    else:
        print(f"  [FAIL] expected Alice"); failed += 1

    # 4. Add patch rule
    print("\n[4] Add patch rule: name → MockedName...")
    r = ctrl("POST", "/rules", {
        "url_pattern": "api/person", "type": "patch",
        "path": "name", "value": "MockedName", "protocol": "protobuf",
    })
    if isinstance(r, dict) and r.get("ok"):
        print("  [PASS] rule added"); passed += 1
    else:
        print(f"  [FAIL] {r}"); failed += 1; cleanup(); return 1

    # 5. Re-trigger and verify DELIVERED PB bytes
    print("\n[5] Re-trigger — verify DELIVERED PB bytes are modified...")
    ctrl("DELETE", "/flows")
    time.sleep(0.3)
    status2, body2, ct2 = proxy_get("/api/person")
    if status2 != 200:
        print(f"  [FAIL] status={status2}"); failed += 1; cleanup(); return 1
    delivered = decode_pb_person(body2)
    print(f"  delivered PB (decoded): {delivered}")
    if delivered.get("name") == "MockedName":
        print("  [PASS] ✅ delivered PB bytes modified (name=MockedName)"); passed += 1
    else:
        print(f"  [FAIL] ❌ delivered PB NOT modified (name={delivered.get('name')})")
        print(f"         Bug confirmed: patch changed decoded view but not response.content")
        failed += 1

    # 6. Verify flow_store: decoded (patched) vs original (pre-patch)
    print("\n[6] Verify flow_store decoded vs --original...")
    time.sleep(0.3)
    flows = ctrl("GET", "/flows?filter=api/person")
    if isinstance(flows, list) and len(flows) > 0:
        fid = flows[0]["id"]
        dec = ctrl("GET", f"/flows/{fid}")
        dec_orig = ctrl("GET", f"/flows/{fid}?original=1")
        dec_name = dec.get("data", {}).get("name") if dec else None
        orig_name = dec_orig.get("data", {}).get("name") if dec_orig else None
        print(f"  decoded  (patched):  name={dec_name}")
        print(f"  original (pre-patch): name={orig_name}")
        if dec_name == "MockedName":
            print("  [PASS] decoded shows patched value"); passed += 1
        else:
            print(f"  [FAIL] decoded wrong"); failed += 1
        if orig_name == "Alice":
            print("  [PASS] --original shows true pre-patch value"); passed += 1
        else:
            print(f"  [FAIL] --original not showing original (got {orig_name})"); failed += 1
    else:
        print(f"  [FAIL] no flow"); failed += 1

    # 7. Cleanup
    print("\n[7] Cleanup...")
    rules = ctrl("GET", "/rules?type=patch")
    if isinstance(rules, list):
        for rule in rules:
            ctrl("DELETE", f"/rules/{rule.get('id')}")

    print(f"\n{'='*60}")
    print(f"Results: {passed} passed, {failed} failed")
    print(f"{'='*60}")
    cleanup()
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
