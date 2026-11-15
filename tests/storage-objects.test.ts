import test from "node:test";
import assert from "node:assert/strict";
import type { S3Client } from "@aws-sdk/client-s3";
import { ObjectStore } from "../server/storage/objects";

const options = { endpoint: "http://localhost:9000", region: "us-east-1", bucket: "test", accessKeyId: "test", secretAccessKey: "test" };
function fakeStore(failPart = false) {
  const commands: { name: string; input: Record<string, any> }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "CreateMultipartUploadCommand") return { UploadId: "upload-1" };
      if (command.constructor.name === "UploadPartCommand") {
        if (failPart) throw new Error("Storage offline");
        return { ETag: `part-${command.input.PartNumber}` };
      }
      return {};
    }, destroy() {},
  } as unknown as S3Client;
  return { store: new ObjectStore(options, client), commands };
}

test("large artifact streams upload in bounded ordered parts without public ACLs", async () => {
  const { store, commands } = fakeStore();
  async function* stream() {
    yield Buffer.alloc(3 * 1024 * 1024, 1);
    yield Buffer.alloc(4 * 1024 * 1024, 2);
    yield "last";
  }
  const saved = await store.putStream("calls/CA1/logs.jsonl", stream(), "application/x-ndjson");
  const parts = commands.filter(c => c.name === "UploadPartCommand");
  assert.deepEqual(parts.map(p => p.input.ContentLength), [5 * 1024 * 1024, 2 * 1024 * 1024 + 4]);
  assert.equal(saved.size, 7 * 1024 * 1024 + 4);
  assert.equal(parts[0].input.Body[0], 1);
  assert.equal(parts[0].input.Body[3 * 1024 * 1024], 2);
  assert.equal(parts[1].input.Body.subarray(-4).toString(), "last");
  assert.deepEqual(commands.at(-1)?.input.MultipartUpload.Parts, [
    { ETag: "part-1", PartNumber: 1 }, { ETag: "part-2", PartNumber: 2 },
  ]);
  assert.ok(commands.every(c => !("ACL" in c.input)));
});

test("failed multipart exports abort partial uploads and propagate failure", async () => {
  const { store, commands } = fakeStore(true);
  async function* stream() { yield "hello"; }
  await assert.rejects(store.putStream("calls/CA1/transcript.txt", stream(), "text/plain"), /Storage offline/);
  assert.equal(commands.at(-1)?.name, "AbortMultipartUploadCommand");
  assert.ok(!commands.some(c => c.name === "CompleteMultipartUploadCommand"));
});

test("input stream failures abort uploads", async () => {
  const { store, commands } = fakeStore();
  async function* stream() { yield "hello"; throw new Error("Database unavailable"); }
  await assert.rejects(store.putStream("calls/CA1/logs.jsonl", stream(), "application/x-ndjson"), /Database unavailable/);
  assert.equal(commands.at(-1)?.name, "AbortMultipartUploadCommand");
});

test("empty artifacts are valid and private puts preserve UTF-8 byte length", async () => {
  const { store, commands } = fakeStore();
  async function* empty() {}
  assert.equal((await store.putStream("empty.txt", empty(), "text/plain")).size, 0);
  assert.equal((await store.put("hello.txt", "héllo", "text/plain")).size, 6);
  assert.equal(commands.at(-1)?.input.ContentLength, 6);
});

test("invalid object paths and long-lived download links are rejected", async () => {
  const { store } = fakeStore();
  await assert.rejects(store.put("../secret", "x", "text/plain"), /Invalid object key/);
  await assert.rejects(store.signedUrl("valid", 901), /15 minutes/);
});
