"""Offline test for PBEngine + MockRule + MockEngine: build a .desc + protobuf bytes, verify decode/encode/delimited/rules."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "addon"))
import pbmockx_addon as t
from google.protobuf import descriptor_pb2

# Build a FileDescriptorSet (.desc) for: demo.Person { string name=1; int32 id=2; }
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
fds = descriptor_pb2.FileDescriptorSet()
fds.file.append(fd)
desc_bytes = fds.SerializeToString()

engine = t.PBEngine()
engine.cache.get = lambda url: desc_bytes  # bypass network

cls = engine.get_class("test", "demo.Person")
person = cls(name="Alice", id=42)
pb_data = person.SerializeToString()

# decode
decoded = engine.decode("test", "demo.Person", False, pb_data)
assert decoded == {"name": "Alice", "id": 42}, decoded

# encode round-trip (modify)
encoded = engine.encode("test", "demo.Person", False, {"name": "Bob", "id": 99})
decoded2 = engine.decode("test", "demo.Person", False, encoded)
assert decoded2 == {"name": "Bob", "id": 99}, decoded2

# delimited list (2 messages)
delim = t.encode_varint(len(pb_data)) + pb_data + t.encode_varint(len(pb_data)) + pb_data
decoded_list = engine.decode("test", "demo.Person", True, delim)
assert len(decoded_list) == 2 and decoded_list[0] == {"name": "Alice", "id": 42}, decoded_list

# encode delimited round-trip
enc_list = engine.encode("test", "demo.Person", True, [{"name": "X", "id": 1}, {"name": "Y", "id": 2}])
dec_list = engine.decode("test", "demo.Person", True, enc_list)
assert dec_list == [{"name": "X", "id": 1}, {"name": "Y", "id": 2}], dec_list

# path navigation
assert t.parse_path("a.b[0].c") == ["a", "b", 0, "c"]
d = {"a": {"b": [{"c": 1}]}}
t.set_by_path(d, t.parse_path("a.b[0].c"), 999)
assert d["a"]["b"][0]["c"] == 999, d

print("ALL PBEngine tests PASSED")
print("  decode:", decoded)
print("  encode round-trip:", decoded2)
print("  delimited:", decoded_list)
print("  delimited round-trip:", dec_list)

# ---------------- MockRule / MockEngine tests ----------------

# MockRule round-trip
r1 = t.MockRule("api/game", type="patch", path="game.name", value="test")
d1 = r1.to_dict()
assert d1["type"] == "patch" and d1["url_pattern"] == "api/game" and d1["path"] == "game.name"
r1b = t.MockRule.from_dict(dict(d1))
assert r1b.type == "patch" and r1b.url_pattern == "api/game" and r1b.path == "game.name"

# map_local rule
r2 = t.MockRule("api/game", type="map_local", source="data",
                data={"game": {"name": "mock"}}, desc="http://x/d", messageType="Game")
assert r2.to_dict()["type"] == "map_local" and r2.to_dict()["source"] == "data"

# map_remote rule
r3 = t.MockRule("api.test", type="map_remote", replacement="http://mock.com", is_regex=False)
assert r3.to_dict()["replacement"] == "http://mock.com"

# breakpoint rule
r4 = t.MockRule("api/game", type="breakpoint", phase="response")
assert r4.to_dict()["type"] == "breakpoint"

# MockEngine: add + dedup
engine = t.MockEngine()
engine.add(r1)
engine.add(t.MockRule("api/game", type="patch", path="game.name", value="other"))  # dedup replace
assert len(engine.list()) == 1, f"expected 1 after dedup, got {len(engine.list())}"
engine.add(t.MockRule("api/game", type="patch", path="game.id", value=99))  # different path = new
assert len(engine.list()) == 2, f"expected 2, got {len(engine.list())}"

# MockEngine: matched by type
engine.add(r3)
engine.add(r4)
mr = engine.matched("https://api.test.com/game", type_filter="map_remote")
assert len(mr) == 1 and mr[0].type == "map_remote"
bp = engine.matched("https://example.com/api/game", type_filter="breakpoint")
assert len(bp) == 1 and bp[0].type == "breakpoint"
patch_matches = engine.matched("https://example.com/api/game", type_filter="patch")
assert len(patch_matches) == 2, f"expected 2 patch, got {len(patch_matches)}"

# MockEngine: delete by id
rid = r4.id
assert engine.delete(rid) is True
assert len(engine.list(type_filter="breakpoint")) == 0

# MockEngine: delete by index (backward compat)
engine.add(t.MockRule("api/x", type="patch", path="x", value=1))
before = len(engine.list())
engine.delete("0")
assert len(engine.list()) == before - 1, f"index delete failed: {before} -> {len(engine.list())}"

print("ALL MockRule/MockEngine tests PASSED")
