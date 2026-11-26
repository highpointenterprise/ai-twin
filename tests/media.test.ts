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
import type { RedisCallState } from "../server/storage/redis";
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

test("provider keypad reconnect replaces a full-capacity stream and cannot replay or use an expired context", async t => {
  env.STREAM_SECRET = "test-only-media-token-secret-at-least-32-chars";
  const contexts = new ContextStore(), a = agent(), pool = new SessionPool(1), traces = new TraceStore();
  const leases = new Set<string>(), reservations: string[][] = [];
  const state = {
    reserve: async (id: string, limit: number, _ttl?: number, replaces?: string) => {
      reservations.push([id, replaces ?? ""]);
      if (replaces) leases.delete(replaces);
      if (!leases.has(id) && leases.size >= limit) return false;
      leases.add(id); return true;
    },
    release: async (id: string) => { leases.delete(id); },
    setLiveCall: async () => {}, removeLiveCall: async () => {},
  } as unknown as RedisCallState;
  const base = { agent: a, tools: [], brief: "Keep context", direction: "outbound" as const, purpose: "conversation" as const, sid: "CA-resume" };
  contexts.set("original", base);
  const resume = {
    operationId: "key-1", previousContextId: "original", requestedAt: Date.now(), expiresAt: Date.now() + 60_000,
    handling: { started: Date.now(), selections: 1, menus: [], lastMenu: "", screeningEncountered: false, replies: 0 },
  };
  const server = createServer();
  let starts = 0, closes = 0, resumes = 0;
  const wss = attachMediaServer(server, {
    contexts, pool, traces, registry: new CallRegistry(), callState: state, maxConcurrentCalls: 1,
    factory: init => {
      starts++;
      if (init.mediaContextId === "original") init.holdMediaLease!(true);
      else assert.equal(init.dtmfResume?.operationId, "key-1");
      return { pushAudio: () => {}, handleMark: () => {}, close: () => { closes++; } };
    },
    onDtmfResumed: (value, sid) => { assert.equal(value.operationId, "key-1"); assert.equal(sid, "CA-resume"); resumes++; },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); server.close(); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/media`;
  const connect = async (id: string) => {
    const socket = new WebSocket(url);
    await once(socket, "open");
    socket.send(JSON.stringify({ event: "start", start: {
      callSid: "CA-resume", streamSid: `MZ-${id}`, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { agentId: a.id, callId: id, token: signStreamToken(a.id, id) },
    } }));
    return socket;
  };
  const first = await connect("original");
  await until(() => starts === 1);
  contexts.set("expired", { ...base, dtmfResume: { ...resume, expiresAt: Date.now() - 1 } });
  const expired = await connect("expired");
  assert.equal((await once(expired, "close"))[0], 1008);
  assert.equal(starts, 1);
  assert.equal(closes, 0);
  contexts.set("resumed", { ...base, dtmfResume: resume });
  const firstClosed = once(first, "close");
  const second = await connect("resumed");
  await firstClosed;
  await until(() => resumes === 1);
  assert.equal(starts, 2);
  assert.equal(closes, 1);
  assert.equal(pool.size, 1);
  assert.deepEqual([...leases], ["resumed"]);
  assert.ok(reservations.some(([id, old]) => id === "resumed" && old === "original"));
  const replay = await connect("resumed");
  assert.equal((await once(replay, "close"))[0], 1008);
  assert.equal(starts, 2);
  second.send(JSON.stringify({ event: "stop" }));
  await once(second, "close");
  await until(() => leases.size === 0);
});
