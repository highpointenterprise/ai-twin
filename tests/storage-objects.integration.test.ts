import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { MongoClient } from "mongodb";
import { ObjectStore, type ObjectStoreOptions } from "../server/storage/objects";
import { MongoCallRepository } from "../server/storage/calls";

const endpoint = process.env.S3_TEST_ENDPOINT;
const mongoUri = process.env.TEST_MONGODB_URI ?? process.env.MONGODB_TEST_URI;
function options(): ObjectStoreOptions {
  const bucket = process.env.S3_TEST_BUCKET;
  const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error("Object integration tests require S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY_ID, and S3_TEST_SECRET_ACCESS_KEY.");
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.S3_TEST_REGION ?? "us-east-1", forcePathStyle: true };
}
function cleanupClient(config: ObjectStoreOptions) {
  return new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
}
async function readBytes(objects: ObjectStore, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await objects.read(key)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("private object storage round-trips multipart artifacts, recording bytes, empty uploads, and signed downloads", { skip: !endpoint, timeout: 30_000 }, async () => {
  const config = options(), objects = new ObjectStore(config), client = cleanupClient(config);
  const prefix = `integration/${randomUUID()}`;
  const keys = [`${prefix}/large.jsonl`, `${prefix}/recording.wav`, `${prefix}/empty.txt`];
  try {
    await objects.check();
    const data = Buffer.alloc(6 * 1024 * 1024 + 17);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    async function* chunks() {
      for (let offset = 0; offset < data.length; offset += 81_919) yield data.subarray(offset, offset + 81_919);
    }
    const uploaded = await objects.putStream(keys[0], chunks(), "application/x-ndjson");
    assert.equal(uploaded.size, data.length);
    assert.deepEqual(await readBytes(objects, keys[0]), data);

    const recording = randomBytes(32_768);
    await objects.put(keys[1], recording, "audio/wav");
    assert.deepEqual(await readBytes(objects, keys[1]), recording);
    const signed = await objects.signedUrl(keys[1], 60);
    const url = new URL(signed);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
    const download = await fetch(signed);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "audio/wav");
    assert.equal(download.headers.get("content-disposition"), "attachment");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), recording);
    url.search = "";
    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 403);
    await anonymous.arrayBuffer();

    async function* empty() {}
    assert.equal((await objects.putStream(keys[2], empty(), "text/plain")).size, 0);
    assert.equal((await readBytes(objects, keys[2])).length, 0);
  } finally {
    await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys.map(Key => ({ Key })) } }));
    objects.close(); client.destroy();
  }
});

test("durable empty call exports produce readable empty artifacts and retain private object pointers", { skip: !endpoint || !mongoUri, timeout: 30_000 }, async () => {
  const config = options(), objects = new ObjectStore(config), s3 = cleanupClient(config);
  const mongo = new MongoClient(mongoUri!);
  await mongo.connect();
  const db = mongo.db(`artifact_test_${randomUUID().replaceAll("-", "")}`);
  const sid = `CA-integration-${randomUUID()}`;
  const keys = [`calls/${sid}/transcript.txt`, `calls/${sid}/messages.jsonl`, `calls/${sid}/logs.jsonl`];
  try {
    const repository = new MongoCallRepository(db);
    await repository.initialize();
    await repository.create({ sid, agentId: "integration-assistant", direction: "inbound", from: "", to: "", status: "completed" });
    await repository.exportArtifacts(sid, objects);
    const saved = await new MongoCallRepository(db).get(sid);
    assert.equal(saved?.artifact?.transcript?.key, keys[0]);
    assert.equal(saved?.artifact?.messages?.key, keys[1]);
    assert.equal(saved?.artifact?.logs?.key, keys[2]);
    for (const key of keys) assert.equal((await readBytes(objects, key)).length, 0);
    assert.ok(Object.values(saved!.artifact!).every(value => !value || !("url" in value)));
    await repository.appendTranscript(sid, { at: Date.now(), role: "caller", text: "Persistent transcript" }, "same-message");
    await repository.appendTranscript(sid, { at: Date.now(), role: "caller", text: "Persistent transcript" }, "same-message");
    await repository.exportArtifacts(sid, objects);
    assert.equal((await readBytes(objects, keys[0])).toString(), "caller: Persistent transcript\n");
    const message = JSON.parse((await readBytes(objects, keys[1])).toString());
    assert.equal(message.role, "user");
    assert.equal(message.message, "Persistent transcript");
  } finally {
    await db.dropDatabase(); await mongo.close();
    await s3.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys.map(Key => ({ Key })) } }));
    objects.close(); s3.destroy();
  }
});
