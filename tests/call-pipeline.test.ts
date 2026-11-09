import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import { env } from "../lib/env";
import { AgentStore } from "../server/store/agents";
import { CallRegistry } from "../server/store/calls";
import { ContextStore } from "../server/store/contexts";
import { ToolRegistry } from "../server/tools/registry";
import { SessionPool } from "../server/engine/pool";
import { TraceStore } from "../server/observability/trace";
import { StandardSession } from "../server/engine/standard-session";
import {
  createAdminApp,
  createPublicApp,
  type HttpDeps,
} from "../server/http/routes";
import { attachMediaServer } from "../server/http/media";
import { createTwilioTelephony } from "../server/providers/twilio";
import { elevenLabsSynthesizerFactory } from "../server/providers/elevenlabs";
import { deepgramTranscriberFactory } from "../server/providers/deepgram";
import { agent, telephony, until } from "./helpers";

for (const direction of ["inbound", "outbound"] as const)
  test(`${direction}: signed webhook through real media/provider sockets delivers opening and reply audio`, async (t) => {
    const saved = { ...env };
    Object.assign(env, {
      TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
      TWILIO_AUTH_TOKEN: "test-webhook-auth",
      DEEPGRAM_API_KEY: "test-dg",
      OPENAI_API_KEY: "test-ai",
      ELEVENLABS_API_KEY: "test-el",
      ELEVENLABS_VOICE_ID: "server-voice",
      PUBLIC_BASE_URL: "https://test.ngrok.app",
      STREAM_SECRET: "test-signing-secret-of-at-least-32-characters",
    });
    t.after(() => Object.assign(env, saved));
    const el = new WebSocketServer({ port: 0, host: "127.0.0.1" }),
      dg = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await Promise.all([once(el, "listening"), once(dg, "listening")]);
    t.after(() => {
      for (const s of [el, dg]) {
        for (const c of s.clients) c.terminate();
        s.close();
      }
    });
    let voices = 0,
      transcribed = 0;
    el.on("connection", (s) =>
      s.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.text === "") {
          voices++;
          s.send(
            JSON.stringify({
              audio: Buffer.alloc(800, 0xab).toString("base64"),
            }),
          );
          s.close(1000);
        }
      }),
    );
    dg.on("connection", (s) =>
      s.on("message", () => {
        transcribed++;
        s.send(
          JSON.stringify({
            type: "TurnInfo",
            event: "EndOfTurn",
            transcript: "What hours are you open?",
          }),
        );
      }),
    );
    const d: HttpDeps = {
      store: new AgentStore(
        agent({
          voiceId: "",
          firstMessageMode: "assistant-speaks-first",
          firstMessage: "Hello, can you hear me?",
          startSpeakingPlan: { waitSeconds: 0.05 },
        }),
      ),
      registry: new CallRegistry(),
      contexts: new ContextStore(),
      tools: new ToolRegistry(),
      traces: new TraceStore(),
      pool: new SessionPool(5),
      telephony: telephony(),
      listVoices: async () => [],
      pendingCalls: 0,
    };
    const real = createTwilioTelephony(),
      sid = `CA-${direction}`;
    let outboundUrl = "";
    d.telephony = {
      ...d.telephony,
      validateWebhook: real.validateWebhook,
      streamTwiml: real.streamTwiml,
      listNumbers: async () => [
        { sid: "PN-test", phoneNumber: "+14155550100", label: "Test" },
      ],
      placeCall: async (request) => {
        outboundUrl = request.url;
        return sid;
      },
    };
    d.store.assign("+14155550100", d.store.list()[0].id);
    const publicServer = createServer(createPublicApp(d)),
      admin = createAdminApp(d).listen(0, "127.0.0.1");
    const media = attachMediaServer(publicServer, {
      ...d,
      factory: (init) =>
        new StandardSession(init, {
          transcribe: deepgramTranscriberFactory((url) => {
            assert.equal(new URL(url).searchParams.get("encoding"), "mulaw");
            return new WebSocket(
              `ws://127.0.0.1:${(dg.address() as AddressInfo).port}`,
            );
          }),
          synthesize: elevenLabsSynthesizerFactory((url) => {
            assert.match(url, /server-voice/);
            assert.equal(
              new URL(url).searchParams.get("output_format"),
              "ulaw_8000",
            );
            return new WebSocket(
              `ws://127.0.0.1:${(el.address() as AddressInfo).port}`,
            );
          }),
          model: {
            async *stream() {
              yield { type: "text", text: "We are open until five." };
            },
            complete: async () => "",
          },
        }),
    });
    publicServer.listen(0, "127.0.0.1");
    await Promise.all([
      once(publicServer, "listening"),
      once(admin, "listening"),
    ]);
    t.after(() => {
      for (const c of media.clients) c.terminate();
      d.pool.closeAll();
      media.close();
      publicServer.close();
      admin.close();
    });
    const publicUrl = `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}`;
    let path = "/twilio/voice/inbound";
    if (direction === "outbound") {
      const response = await fetch(
        `http://127.0.0.1:${(admin.address() as AddressInfo).port}/api/calls`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: d.store.list()[0].id,
            to: "+14155550123",
          }),
        },
      );
      assert.equal(response.status, 201);
      const url = new URL(outboundUrl);
      path = url.pathname + url.search;
    }
    const body = {
      CallSid: sid,
      From: direction === "inbound" ? "+14155550123" : "+14155550100",
      To: direction === "inbound" ? "+14155550100" : "+14155550123",
    };
    const response = await fetch(publicUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          env.TWILIO_AUTH_TOKEN,
          env.PUBLIC_BASE_URL + path,
          body,
        ),
      },
      body: new URLSearchParams(body),
    });
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.match(
      xml,
      /statusCallback="https:\/\/test.ngrok.app\/twilio\/stream-status"/,
    );
    const params = Object.fromEntries(
      [...xml.matchAll(/<Parameter name="([^"]+)" value="([^"]+)"/g)].map(
        (m) => [m[1], m[2]],
      ),
    );
    assert.ok(params.token);
    const socket = new WebSocket(publicUrl.replace("http:", "ws:") + "/media"),
      packets: Record<string, any>[] = [];
    socket.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      packets.push(m);
      if (m.event === "mark")
        socket.send(JSON.stringify({ event: "mark", mark: m.mark }));
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        event: "connected",
        protocol: "Call",
        version: "1.0.0",
      }),
    );
    socket.send(
      JSON.stringify({
        event: "start",
        start: {
          callSid: sid,
          streamSid: "MZ-test",
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1,
          },
          customParameters: params,
        },
      }),
    );
    await until(
      () =>
        d.traces
          .for(sid)
          .view()
          .transcript.filter((l) => l.role === "agent").length === 1,
    );
    socket.send(
      JSON.stringify({
        event: "media",
        media: { payload: Buffer.alloc(160, 0xff).toString("base64") },
      }),
    );
    await until(
      () =>
        d.traces
          .for(sid)
          .view()
          .transcript.filter((l) => l.role === "agent").length === 2,
    );
    assert.equal(voices, 2);
    assert.equal(transcribed, 1);
    assert.equal(packets.filter((p) => p.event === "media").length, 2);
    assert.ok(
      packets
        .filter((p) => p.event === "media")
        .every(
          (p) =>
            p.streamSid === "MZ-test" &&
            Buffer.from(p.media.payload, "base64").length === 800,
        ),
    );
    const events = d.traces
      .for(sid)
      .view()
      .events.map((e) => e.event);
    for (const event of [
      "media.started",
      "media.first_outbound_audio",
      "tts.completed",
      "playback.acknowledged",
      "stt.connected",
      "llm.completed",
    ])
      assert.ok(events.includes(event), event);
    assert.equal(
      d.store.list()[0].voiceId,
      "",
      "using the server default must not overwrite the saved assistant",
    );
    socket.send(JSON.stringify({ event: "stop" }));
    await once(socket, "close");
    assert.equal(d.pool.size, 0);
  });
