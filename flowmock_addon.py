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
import uuid
from collections import OrderedDict
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

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
    """Unified rule model. type determines which fields are used.

    patch:      url_pattern, path, value, protocol
    map_local:  url_pattern, source(file|data), file_path, data, desc, messageType, delimited, status, headers
    map_remote: url_pattern, replacement, is_regex
    breakpoint: url_pattern, phase
    """

    def __init__(self, url_pattern, type="patch", **kw):
        self.id = kw.get("id") or str(uuid.uuid4())[:8]
        self.type = type
        self.url_pattern = url_pattern
        self.regex = re.compile(url_pattern)
        # patch
        self.path = kw.get("path")
        self.value = kw.get("value")
        self.protocol = kw.get("protocol")
        # map_local
        self.source = kw.get("source", "file")
        self.file_path = kw.get("file_path")
        self.data = kw.get("data")
        self.desc = kw.get("desc")
        self.messageType = kw.get("messageType")
        self.delimited = kw.get("delimited", False)
        self.status = kw.get("status")
        self.headers = kw.get("headers")
        # map_remote
        self.replacement = kw.get("replacement")
        self.is_regex = kw.get("is_regex", False)
        # breakpoint
        self.phase = kw.get("phase", "response")

    def to_dict(self):
        d = {"id": self.id, "type": self.type, "url_pattern": self.url_pattern}
        for k in ["path", "value", "protocol", "source", "file_path", "data",
                  "desc", "messageType", "delimited", "status", "headers",
                  "replacement", "is_regex", "phase"]:
            v = getattr(self, k)
            if v is not None and v is not False:
                d[k] = v
        return d

    @classmethod
    def from_dict(cls, d):
        url = d.pop("url_pattern", "")
        rtype = d.pop("type", "patch")
        rid = d.pop("id", None)
        return cls(url, type=rtype, id=rid, **d)


class MockEngine:
    def __init__(self):
        self.rules = []
        self.lock = threading.Lock()

    def add(self, rule):
        with self.lock:
            for i, r in enumerate(self.rules):
                if r.url_pattern == rule.url_pattern and r.type == rule.type:
                    if r.type == "patch" and r.path == rule.path:
                        self.rules[i] = rule
                        return rule
                    elif r.type != "patch":
                        self.rules[i] = rule
                        return rule
            self.rules.append(rule)
            return rule

    def list(self, type_filter=None):
        with self.lock:
            rules = list(self.rules)
        if type_filter:
            rules = [r for r in rules if r.type == type_filter]
        return [r.to_dict() for r in rules]

    def delete(self, rule_id):
        with self.lock:
            for i, r in enumerate(self.rules):
                if r.id == rule_id:
                    del self.rules[i]
                    return True
            try:
                idx = int(rule_id)
                if 0 <= idx < len(self.rules):
                    del self.rules[idx]
                    return True
            except (ValueError, TypeError):
                pass
            return False

    def matched(self, url, protocol=None, type_filter=None):
        with self.lock:
            rules = list(self.rules)
        out = []
        for r in rules:
            if type_filter and r.type != type_filter:
                continue
            if r.protocol and r.protocol != protocol:
                continue
            if r.regex.search(url):
                out.append(r)
        return out

    def save(self):
        rules_file = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "rules.yaml"
        )
        try:
            from ruamel.yaml import YAML
            yaml = YAML(typ="safe")
            # Preserve header comments (lines starting with # or blank, before first data line)
            header = []
            if os.path.exists(rules_file):
                with open(rules_file) as f:
                    for line in f:
                        if line.strip().startswith('#') or not line.strip():
                            header.append(line)
                        else:
                            break
            data = [r.to_dict() for r in self.rules]
            tmp = rules_file + ".tmp"
            with open(tmp, "w") as f:
                if header:
                    f.writelines(header)
                yaml.dump(data, f)
            os.replace(tmp, rules_file)
            return True
        except Exception as e:
            ctx.log.warn(f"save rules.yaml failed: {e}")
            return False

    def reload(self):
        rules_file = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "rules.yaml"
        )
        if not os.path.exists(rules_file):
            return 0
        try:
            from ruamel.yaml import YAML
            with open(rules_file) as f:
                items = YAML(typ="safe").load(f) or []
            with self.lock:
                self.rules = []
                for item in items:
                    self.rules.append(MockRule.from_dict(item))
            return len(self.rules)
        except Exception as e:
            ctx.log.warn(f"reload rules.yaml failed: {e}")
            return 0


# ---------------- flow store (LRU) ----------------

MAX_FLOWS = 500
flow_store = OrderedDict()  # id -> {flow, info, decoded, original, error, ts}
store_lock = threading.Lock()

ADDON = None  # set in load()


def _store_flow(fid, rec):
    with store_lock:
        flow_store[fid] = rec
        while len(flow_store) > MAX_FLOWS:
            flow_store.popitem(last=False)


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
    name = "flowmock"
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

    def _flows_summary(self, filter_re=None, paused_only=False):
        items = []
        with store_lock:
            for fid, rec in flow_store.items():
                f = rec["flow"]
                is_paused = False
                try:
                    is_paused = f.killable if hasattr(f, "killable") else False
                except Exception:
                    pass
                if paused_only and not is_paused:
                    continue
                url = f.request.url
                if filter_re and not filter_re.search(url):
                    continue
                items.append({
                    "id": fid,
                    "url": url,
                    "method": f.request.method,
                    "status": f.response.status_code if f.response else None,
                    "protocol": rec["info"].get("protocol"),
                    "messageType": rec["info"].get("messageType"),
                    "delimited": rec["info"].get("delimited"),
                    "error": rec.get("error"),
                    "paused": is_paused,
                })
        return items

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        if path == "/health":
            with store_lock:
                n = len(flow_store)
            return self._send(200, {"ok": True, "flow_count": n})
        if path == "/flows":
            filter_re = None
            if "filter" in qs:
                try:
                    filter_re = re.compile(qs["filter"][0])
                except re.error:
                    return self._send(400, {"error": "invalid filter regex"})
            paused_only = "paused" in qs
            return self._send(200, self._flows_summary(filter_re, paused_only))
        if path == "/rules":
            type_filter = qs.get("type", [None])[0]
            return self._send(200, ADDON.mock.list(type_filter))
        m = re.match(r"^/flows/([^/]+)$", path)
        if m:
            _, rec = find_flow(m.group(1))
            if not rec:
                return self._send(404, {"error": "not found"})
            f = rec["flow"]
            original = "original" in qs
            data_key = "original" if (original and rec.get("original") is not None) else "decoded"
            return self._send(200, {
                "id": m.group(1),
                "url": f.request.url,
                "protocol": rec["info"].get("protocol"),
                "desc": rec["info"].get("desc"),
                "messageType": rec["info"].get("messageType"),
                "delimited": rec["info"].get("delimited"),
                "content_type": f.response.headers.get("content-type", "") if f.response else "",
                "data": rec.get(data_key),
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
                parts = parse_path(p)
                try:
                    get_by_path(data, parts[:-1] if parts else [])
                except (KeyError, IndexError, TypeError):
                    hint = json.dumps(data, ensure_ascii=False, indent=2)[:500]
                    return self._send(400, {
                        "error": f"path '{p}' not found in data",
                        "hint": hint,
                    })
                set_by_path(data, parts, v)
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
        m = re.match(r"^/flows/([^/]+)/abort$", path)
        if m and ADDON:
            _, rec = find_flow(m.group(1))
            if not rec:
                return self._send(404, {"error": "not found"})
            try:
                rec["flow"].kill()
                return self._send(200, {"ok": True, "aborted": m.group(1)})
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
            rtype = body.get("type", "patch")
            if not url_pat:
                return self._send(400, {"error": "url_pattern required"})
            rule = MockRule.from_dict(dict(body))
            ADDON.mock.add(rule)
            ADDON.mock.save()
            return self._send(200, {"ok": True, "rule": rule.to_dict()})
        if path == "/rules/save" and ADDON:
            ok = ADDON.mock.save()
            return self._send(200 if ok else 500, {"ok": ok})
        if path == "/rules/reload" and ADDON:
            n = ADDON.mock.reload()
            return self._send(200, {"ok": True, "reloaded": n})
        if path == "/intercept" and ADDON:
            enable = body.get("enable", False)
            flt = body.get("filter", "~u .")
            ctx.options.intercept = flt if enable else ""
            return self._send(200, {"ok": True, "intercept": flt if enable else ""})
        return self._send(404, {"error": "unknown route"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/flows":
            with store_lock:
                flow_store.clear()
            return self._send(200, {"ok": True, "cleared": True})
        m = re.match(r"^/rules/(.+)$", path)
        if m and ADDON:
            ok = ADDON.mock.delete(m.group(1))
            if ok:
                ADDON.mock.save()
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
            ctx.options.add_option("flowmock_control_port", int, 9090, "control API port")
            ctx.options.add_option("flowmock_control_host", str, "127.0.0.1", "control API host")
        except Exception:
            pass
        contentviews.add(PBJsonView())
        host = ctx.options.flowmock_control_host
        port = ctx.options.flowmock_control_port
        n = self.mock.reload()
        if n:
            ctx.log.info(f"loaded {n} rules from rules.yaml")
        self.server = ThreadingHTTPServer((host, port), ControlHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        ctx.log.info(f"flowmock control API: http://{host}:{port}")

    def request(self, flow):
        """map_remote rules: rewrite request URL before sending to server."""
        matched = self.mock.matched(flow.request.url, type_filter="map_remote")
        for r in matched:
            if r.is_regex:
                flow.request.url = re.sub(r.url_pattern, r.replacement, flow.request.url)
            else:
                flow.request.url = r.replacement
            from urllib.parse import urlparse as _up
            p = _up(flow.request.url)
            flow.request.headers["Host"] = p.hostname
            ctx.log.info(f"map_remote: {r.url_pattern} -> {flow.request.url}")

    def response(self, flow):
        info = self.codec.detect(flow)
        if not info:
            return
        try:
            raw = flow.response.content or b""
            data = self.codec.decode(info, raw)
        except Exception as e:
            _store_flow(flow.id, {
                "flow": flow, "info": info, "decoded": None, "original": None,
                "error": str(e), "ts": time.time(),
            })
            ctx.log.warn(f"decode failed {flow.request.url}: {e}")
            return

        original_data = data

        # 1. map_local rules: replace entire response body
        map_local_rules = self.mock.matched(flow.request.url, type_filter="map_local")
        for r in map_local_rules:
            try:
                if r.source == "data" and r.data is not None:
                    desc = r.desc or info.get("desc")
                    mtype = r.messageType or info.get("messageType")
                    delim = r.delimited if r.delimited is not None else info.get("delimited", False)
                    if not desc or not mtype:
                        ctx.log.warn(f"map_local data rule needs desc/messageType for {flow.request.url}")
                        continue
                    new_content = self.codec.encode(
                        {"protocol": "protobuf", "desc": desc, "messageType": mtype, "delimited": delim},
                        r.data,
                    )
                    flow.response.content = new_content
                    data = r.data
                elif r.source == "file" and r.file_path:
                    with open(r.file_path, "rb") as f:
                        flow.response.content = f.read()
                    try:
                        data = self.codec.decode(info, flow.response.content)
                    except Exception:
                        data = None
                if r.status:
                    flow.response.status_code = r.status
                if r.headers:
                    for k, v in r.headers.items():
                        flow.response.headers[k] = v
                ctx.log.info(f"map_local applied: {r.url_pattern}")
            except Exception as e:
                ctx.log.warn(f"map_local rule failed: {e}")

        # 2. patch rules: modify specific fields
        patch_rules = self.mock.matched(flow.request.url, info["protocol"], "patch")
        if patch_rules:
            changed = False
            for r in patch_rules:
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

        # 3. breakpoint rules: pause flow for manual editing
        bp_rules = self.mock.matched(flow.request.url, type_filter="breakpoint")
        if bp_rules:
            try:
                flow.intercept()
                ctx.log.info(f"breakpoint hit: {flow.request.url}")
            except Exception as e:
                ctx.log.warn(f"breakpoint intercept failed: {e}")

        _store_flow(flow.id, {
            "flow": flow, "info": info, "decoded": data, "original": original_data,
            "ts": time.time(),
        })

    def done(self):
        if self.server:
            self.server.shutdown()


addons = [TapPbMock()]
