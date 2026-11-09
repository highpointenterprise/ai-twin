import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type WebSocket from "ws";
import { env } from "../lib/env";
import { meetingInputSchema } from "../lib/meetings";
import { MeetingStore } from "../server/meetings/store";
import { MeetingService } from "../server/meetings/service";
import { MeetingOutput } from "../server/meetings/output";
import { createLiveAvatar } from "../server/meetings/liveavatar";
import { MeetingLoginRequired } from "../server/meetings/browser-driver";
import { AgentStore } from "../server/store/agents";
import { ToolRegistry } from "../server/tools/registry";
import { TraceStore } from "../server/observability/trace";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { SessionPool } from "../server/engine/pool";
import {
  createAdminApp,
  createPublicApp,
  type HttpDeps,
} from "../server/http/routes";
import { audioRms } from "../server/speech/audio";
import type {
  MeetingDriver,
  MeetingDriverEvents,
  AvatarSession,
  AvatarEvents,
  AvatarFactory,
} from "../server/meetings/ports";
import type { SessionInit, ConversationSession } from "../server/core/ports";
import { agent, harness, telephony, tick, until } from "./helpers";

function fixture(
  t: TestContext,
  options: {
    deferJoin?: boolean;
    avatarFactory?: AvatarFactory;
    joinError?: Error;
  } = {},
) {
  const saved = { ...env };
  Object.assign(env, {
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    DEEPGRAM_API_KEY: "test",
    OPENAI_API_KEY: "test",
    ELEVENLABS_API_KEY: "test",
    LIVEAVATAR_API_KEY: "test",
    LIVEAVATAR_AVATAR_ID: "avatar-test",
    MAX_CONCURRENT_MEETINGS: 2,
    MEET_GOOGLE_STORAGE_STATE_PATH: "",
  });
  const agents = new AgentStore(agent()),
    tools = new ToolRegistry(),
    store = new MeetingStore(),
    traces = new TraceStore();
  let events!: MeetingDriverEvents,
    init: SessionInit | undefined,
    admit!: () => void,
    closed = 0,
    avatarStopped = 0,
    avatarStarts = 0;
  const incoming: string[] = [],
    marks: string[] = [],
    outgoing: string[] = [];
  const driver: MeetingDriver = {
    join: async (_r, e) => {
      events = e;
      e.onWaiting();
      if (options.joinError) throw options.joinError;
      if (options.deferJoin)
        await new Promise<void>((resolve) => {
          admit = resolve;
        });
    },
    output: {
      audio: (a) => outgoing.push(a),
      mark: (n) => marks.push(n),
      clear: () => outgoing.push("clear"),
    },
    attachAvatar: async () => {},
    avatarSpeaking: () => {},
    drainAvatar: async () => {},
    close: async () => {
      closed++;
    },
  };
  const avatar: AvatarSession = {
    room: { url: "wss://room.example", token: "ephemeral-token" },
    pushAudio: () => {},
    finish: () => {},
    interrupt: () => {},
    stop: async () => {
      avatarStopped++;
    },
  };
  const engine = {
    transcribe: () => ({ sendAudio: () => {}, close: () => {} }),
    synthesize: () => ({
      push: async () => {},
      end: async () => {},
      close: () => {},
    }),
    model: {
      async *stream() {
        yield { type: "text" as const, text: "Hello" };
      },
      complete: async () => "",
    },
  };
  const service = new MeetingService({
    store,
    agents,
    tools,
    traces,
    drivers: () => driver,
    avatars:
      options.avatarFactory ??
      (async () => {
        avatarStarts++;
        return avatar;
      }),
    engine,
    browserReady: () => true,
    sessionFactory: (i) => {
      init = i;
      return {
        pushAudio: (a) => incoming.push(a),
        handleMark: (n) => marks.push(n),
        close: () => {},
      };
    },
  });
  t.after(async () => {
    await service.shutdown();
    Object.assign(env, saved);
  });
  const input = {
    agentId: agents.list()[0].id,
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  };
  return {
    service,
    store,
    agents,
    tools,
    traces,
    driver,
    avatar,
    input,
    engine,
    incoming,
    marks,
    outgoing,
    get events() {
      return events;
    },
    get init() {
      return init;
    },
    get closed() {
      return closed;
    },
    get avatarStopped() {
      return avatarStopped;
    },
    get avatarStarts() {
      return avatarStarts;
    },
    admit: () => admit(),
  };
}

test("meeting links only permit Google Meet meeting codes and discard extra query data", () => {
  const id = agent().id;
  for (const meetingUrl of [
    "not a URL",
    "",
    "https://",
    "http://meet.google.com/abc-defg-hij",
    "https://evil.example/abc-defg-hij",
    "https://meet.google.com@evil.example/abc-defg-hij",
    "https://meet.google.com/lookup/secret",
    "https://user:pass@meet.google.com/abc-defg-hij",
  ])
    assert.equal(
      meetingInputSchema.safeParse({ agentId: id, meetingUrl }).success,
      false,
    );
  assert.equal(
    meetingInputSchema.parse({
      agentId: id,
      meetingUrl: "https://meet.google.com/abc-defg-hij?authuser=1#value",
    }).meetingUrl,
    "https://meet.google.com/abc-defg-hij",
  );
});
test("waiting for admission does not start the voice engine or avatar and duplicate joins are rejected", async (t) => {
  const f = fixture(t, { deferJoin: true }),
    r = f.service.join({ ...f.input, avatarEnabled: true });
  await until(() => !!f.events);
  assert.equal(f.service.get(r.id).phase, "waiting");
  assert.equal(f.init, undefined);
  assert.equal(f.avatarStarts, 0);
  assert.throws(() => f.service.join(f.input), /already joining/);
  f.admit();
  await until(() => f.service.get(r.id).phase === "active");
  assert.equal(f.avatarStarts, 1);
  assert.equal(f.init!.purpose, "meeting");
  assert.equal(f.init!.inputAudioFormat?.sampleRate, 16000);
  assert.equal(f.init!.outputAudioFormat?.sampleRate, 24000);
});
test("a removed tool cannot strand a meeting reservation", async (t) => {
  const f = fixture(t),
    a = f.agents.list()[0];
  f.agents.update(a.id, {
    ...a,
    toolIds: ["00000000-0000-4000-8000-000000000001"],
  });
  assert.throws(() => f.service.join(f.input), /Tool not found/);
  assert.equal(f.service.list().length, 0);
  f.agents.update(a.id, a);
  const record = f.service.join(f.input);
  await until(() => f.service.get(record.id).phase === "active");
});
test("Meet reuses assistant settings and custom functions without attaching telephone-only tools", async (t) => {
  const f = fixture(t),
    fn = f.tools.save({
      type: "function",
      name: "lookup",
      description: "Lookup",
      parameters: { type: "object" },
      server: { url: "https://functions.example/lookup", timeoutSeconds: 15 },
    }),
    keys = f.tools.save({
      type: "dtmf",
      name: "keys",
      description: "Keys",
      toneDurationMs: 200,
      gapMs: 100,
    });
  const a = f.agents.list()[0];
  f.agents.update(a.id, {
    ...a,
    systemPrompt: "Help our customers",
    toolIds: [fn.id, keys.id],
  });
  const r = f.service.join({ ...f.input, context: "Customer onboarding" });
  await until(() => f.service.get(r.id).phase === "active");
  assert.equal(f.init!.agent.systemPrompt, "Help our customers");
  assert.equal(f.init!.agent.voiceId, a.voiceId);
  assert.deepEqual(
    f.init!.tools?.map((t) => t.id),
    [fn.id],
  );
  assert.match(f.init!.brief, /Customer onboarding/);
  f.events.onAudio("AAAA");
  assert.deepEqual(f.incoming, ["AAAA"]);
  await f.service.stop(r.id);
  assert.equal(f.service.get(r.id).phase, "ended");
  assert.equal(f.closed, 1);
});
test("cancel during admission cleans up and a late admission cannot start a voice session", async (t) => {
  const f = fixture(t, { deferJoin: true }),
    r = f.service.join(f.input);
  await until(() => !!f.events);
  await f.service.stop(r.id);
  f.admit();
  await tick();
  assert.equal(f.init, undefined);
  assert.equal(f.service.get(r.id).phase, "ended");
  assert.equal(f.closed, 1);
});
test("an avatar created after cancellation is stopped rather than attached", async (t) => {
  let release!: (a: AvatarSession) => void;
  const f = fixture(t, {
      avatarFactory: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    r = f.service.join({ ...f.input, avatarEnabled: true });
  await until(() => !!release);
  await f.service.stop(r.id);
  release(f.avatar);
  await until(() => f.avatarStopped === 1);
  assert.equal(f.init, undefined);
  assert.equal(f.service.get(r.id).phase, "ended");
});
test("login and avatar media failures become visible terminal states", async (t) => {
  const f = fixture(t, {
      joinError: new MeetingLoginRequired("Login required"),
    }),
    r = f.service.join(f.input);
  await until(() => f.service.get(r.id).phase === "needs-login");
  assert.equal(f.init, undefined);
  const g = fixture(t);
  g.driver.attachAvatar = async () => {
    throw new Error("Avatar tracks missing");
  };
  const other = g.service.join({ ...g.input, avatarEnabled: true });
  await until(() => g.service.get(other.id).phase === "failed");
  assert.equal(g.avatarStopped, 1);
  assert.equal(g.closed, 1);
  assert.equal(g.init, undefined);
});
test("browser removal ends the original session and avatar exactly once", async (t) => {
  const f = fixture(t),
    r = f.service.join({ ...f.input, avatarEnabled: true });
  await until(() => f.service.get(r.id).phase === "active");
  f.events.onEnded("Removed by host");
  f.events.onEnded("Duplicate event");
  await until(() => f.service.get(r.id).phase === "ended");
  assert.equal(f.closed, 1);
  assert.equal(f.avatarStopped, 1);
  assert.equal(f.service.get(r.id).reason, "Removed by host");
});
test("meeting readiness is independent of Twilio and persists restart failures without media credentials", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.service.readiness().missing, []);
  const dir = mkdtempSync(join(tmpdir(), "meeting-store-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, "meetings.json"),
    store = new MeetingStore(path),
    r = f.service.join(f.input);
  store.create(r);
  const restored = new MeetingStore(path);
  assert.equal(restored.get(r.id).phase, "failed");
  assert.match(restored.get(r.id).reason!, /restarted/);
  assert.ok(!readFileSync(path, "utf8").includes("ephemeral-token"));
});
test("avatar output confirms playback, cancels stale markers, and does not duplicate audio in Meet", async (t) => {
  const f = fixture(t),
    acks: string[] = [],
    audioIds: string[] = [],
    errors: string[] = [];
  let interrupted = 0;
  f.avatar.pushAudio = (_audio, id) => audioIds.push(id);
  f.avatar.interrupt = () => {
    interrupted++;
  };
  const output = new MeetingOutput(
    f.driver,
    (n) => acks.push(n),
    (e) => errors.push(e.message),
    f.avatar,
  );
  output.audio(Buffer.alloc(960, 1).toString("base64"));
  output.mark("first");
  output.events.onStarted(audioIds[0]);
  output.events.onEnded(audioIds[0]);
  await tick();
  assert.deepEqual(acks, ["first"]);
  assert.deepEqual(f.outgoing, []);
  output.audio(Buffer.alloc(960, 1).toString("base64"));
  output.mark("stale");
  output.clear();
  output.events.onEnded(audioIds[1]);
  await tick();
  assert.deepEqual(acks, ["first"]);
  assert.equal(interrupted, 1);
  assert.deepEqual(errors, []);
});
test("PCM meeting speech uses the same engine and honors playback marks", async (t) => {
  const audio = Buffer.alloc(4800);
  for (let i = 0; i < audio.length; i += 2) audio.writeInt16LE(1200, i);
  assert.equal(audioRms(audio, "pcm_s16le"), 1200);
  let inputFormat = "",
    voiceFormat = "",
    marker = "";
  let session!: ConversationSession;
  const h = harness(
    {
      purpose: "meeting",
      inputAudioFormat: { encoding: "pcm_s16le", sampleRate: 16000 },
      outputAudioFormat: { encoding: "pcm_s16le", sampleRate: 24000 },
      agent: agent({
        firstMessageMode: "assistant-speaks-first",
        firstMessage: "Hello in Meet",
      }),
      audioOutput: {
        audio: (pcm) => assert.equal(Buffer.from(pcm, "base64").length, 4800),
        mark: (name) => {
          marker = name;
        },
        clear: () => {},
      },
    },
    {
      transcribe: (_events, _config, format) => {
        inputFormat = JSON.stringify(format);
        return { sendAudio: () => {}, close: () => {} };
      },
      synthesize: (_voice, onAudio, _config, format) => {
        voiceFormat = JSON.stringify(format);
        return {
          push: async () => onAudio(audio.toString("base64")),
          end: async () => {},
          close: () => {},
        };
      },
    },
  );
  session = h.session;
  t.after(() => session.close());
  await until(() => !!marker);
  assert.match(inputFormat, /16000/);
  assert.match(voiceFormat, /24000/);
  assert.equal(h.sent.length, 0);
  session.handleMark(marker);
  await tick();
});

class FakeAvatarSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
test("LiveAvatar uses documented LITE PCM24k messages, correlates events and stops the session", async () => {
  const paths: string[] = [],
    socket = new FakeAvatarSocket(),
    started: string[] = [],
    ended: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("/token")) {
      assert.deepEqual(JSON.parse(init!.body as string), {
        mode: "LITE",
        avatar_id: "avatar",
      });
      return Response.json({
        code: 1000,
        data: { session_token: "private-session-token" },
      });
    }
    assert.equal(
      (init!.headers as Record<string, string>).Authorization,
      "Bearer private-session-token",
    );
    return Response.json({
      code: 1000,
      data: path.endsWith("/start")
        ? {
            livekit_url: "wss://room.example",
            livekit_client_token: "client-token",
            ws_url: "wss://avatar.example/socket",
          }
        : {},
    });
  };
  const avatar = await createLiveAvatar(
    "avatar",
    {
      onStarted: (id) => started.push(id),
      onEnded: (id) => ended.push(id),
      onError: () => {},
    },
    new AbortController().signal,
    request,
    () => {
      queueMicrotask(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    },
  );
  const pcm = Buffer.alloc(72000, 7);
  avatar.pushAudio(pcm.toString("base64"), "utterance");
  avatar.finish("utterance");
  const chunks = socket.sent.filter((e) => e.type === "agent.speak");
  assert.equal(
    Buffer.concat(
      chunks.map((c) => Buffer.from(c.audio as string, "base64")),
    ).compare(pcm),
    0,
  );
  assert.equal(Buffer.from(chunks[0].audio as string, "base64").length, 19200);
  assert.equal(socket.sent.at(-1)?.type, "agent.speak_end");
  socket.emit(
    "message",
    Buffer.from('{"type":"agent.speak_started","event_id":"utterance"}'),
  );
  socket.emit(
    "message",
    Buffer.from('{"type":"agent.speak_ended","event_id":"utterance"}'),
  );
  assert.deepEqual(started, ["utterance"]);
  assert.deepEqual(ended, ["utterance"]);
  avatar.interrupt();
  assert.equal(socket.sent.at(-1)?.type, "agent.interrupt");
  await avatar.stop();
  await avatar.stop();
  assert.equal(paths.filter((p) => p.endsWith("/stop")).length, 1);
});
test("LiveAvatar setup failure cleans up its token without exposing response secrets", async () => {
  const paths: string[] = [];
  const request: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return Response.json({
      code: 1000,
      data: path.endsWith("/token")
        ? { session_token: "private-token" }
        : { unexpected: "secret-response" },
    });
  };
  await assert.rejects(
    () =>
      createLiveAvatar(
        "avatar",
        { onStarted: () => {}, onEnded: () => {}, onError: () => {} },
        new AbortController().signal,
        request,
      ),
    /missing the required LITE media fields/,
  );
  assert.ok(paths.includes("/v1/sessions/stop"));
});

test("LiveAvatar reports a rejected stop even when HTTP succeeds, sharing concurrent cleanup", async () => {
  const socket = new FakeAvatarSocket();
  let stopRequests = 0;
  const request: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/stop")) {
      stopRequests++;
      return Response.json({
        code: 4001,
        message: "sensitive provider response",
      });
    }
    return Response.json({
      code: 1000,
      data: path.endsWith("/token")
        ? { session_token: "private-token" }
        : {
            livekit_url: "wss://room.example",
            livekit_client_token: "client-token",
            ws_url: "wss://avatar.example/socket",
          },
    });
  };
  const avatar = await createLiveAvatar(
    "avatar",
    { onStarted: () => {}, onEnded: () => {}, onError: () => {} },
    new AbortController().signal,
    request,
    () => {
      queueMicrotask(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    },
  );
  const first = avatar.stop(),
    second = avatar.stop();
  assert.equal(first, second);
  await assert.rejects(first, /LiveAvatar rejected the session request/);
  assert.equal(stopRequests, 1);
});

test("meeting controls are admin-only and do not require telephony credentials", async (t) => {
  const f = fixture(t);
  const d: HttpDeps = {
    store: f.agents,
    tools: f.tools,
    registry: new CallRegistry(),
    contexts: new ContextStore(),
    traces: new TraceStore(),
    pool: new SessionPool(10),
    telephony: telephony(),
    pendingCalls: 0,
    listVoices: async () => [],
    meetings: f.service,
  };
  const admin = createAdminApp(d).listen(0, "127.0.0.1"),
    voice = createPublicApp(d).listen(0, "127.0.0.1");
  await Promise.all(
    [admin, voice].map(
      (s) => new Promise<void>((resolve) => s.once("listening", resolve)),
    ),
  );
  t.after(() => {
    admin.close();
    voice.close();
  });
  const url = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`,
    publicUrl = `http://127.0.0.1:${(voice.address() as AddressInfo).port}`;
  assert.equal((await fetch(publicUrl + "/api/meetings")).status, 404);
  const result = await fetch(url + "/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(f.input),
  });
  assert.equal(result.status, 202);
  const r = (await result.json()) as { id: string };
  const denied = await fetch(url + "/api/meetings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://unrelated.example",
    },
    body: JSON.stringify(f.input),
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await fetch(url + `/api/meetings/${r.id}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    200,
  );
});
