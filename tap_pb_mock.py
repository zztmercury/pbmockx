"""tap_pb_mock - mitmproxy addon

复刻 Charles Protocol Buffers 自描述规则（Content-Type 携带 desc/messageType/delimited）
+ JSON，自动识别协议并统一 dict 化，通过 control HTTP API 供 AI agent 操作
（查看解码、改字段、规则 mock、拦截/resume）。

协议识别后 PB 与 JSON 都抽象成 dict，AI agent 只操作 path+value，不碰 protobuf wire format。
"""
import importlib
import json
import os
import re
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

import requests
from google.protobuf import descriptor_pool, message_factory, json_format, descriptor_pb2
from mitmproxy import ctx, contentviews
from mitmproxy.contentviews import Contentview

# ---------------- protocol detection (Charles rules) ----------------

PB_CT_RE = re.compile(r"application/x-(google-)?protobuf", re.I)

# Google well-known types whose .proto files are NOT in TapTap's .desc but are
# referenced as dependencies (e.g. apis.Response depends on google/protobuf/any.proto).
_WELL_KNOWN = [
    "any_pb2", "descriptor_pb2", "timestamp_pb2", "duration_pb2",
    "wrappers_pb2", "empty_pb2", "struct_pb2", "field_mask_pb2",
    "api_pb2", "source_context_pb2", "type_pb2",
]
DESC_RE = re.compile(r'desc\s*=\s*"([^"]+)"', re.I)
DESC_RE_BARE = re.compile(r"desc\s*=\s*([^\s;]+)", re.I)
MSGTYPE_RE = re.compile(r'messageType\s*=\s*"([^"]+)"', re.I)
MSGTYPE_RE_BARE = re.compile(r"messageType\s*=\s*([^\s;]+)", re.I)
DELIM_RE = re.compile(r"delimited\s*=\s*true", re.I)


def parse_ct_params(ct):
    """解析 Content-Type 的 desc/messageType/delimited 参数（Charles 规则）。"""
    if not ct:
        return {}
    desc = None
    if (m := DESC_RE.search(ct)) or (m := DESC_RE_BARE.search(ct)):
        desc = m.group(1)
    mtype = None
    if (m := MSGTYPE_RE.search(ct)) or (m := MSGTYPE_RE_BARE.search(ct)):
        mtype = m.group(1)
    return {
        "desc": desc,
        "messageType": mtype,
        "delimited": bool(DELIM_RE.search(ct)),
    }


def is_pb(ct):
    return bool(ct and PB_CT_RE.search(ct))


def is_json(ct, data):
    if ct and "json" in ct.lower():
        return True
    if not data:
        return False
    try:
        json.loads(data.decode("utf-8") if isinstance(data, bytes) else data)
        return True
    except Exception:
        return False


# ---------------- .desc download cache (HTTP 1.1 semantics) ----------------

class DescCache:
    """按 desc URL 下载 FileDescriptorSet，带 ETag/Last-Modified 条件请求缓存。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._cache = {}  # url -> {etag, last_modified, bytes, ts}

    def get(self, url):
        with self._lock:
            entry = self._cache.get(url)
        headers = {}
        if entry:
            if entry.get("etag"):
                headers["If-None-Match"] = entry["etag"]
            if entry.get("last_modified"):
                headers["If-Modified-Since"] = entry["last_modified"]
        try:
            r = requests.get(url, headers=headers, timeout=10)
        except Exception:
            if entry:
                return entry["bytes"]
            raise
        if r.status_code == 304 and entry:
            entry["ts"] = time.time()
            return entry["bytes"]
        if r.status_code != 200:
            if entry:
                return entry["bytes"]
            raise RuntimeError(f"desc {url} HTTP {r.status_code}")
        data = r.content
        with self._lock:
            self._cache[url] = {
                "etag": r.headers.get("ETag"),
                "last_modified": r.headers.get("Last-Modified"),
                "bytes": data,
                "ts": time.time(),
            }
        return data


# ---------------- varint (length-delimited framing) ----------------

def read_varint(data, pos):
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")
    return result, pos


def encode_varint(value):
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


# ---------------- protobuf engine ----------------

class PBEngine:
    def __init__(self):
        self.cache = DescCache()
        self._lock = threading.Lock()
        self._pools = {}  # desc_url -> DescriptorPool

    def _get_pool(self, desc_url):
        with self._lock:
            if desc_url in self._pools:
                return self._pools[desc_url]
        data = self.cache.get(desc_url)
        fds = descriptor_pb2.FileDescriptorSet()
        fds.ParseFromString(data)
        pool = descriptor_pool.DescriptorPool()
        # collect files: google well-known types (deps absent from the .desc) + the .desc's own files
        files = []
        for name in _WELL_KNOWN:
            try:
                mod = importlib.import_module("google.protobuf." + name)
            except ImportError:
                continue
            fd = getattr(mod, "DESCRIPTOR", None)
            if fd is None:
                continue
            try:
                fp = descriptor_pb2.FileDescriptorProto()
                fp.ParseFromString(fd.serialized_pb)
                files.append(fp)
            except Exception:
                pass
        files.extend(fds.file)
        # topological Add: retry until no progress (resolves inter-file deps)
        remaining = files
        progress = True
        while remaining and progress:
            progress = False
            still = []
            for fd in remaining:
                try:
                    pool.Add(fd)
                    progress = True
                except Exception:
                    still.append(fd)
            remaining = still
        with self._lock:
            self._pools[desc_url] = pool
        return pool

    def get_class(self, desc_url, message_type):
        pool = self._get_pool(desc_url)
        desc = pool.FindMessageTypeByName(message_type)
        return message_factory.GetMessageClass(desc)

    def decode(self, desc_url, message_type, delimited, data):
        pool = self._get_pool(desc_url)
        cls = message_factory.GetMessageClass(pool.FindMessageTypeByName(message_type))
        if delimited:
            out = []
            pos = 0
            while pos < len(data):
                length, pos = read_varint(data, pos)
                msg = cls()
                msg.ParseFromString(data[pos:pos + length])
                out.append(self._to_dict(msg, pool))
                pos += length
            return out
        msg = cls()
        msg.ParseFromString(data)
        return self._to_dict(msg, pool)

    def encode(self, desc_url, message_type, delimited, data):
        pool = self._get_pool(desc_url)
        cls = message_factory.GetMessageClass(pool.FindMessageTypeByName(message_type))
        if delimited:
            out = bytearray()
            for item in data:
                msg = cls()
                json_format.ParseDict(item, msg, ignore_unknown_fields=True, descriptor_pool=pool)
                s = msg.SerializeToString()
                out += encode_varint(len(s)) + s
            return bytes(out)
        msg = cls()
        json_format.ParseDict(data, msg, ignore_unknown_fields=True, descriptor_pool=pool)
        return msg.SerializeToString()

    @staticmethod
    def _to_dict(msg, pool=None):
        kwargs = {
            "preserving_proto_field_name": True,
            "always_print_fields_with_no_presence": True,
        }
        if pool is not None:
            kwargs["descriptor_pool"] = pool
        return json_format.MessageToDict(msg, **kwargs)


# ---------------- path navigation (a.b[0].c) ----------------

PATH_SEG_RE = re.compile(r"([^\[\].]+)|\[(\d+)\]")


def parse_path(path):
    parts = []
    for m in PATH_SEG_RE.finditer(path):
        if m.group(1):
            parts.append(m.group(1))
        elif m.group(2):
            parts.append(int(m.group(2)))
    return parts


def get_by_path(obj, parts):
    cur = obj
    for p in parts:
        cur = cur[p]
    return cur


def set_by_path(obj, parts, value):
    cur = obj
    for p in parts[:-1]:
        cur = cur[p]
    cur[parts[-1]] = value


# ---------------- codec (protocol-aware decode/encode) ----------------

class Codec:
    def __init__(self, pb):
        self.pb = pb

    def detect(self, flow):
        ct = flow.response.headers.get("content-type", "") if flow.response else ""
        data = flow.response.content if flow.response else None
        if is_pb(ct):
            return {"protocol": "protobuf", **parse_ct_params(ct)}
        if is_json(ct, data or b""):
            return {"protocol": "json"}
        return None

    def decode(self, info, data):
        if info["protocol"] == "protobuf":
            return self.pb.decode(info["desc"], info["messageType"], info["delimited"], data)
        return json.loads(data.decode("utf-8") if isinstance(data, bytes) else data)

    def encode(self, info, data):
        if info["protocol"] == "protobuf":
            return self.pb.encode(info["desc"], info["messageType"], info["delimited"], data)
        return json.dumps(data, ensure_ascii=False).encode("utf-8")


# ---------------- mock engine ----------------

class MockRule:
    def __init__(self, url_pattern, path, value, protocol=None):
        self.url_pattern = url_pattern
        self.regex = re.compile(url_pattern)
        self.path = path
        self.value = value
        self.protocol = protocol

    def to_dict(self):
        return {
            "url_pattern": self.url_pattern,
            "path": self.path,
            "value": self.value,
            "protocol": self.protocol,
        }


class MockEngine:
    def __init__(self):
        self.rules = []
        self.lock = threading.Lock()

    def add(self, rule):
        with self.lock:
            self.rules.append(rule)

    def list(self):
        with self.lock:
            return [r.to_dict() for r in self.rules]

    def delete(self, idx):
        with self.lock:
            if 0 <= idx < len(self.rules):
                del self.rules[idx]
                return True
            return False

    def matched(self, url, protocol):
        with self.lock:
            rules = list(self.rules)
        out = []
        for r in rules:
            if r.protocol and r.protocol != protocol:
                continue
            if r.regex.search(url):
                out.append(r)
        return out


# ---------------- flow store ----------------

flow_store = {}  # id -> {flow, info, decoded, error, ts}
store_lock = threading.Lock()

ADDON = None  # set in load()


def find_flow(fid):
    """Lookup flow by exact or prefix id. Returns (full_id, rec) or (None, None)."""
    with store_lock:
        if fid in flow_store:
            return fid, flow_store[fid]
        for k, rec in flow_store.items():
            if k.startswith(fid):
                return k, rec
    return None, None


# ---------------- contentview (mitmweb human preview) ----------------

class PBJsonView(Contentview):
    name = "tap-pb-json"
    syntax_highlight = "yaml"

    def render_priority(self, data, metadata):
        ct = (metadata.content_type or "").lower()
        if "protobuf" in ct or "json" in ct:
            return 1.0
        return -1.0

    def prettify(self, data, metadata):
        flow = metadata.flow
        if flow is not None:
            with store_lock:
                rec = flow_store.get(flow.id)
            if rec and rec.get("decoded") is not None:
                return json.dumps(rec["decoded"], ensure_ascii=False, indent=2)
        try:
            return json.dumps(json.loads(data.decode("utf-8")), ensure_ascii=False, indent=2)
        except Exception:
            return f"[tap-pb-json] {len(data)} bytes (no decoded data; check Content-Type desc/messageType)"


# ---------------- control HTTP API ----------------

class ControlHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length", 0))
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def _flows_summary(self):
        items = []
        with store_lock:
            for fid, rec in flow_store.items():
                f = rec["flow"]
                items.append({
                    "id": fid,
                    "url": f.request.url,
                    "method": f.request.method,
                    "status": f.response.status_code if f.response else None,
                    "protocol": rec["info"].get("protocol"),
                    "messageType": rec["info"].get("messageType"),
                    "delimited": rec["info"].get("delimited"),
                    "error": rec.get("error"),
                })
        return items

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._send(200, {"ok": True})
        if path == "/flows":
            return self._send(200, self._flows_summary())
        if path == "/rules":
            return self._send(200, ADDON.mock.list())
        m = re.match(r"^/flows/([^/]+)$", path)
        if m:
            _, rec = find_flow(m.group(1))
            if not rec:
                return self._send(404, {"error": "not found"})
            f = rec["flow"]
            return self._send(200, {
                "id": m.group(1),
                "url": f.request.url,
                "protocol": rec["info"].get("protocol"),
                "desc": rec["info"].get("desc"),
                "messageType": rec["info"].get("messageType"),
                "delimited": rec["info"].get("delimited"),
                "content_type": f.response.headers.get("content-type", "") if f.response else "",
                "data": rec["decoded"],
                "error": rec.get("error"),
            })
        return self._send(404, {"error": "unknown route"})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read()
        m = re.match(r"^/flows/([^/]+)/mock$", path)
        if m and ADDON:
            fid = m.group(1)
            p = body.get("path")
            v = body.get("value")
            if p is None:
                return self._send(400, {"error": "path required"})
            _, rec = find_flow(fid)
            if not rec:
                return self._send(404, {"error": "not found"})
            info = rec["info"]
            flow = rec["flow"]
            try:
                data = ADDON.codec.decode(info, flow.response.content or b"")
                set_by_path(data, parse_path(p), v)
                flow.response.content = ADDON.codec.encode(info, data)
                with store_lock:
                    rec["decoded"] = data
            except Exception as e:
                return self._send(500, {"error": str(e)})
            return self._send(200, {
                "ok": True, "path": p, "value": v,
                "note": "response updated; use intercept+resume or replay to deliver to client",
            })
        m = re.match(r"^/flows/([^/]+)/resume$", path)
        if m and ADDON:
            _, rec = find_flow(m.group(1))
            if not rec:
                return self._send(404, {"error": "not found"})
            try:
                rec["flow"].resume()
                return self._send(200, {"ok": True, "resumed": m.group(1)})
            except Exception as e:
                return self._send(500, {"error": str(e)})
        m = re.match(r"^/flows/([^/]+)/replay$", path)
        if m and ADDON:
            _, rec = find_flow(m.group(1))
            if not rec:
                return self._send(404, {"error": "not found"})
            try:
                if hasattr(ctx.master, "replay_request"):
                    ctx.master.replay_request(rec["flow"])
                    return self._send(200, {"ok": True, "replayed": m.group(1)})
                return self._send(501, {"error": "replay unavailable; use mitmweb R key"})
            except Exception as e:
                return self._send(500, {"error": str(e)})
        if path == "/rules" and ADDON:
            url_pat = body.get("url_pattern")
            p = body.get("path")
            v = body.get("value")
            proto = body.get("protocol")
            if not url_pat or p is None:
                return self._send(400, {"error": "url_pattern and path required"})
            rule = MockRule(url_pat, p, v, proto)
            ADDON.mock.add(rule)
            return self._send(200, {"ok": True, "rule": rule.to_dict()})
        if path == "/intercept" and ADDON:
            enable = body.get("enable", False)
            flt = body.get("filter", "~u .")  # default: intercept all
            ctx.options.intercept = flt if enable else ""
            return self._send(200, {"ok": True, "intercept": flt if enable else ""})
        return self._send(404, {"error": "unknown route"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        m = re.match(r"^/rules/(\d+)$", path)
        if m and ADDON:
            ok = ADDON.mock.delete(int(m.group(1)))
            return self._send(200 if ok else 404, {"ok": ok})
        return self._send(404, {"error": "unknown route"})


# ---------------- addon ----------------

class TapPbMock:
    def __init__(self):
        self.pb = PBEngine()
        self.codec = Codec(self.pb)
        self.mock = MockEngine()
        self.server = None

    def load(self, loader):
        global ADDON
        ADDON = self
        try:
            ctx.options.add_option("tap_pb_control_port", int, 9090, "control API port")
            ctx.options.add_option("tap_pb_control_host", str, "127.0.0.1", "control API host")
        except Exception:
            pass
        contentviews.add(PBJsonView())
        host = ctx.options.tap_pb_control_host
        port = ctx.options.tap_pb_control_port
        # preload persistent rules from rules.yaml (same dir as this script)
        rules_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rules.yaml")
        if os.path.exists(rules_file):
            try:
                from ruamel.yaml import YAML
                with open(rules_file) as f:
                    items = YAML(typ="safe").load(f) or []
                for r in items:
                    self.mock.add(MockRule(
                        r["url_pattern"], r["path"], r.get("value"), r.get("protocol")
                    ))
                ctx.log.info(f"loaded {len(items)} rules from rules.yaml")
            except Exception as e:
                ctx.log.warn(f"load rules.yaml failed: {e}")
        self.server = ThreadingHTTPServer((host, port), ControlHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        ctx.log.info(f"tap_pb_mock control API: http://{host}:{port}")

    def response(self, flow):
        info = self.codec.detect(flow)
        if not info:
            return
        try:
            data = self.codec.decode(info, flow.response.content or b"")
        except Exception as e:
            with store_lock:
                flow_store[flow.id] = {
                    "flow": flow, "info": info, "decoded": None,
                    "error": str(e), "ts": time.time(),
                }
            ctx.log.warn(f"decode failed {flow.request.url}: {e}")
            return
        # continuous rules: apply to decoded data, then re-encode
        matched = self.mock.matched(flow.request.url, info["protocol"])
        if matched:
            changed = False
            for r in matched:
                try:
                    set_by_path(data, parse_path(r.path), r.value)
                    changed = True
                except Exception as e:
                    ctx.log.warn(f"mock rule {r.path} failed: {e}")
            if changed:
                try:
                    flow.response.content = self.codec.encode(info, data)
                except Exception as e:
                    ctx.log.warn(f"re-encode failed {flow.request.url}: {e}")
        with store_lock:
            flow_store[flow.id] = {
                "flow": flow, "info": info, "decoded": data, "ts": time.time(),
            }

    def done(self):
        if self.server:
            self.server.shutdown()


addons = [TapPbMock()]
