"""Offline test for PBEngine: build a .desc + protobuf bytes, verify decode/encode/delimited."""
import sys
sys.path.insert(0, ".")
import tap_pb_mock as t
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
