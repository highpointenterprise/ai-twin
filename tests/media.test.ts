import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { attachMediaServer } from "../server/http/media";
import { ContextStore } from "../server/store/contexts";
import { SessionPool } from "../server/engine/pool";
import { CallRegistry } from "../server/store/calls";
import { TraceStore } from "../server/observability/trace";
import { env } from "../lib/env";
import { signStreamToken } from "../lib/token";
import { agent, until } from "./helpers";
test("media authenticates a call-bound, one-use snapshot and routes audio, marks, and keypad", async (t) => {
  env.STREAM_SECRET = "test-only-media-token-secret-at-least-32-chars";
  const contexts = new ContextStore(),
    a = agent(),
    pool = new SessionPool(1),
    registry = new CallRegistry();
  contexts.set("one-use", {
    agent: a,
    tools: [],
    brief: "Initial context",
    direction: "inbound",
    purpose: "conversation",
    sid: "CA-media",
  });
  const server = createServer();
  let starts = 0,
    closed = 0,
    audio = "",
    mark = "",
    digit = "";
  const wss = attachMediaServer(server, {
    contexts,
    pool,
    registry,
    traces: new TraceStore(),
    factory: (init) => {
      starts++;
      assert.equal(init.agent.name, "Test agent");
      assert.equal(init.brief, "Initial context");
      return {
        pushAudio: (p) => {
          audio = p;
        },
        handleMark: (n) => {
          mark = n;
        },
        handleDtmf: (d) => {
          digit = d;
        },
        close: () => {
          closed++;
        },
      };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/media`;
  t.after(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.close();
  });
  const event = {
    event: "start",
    start: {
      callSid: "CA-media",
      streamSid: "MZ-media",
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: {
        agentId: a.id,
        callId: "one-use",
        token: signStreamToken(a.id, "one-use"),
      },
    },
  };
  const bad = new WebSocket(url);
  await once(bad, "open");
  bad.send(
    JSON.stringify({
      ...event,
      start: { ...event.start, callSid: "CA-wrong" },
    }),
  );
  const [code] = await once(bad, "close");
  assert.equal(code, 1008);
  assert.equal(starts, 0);
  assert.ok(contexts.get("one-use"));
  const ws = new WebSocket(url);
  await once(ws, "open");
  ws.send(JSON.stringify(event));
  await until(() => starts === 1);
  assert.equal(contexts.get("one-use"), undefined);
  ws.send(JSON.stringify({ event: "media", media: { payload: "////" } }));
  ws.send(JSON.stringify({ event: "mark", mark: { name: "played" } }));
  ws.send(JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } }));
  await until(() => digit === "1");
  assert.equal(audio, "////");
  assert.equal(mark, "played");
  ws.send(JSON.stringify({ event: "stop" }));
  await once(ws, "close");
  assert.equal(closed, 1);
  assert.equal(pool.isFull, false);
  const replay = new WebSocket(url);
  await once(replay, "open");
  replay.send(JSON.stringify(event));
  const [replayCode] = await once(replay, "close");
  assert.equal(replayCode, 1008);
  assert.equal(starts, 1);
});
