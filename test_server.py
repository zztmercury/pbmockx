"""Local test server: serves a .desc file, a protobuf response (Charles CT), and a JSON response."""
import http.server
import socketserver
from google.protobuf import descriptor_pb2

# build .desc for demo.Person { string name=1; int32 id=2; }
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
DESC_BYTES = fds.SerializeToString()

# build a demo.Person message bytes (manually via the same pool)
from google.protobuf import descriptor_pool, message_factory
pool = descriptor_pool.DescriptorPool()
pool.Add(fd)
Person = message_factory.GetMessageClass(pool.FindMessageTypeByName("demo.Person"))
PB_BYTES = Person(name="Alice", id=42).SerializeToString()

PORT = 8889


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/Model.desc":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(DESC_BYTES)))
            self.end_headers()
            self.wfile.write(DESC_BYTES)
        elif self.path == "/api/person":
            ct = 'application/x-protobuf; desc="http://127.0.0.1:%d/Model.desc"; messageType="demo.Person"' % PORT
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(PB_BYTES)))
            self.end_headers()
            self.wfile.write(PB_BYTES)
        elif self.path == "/api/data":
            body = b'{"game":{"id":1,"name":"TapTap"}}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


print(f"test server on :{PORT}", flush=True)
socketserver.TCPServer(("127.0.0.1", PORT), H).serve_forever()
