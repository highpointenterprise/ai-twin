import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { elevenLabsSynthesizerFactory } from "../server/providers/elevenlabs";
import { SpeechOutput } from "../server/speech/output";
import { CallTrace } from "../server/observability/trace";
import { agent } from "./helpers";

test("ElevenLabs clean EOS close without isFinal still delivers queued phone speech and a playback mark", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => {
    for (const c of server.clients) c.terminate();
    server.close();
  });
  const pcm = Buffer.alloc(800, 0xff),
    events: Record<string, any>[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.text === "") {
        socket.send(JSON.stringify({ audio: pcm.toString("base64") }));
        socket.close(1000, "complete");
      }
    }),
  );
  const synth = elevenLabsSynthesizerFactory((url) => {
    assert.equal(new URL(url).searchParams.get("output_format"), "ulaw_8000");
    return new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
  });
  const output = new SpeechOutput(
    {
      agent: agent(),
      callSid: "CA-close",
      streamSid: "MZ-close",
      brief: "",
      trace: new CallTrace("CA-close"),
      send: (event) => {
        events.push(event);
        if ((event as any).event === "mark")
          queueMicrotask(() => output.mark((event as any).mark.name));
      },
    },
    synth,
  );
  await output.speak(
    "Hello, can you hear me?",
    new AbortController().signal,
    50,
  );
  assert.equal(events.filter((e) => e.event === "media").length, 1);
  assert.equal(
    Buffer.from(
      events.find((e) => e.event === "media")!.media.payload,
      "base64",
    ).compare(pcm),
    0,
  );
  assert.equal(events.filter((e) => e.event === "mark").length, 1);
  assert.equal(events.filter((e) => e.event === "clear").length, 0);
});

for (const scenario of [
  {
    name: "normal close with no audio",
    code: 1000,
    audio: false,
    final: false,
    ok: false,
  },
  {
    name: "abnormal close after audio",
    code: 1011,
    audio: true,
    final: false,
    ok: false,
  },
  {
    name: "explicit final marker with audio",
    code: 1000,
    audio: true,
    final: true,
    ok: true,
  },
])
  test(`ElevenLabs ${scenario.name}`, async (t) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    t.after(() => {
      for (const c of server.clients) c.terminate();
      server.close();
    });
    server.on("connection", (socket) =>
      socket.on("message", (raw) => {
        if (JSON.parse(raw.toString()).text === "") {
          if (scenario.audio)
            socket.send(
              JSON.stringify({
                audio: Buffer.alloc(160, 255).toString("base64"),
              }),
            );
          if (scenario.final) socket.send(JSON.stringify({ isFinal: true }));
          socket.close(scenario.code, "test close");
        }
      }),
    );
    let packets = 0;
    const synth = elevenLabsSynthesizerFactory(
      () =>
        new WebSocket(
          `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        ),
    )("voice", () => packets++);
    t.after(() => synth.close());
    await synth.push("Hello");
    if (scenario.ok) await synth.end();
    else await assert.rejects(synth.end(), /closed before speech completed/);
    assert.equal(packets, scenario.audio ? 1 : 0);
  });

test("ElevenLabs handshake errors report the HTTP status instead of stalling silently", async (t) => {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: (_info, done) => done(false, 401, "Unauthorized"),
  });
  await once(server, "listening");
  t.after(() => server.close());
  const synth = elevenLabsSynthesizerFactory(
    () =>
      new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`),
  )("voice", () => {});
  t.after(() => synth.close());
  await assert.rejects(synth.push("Hello"), /HTTP 401/);
});
