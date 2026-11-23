import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { env } from "../lib/env";
import { agent } from "./helpers";
import { MongoCallRepository } from "../server/storage/calls";
import {
  CallRecordings,
  recordingTwiml,
  recordingsComplete,
} from "../server/recordings/service";
import { AssistantServerEvents } from "../server/webhooks/service";
import { twilioClient } from "../server/providers/twilio";
import { recordingObjects, recordingWav, pcm } from "./recording-fixture";

const sid = "CA" + "1".repeat(32),
  recordingSid = "RE" + "2".repeat(32),
  accountSid = "AC" + "3".repeat(32);
const integration = { skip: !process.env.TEST_MONGODB_URI, timeout: 30000 };

test("recording TwiML captures both tracks before speech or streaming and escapes callback URLs", () => {
  const result = recordingTwiml(
    '<Response><Connect><Stream url="wss://audio.example"/></Connect></Response>',
    "https://calls.example/callback?a=1&b=2",
  );
  assert.ok(result.indexOf("<Recording") < result.indexOf("<Connect>"));
  for (const value of [
    'channels="dual"',
    'track="both"',
    'trim="do-not-trim"',
    "a=1&amp;b=2",
    "in-progress completed absent",
  ])
    assert.ok(result.includes(value));
});

test(
  "dual-channel recording becomes four playable WAVs; reports defer without consuming retries and include direct links",
  integration,
  async (t) => {
    const mongo = await new MongoClient(
      process.env.TEST_MONGODB_URI!,
    ).connect();
    const db = mongo.db(`recordings_${randomUUID().replaceAll("-", "")}`);
    t.after(async () => {
      await db.dropDatabase();
      await mongo.close();
    });
    const calls = new MongoCallRepository(db, () => accountSid);
    await calls.initialize();
    const assistant = agent({
      server: { url: "https://receiver.example/report", timeoutSeconds: 20 },
    });
    await calls.create({
      sid,
      agentId: assistant.id,
      assistant,
      direction: "outbound",
      from: "+14155550100",
      to: "+14155550101",
      status: "completed",
      endedAt: new Date(Date.now() - 20_000).toISOString(),
    });
    const { objects, files } = recordingObjects();
    const jobs: { sid: string; recordingSid: string; retry?: boolean }[] = [];
    let downloaded = 0;
    let source = recordingWav();
    let metadataCall = sid;
    const client = (() => ({
      recordings: () => ({
        fetch: async () => ({
          callSid: metadataCall,
          accountSid,
          status: "completed",
          duration: "2",
          channels: 2,
        }),
      }),
      calls: () => ({
        recordings: {
          list: async () => [{ sid: recordingSid, status: "completed" }],
        },
      }),
    })) as unknown as typeof twilioClient;
    const recordings = new CallRecordings({
      db,
      calls,
      objects,
      enabled: true,
      client,
      credentials: async (call) => {
        assert.equal(call.twilioAccountSid, accountSid);
        return { accountSid, authToken: "test-token", phoneNumber: "" };
      },
      enqueue: async (sid, recordingSid, retry) => {
        jobs.push({ sid, recordingSid, retry });
      },
      request: (async (url, options) => {
        assert.equal(
          new URL(String(url)).searchParams.get("RequestedChannels"),
          "2",
        );
        assert.equal(options?.redirect, "error");
        downloaded++;
        return new Response(new Uint8Array(source), {
          headers: { "content-type": "audio/wav" },
        });
      }) as typeof fetch,
    });
    await recordings.initialize();
    assert.equal(await recordings.prepare(sid), true);
    await recordings.confirmStarted(sid);
    assert.equal(await recordings.prepare(sid), false);
    await recordings.accept(sid, recordingSid, "in-progress");
    assert.equal(await recordings.prepare(sid), false);
    const delivered: any[] = [];
    const events = new AssistantServerEvents({
      db,
      calls,
      objects,
      userId: "owner",
      baseUrl: "https://calls.example",
      send: async (req) => {
        delivered.push(JSON.parse(req.body));
        return 204;
      },
    });
    await events.initialize();
    t.after(() => events.close());
    await events.enqueueEndOfCall(sid);
    await events.tick();
    assert.equal(delivered.length, 0);
    assert.equal((await events.outbox.list(sid))[0].attempts, 0);
    await recordings.accept(sid, recordingSid, "completed");
    await recordings.accept(sid, recordingSid, "in-progress");
    assert.equal((await recordings.view(sid))?.state, "processing");
    assert.equal(jobs.length, 1);
    metadataCall = "CA" + "9".repeat(32);
    await assert.rejects(
      recordings.process(sid, recordingSid),
      /processing failed/,
    );
    assert.equal(downloaded, 0);
    metadataCall = sid;
    source = recordingWav(1);
    await assert.rejects(
      recordings.process(sid, recordingSid),
      /processing failed/,
    );
    assert.equal((await recordings.view(sid))?.state, "processing");
    assert.equal(recordingsComplete((await calls.get(sid))!), false);
    source = recordingWav();
    await recordings.process(sid, recordingSid);
    const call = (await calls.get(sid))!;
    assert.equal((await recordings.view(sid))?.state, "completed");
    assert.equal(recordingsComplete(call), true);
    const stereo = pcm(files.get(call.artifact!.recording!.key)!);
    const mono = pcm(files.get(call.artifact!.monoRecording!.key)!);
    const customer = pcm(files.get(call.artifact!.customerRecording!.key)!);
    const assistantAudio = pcm(
      files.get(call.artifact!.assistantRecording!.key)!,
    );
    assert.equal(stereo.channels, 2);
    for (const result of [mono, customer, assistantAudio]) {
      assert.equal(result.channels, 1);
      assert.equal(result.samples.length, 32000);
    }
    for (let i = 0; i < 16000; i++) {
      const left = stereo.samples.readInt16LE(i * 4),
        right = stereo.samples.readInt16LE(i * 4 + 2);
      assert.equal(customer.samples.readInt16LE(i * 2), left);
      assert.equal(assistantAudio.samples.readInt16LE(i * 2), right);
      assert.ok(
        Math.abs(mono.samples.readInt16LE(i * 2) - (left + right) / 2) <= 1,
      );
    }
    const count = downloaded;
    await recordings.process(sid, recordingSid);
    await recordings.accept(sid, recordingSid, "absent");
    assert.equal(downloaded, count);
    assert.equal((await recordings.view(sid))?.state, "completed");
    await db
      .collection("server_event_deliveries")
      .updateMany({}, { $set: { dueAt: new Date(0) } });
    await events.tick();
    assert.equal(delivered.length, 1);
    const artifact = delivered[0].message.artifact;
    for (const url of [
      artifact.recordingUrl,
      artifact.stereoRecordingUrl,
      artifact.recording.mono.assistantUrl,
      artifact.recording.mono.customerUrl,
    ]) {
      assert.match(url, /^https:\/\/storage.example\//);
      assert.ok(url.includes("disposition=inline"));
    }
    assert.equal(artifact.recordingUrl, artifact.recording.mono.combinedUrl);
    assert.ok(artifact.presignedUrlsExpiresAt);
    assert.equal(
      delivered[0].message.call.costSummary.reconciliationStatus,
      "pending",
    );
    assert.deepEqual(delivered[0].message.call.artifact, artifact);
    await assert.rejects(
      recordings.accept("CA" + "8".repeat(32), recordingSid, "completed"),
      /Call not found/,
    );
    assert.equal(await recordings.view("foreign"), undefined);
    await db
      .collection("calls")
      .updateOne({ sid }, { $unset: { "artifact.assistantRecording": "" } });
    assert.equal((await recordings.view(sid))?.state, "incomplete");
    await recordings.retry(sid);
    assert.equal(jobs.at(-1)?.retry, true);
    await db.collection("recording_requests").updateOne(
      { _id: sid as never },
      {
        $unset: { recordingSid: "" },
        $set: { state: "requested", nextCheckAt: new Date(0) },
      },
    );
    const beforeRecovery = jobs.length;
    await Promise.all([recordings.recover(), recordings.recover()]);
    assert.equal(jobs.length, beforeRecovery + 1);
    assert.equal(jobs.at(-1)?.recordingSid, recordingSid);
  },
);

test(
  "recording wait is bounded and does not block calls with no recorded audio forever",
  integration,
  async (t) => {
    const mongo = await new MongoClient(
      process.env.TEST_MONGODB_URI!,
    ).connect();
    const db = mongo.db(`recording_wait_${randomUUID().replaceAll("-", "")}`);
    t.after(async () => {
      await db.dropDatabase();
      await mongo.close();
    });
    const calls = new MongoCallRepository(db);
    await calls.initialize();
    const assistant = agent({
      server: { url: "https://receiver.example/report", timeoutSeconds: 20 },
    });
    await calls.create({
      sid,
      agentId: assistant.id,
      assistant,
      direction: "outbound",
      from: "",
      to: "",
      status: "completed",
      endedAt: new Date(
        Date.now() - (env.WEBHOOK_RECORDING_WAIT_SECONDS + 1) * 1000,
      ).toISOString(),
    });
    await db
      .collection("recording_requests")
      .insertOne({ _id: sid as never, state: "processing" });
    let delivered = 0;
    const service = new AssistantServerEvents({
      db,
      calls,
      objects: recordingObjects().objects,
      userId: "owner",
      baseUrl: "https://calls.example",
      send: async () => {
        delivered++;
        return 204;
      },
    });
    await service.initialize();
    t.after(() => service.close());
    await service.tick();
    assert.equal(delivered, 1);
  },
);
