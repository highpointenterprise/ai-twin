import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import {
  chromiumExecutable,
  GoogleMeetBrowserDriver,
  MeetingLoginRequired,
} from "../../server/meetings/browser-driver";
import { browserAssets } from "../../server/meetings/browser-assets";
import { meetingInputSchema, type MeetingRecord } from "../../lib/meetings";
import { env } from "../../lib/env";

const html = "<html><body>Controlled meeting fixture</body></html>";
// CI may only expose loopback interfaces; enable local peer-to-peer traffic for
// this fixture. There are no STUN/TURN servers or external media connections.
const options = {
  executablePath: chromiumExecutable(),
  headless: true,
  chromiumSandbox: false,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--allow-loopback-in-peer-connection",
  ],
};
async function until(
  predicate: () => boolean | Promise<boolean>,
  timeout = 6000,
) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Browser condition timed out.");
    await new Promise((r) => setTimeout(r, 30));
  }
}
function tone(seconds: number) {
  const pcm = Buffer.alloc(Math.round(24000 * seconds) * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 24000) * 12000),
      i * 2,
    );
  return pcm.toString("base64");
}
async function media(t: TestContext) {
  const browser = await chromium.launch(options);
  t.after(() => browser.close());
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  // No external server or provider is contacted by this test.
  await context.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await context.addInitScript({ content: (await browserAssets()).media });
  const page = await context.newPage(),
    audio: string[] = [],
    marks: string[] = [],
    errors: string[] = [];
  await page.exposeFunction("__aiTwinAudio", (chunk: string) =>
    audio.push(chunk),
  );
  await page.exposeFunction("__aiTwinMark", (name: string) => marks.push(name));
  await page.exposeFunction("__aiTwinMediaError", (reason: string) =>
    errors.push(reason),
  );
  await page.goto("https://meet.google.com/abc-defg-hij");
  await page.evaluate(() => window.__aiTwinMedia.ready);
  return { page, audio, marks, errors };
}

test("real browser emits virtual microphone audio, confirms actual playback, and cancels stale marks", async (t) => {
  const { page, marks, errors } = await media(t);
  const tracks = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    const context = new AudioContext();
    await context.resume();
    const analyser = context.createAnalyser(),
      source = context.createMediaStreamSource(stream),
      mute = context.createGain();
    mute.gain.value = 0;
    source.connect(analyser);
    analyser.connect(mute);
    mute.connect(context.destination);
    (window as any).testAnalyser = analyser;
    return stream.getTracks().map((track) => ({
      kind: track.kind,
      live: track.readyState,
      settings: track.getSettings(),
    }));
  });
  assert.deepEqual(tracks.map((track) => track.kind).sort(), [
    "audio",
    "video",
  ]);
  assert.ok(tracks.every((t) => t.live === "live"));
  assert.equal(tracks.find((t) => t.kind === "video")?.settings.width, 640);
  const started = Date.now();
  await page.evaluate((pcm) => {
    window.__aiTwinMedia.audio(pcm);
    window.__aiTwinMedia.mark("played");
  }, tone(0.8));
  await until(async () =>
    page.evaluate(() => {
      const a = (window as any).testAnalyser as AnalyserNode,
        samples = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(samples);
      return samples.some((n) => Math.abs(n) > 0.1);
    }),
  );
  assert.equal(
    marks.length,
    0,
    "do not acknowledge queued audio before it plays",
  );
  await until(() => marks.includes("played"));
  assert.ok(Date.now() - started >= 650);
  await page.evaluate((pcm) => {
    window.__aiTwinMedia.audio(pcm);
    window.__aiTwinMedia.mark("cancelled");
    window.__aiTwinMedia.clear();
  }, tone(2));
  await page.evaluate((pcm) => {
    window.__aiTwinMedia.audio(pcm);
    window.__aiTwinMedia.mark("next");
  }, tone(0.1));
  await until(() => marks.includes("next"));
  assert.deepEqual(marks, ["played", "next"]);
  assert.deepEqual(errors, []);
});

test("real WebRTC remote audio reaches the agent as 16 kHz PCM, while child-frame avatar audio stays isolated", async (t) => {
  // Respect this cloud image's managed browser policy; never override it just
  // to make a media test pass. Run this test on the deployment host as well.
  let policy: string | undefined;
  try {
    policy = JSON.parse(
      readFileSync("/etc/chromium/policies/managed/misc.json", "utf8"),
    ).WebRtcIPHandling;
  } catch {}
  if (policy === "disable_non_proxied_udp") {
    t.skip(
      "Managed Chromium policy blocks direct UDP, including local WebRTC peers.",
    );
    return;
  }
  const { page, audio, errors } = await media(t);
  await page.evaluate(async () => {
    const child = document.createElement("iframe");
    child.name = "avatar-test";
    document.body.append(child);
    const other = child.contentWindow as Window & typeof globalThis;
    if (other.RTCPeerConnection === window.RTCPeerConnection)
      throw new Error("Avatar frame inherited meeting capture.");
    const sender = new other.RTCPeerConnection({ iceServers: [] }),
      receiver = new RTCPeerConnection({ iceServers: [] });
    sender.onicecandidate = (e) => {
      if (e.candidate) void receiver.addIceCandidate(e.candidate);
    };
    receiver.onicecandidate = (e) => {
      if (e.candidate) void sender.addIceCandidate(e.candidate);
    };
    const context = new AudioContext({ sampleRate: 48000 }),
      destination = context.createMediaStreamDestination(),
      oscillator = context.createOscillator();
    oscillator.frequency.value = 700;
    oscillator.connect(destination);
    oscillator.start();
    await context.resume();
    destination.stream
      .getTracks()
      .forEach((track) => sender.addTrack(track, destination.stream));
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription!);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription!);
    (window as any).testPeers = { sender, receiver };
    (window as any).testClosePeer = () => {
      sender.close();
      receiver.close();
      oscillator.stop();
      void context.close();
    };
  });
  try {
    await until(() =>
      audio.some((chunk) => {
        const bytes = Buffer.from(chunk, "base64");
        return (
          bytes.length === 640 &&
          Array.from({ length: 320 }, (_, i) => bytes.readInt16LE(i * 2)).some(
            (n) => Math.abs(n) > 1000,
          )
        );
      }),
    );
  } catch (error) {
    t.diagnostic(
      JSON.stringify({
        packets: audio.length,
        errors,
        stats: await page.evaluate(async () => {
          const { sender, receiver } = (window as any).testPeers;
          return {
            sender: sender.connectionState,
            receiver: receiver.connectionState,
            gathering: sender.iceGatheringState,
          };
        }),
      }),
    );
    throw error;
  }
  assert.ok(
    audio.every((chunk) => Buffer.from(chunk, "base64").length === 640),
  );
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).testClosePeer());
});

test("incoming track capture resamples real browser audio into 20 ms PCM frames", async (t) => {
  const { page, audio, errors } = await media(t);
  await page.evaluate(async () => {
    const child = document.createElement("iframe");
    document.body.append(child);
    if ((child.contentWindow as Window & typeof globalThis).RTCPeerConnection === window.RTCPeerConnection)
      throw new Error("Avatar frame inherited meeting capture.");
    const context = new AudioContext({ sampleRate: 48000 }),
      destination = context.createMediaStreamDestination(),
      oscillator = context.createOscillator();
    oscillator.frequency.value = 700;
    oscillator.connect(destination);
    oscillator.start();
    await context.resume();
    const receiver = new RTCPeerConnection({ iceServers: [] }),
      transceiver = receiver.addTransceiver("audio", { direction: "recvonly" });
    // Synthetic remote-track event, real AudioContext/MediaStream/Worklet. This
    // exercises audio conversion without claiming a network media connection.
    receiver.dispatchEvent(
      new RTCTrackEvent("track", {
        track: destination.stream.getAudioTracks()[0],
        receiver: transceiver.receiver,
        transceiver,
        streams: [destination.stream],
      }),
    );
    (window as any).testInput = { receiver, context, oscillator, destination };
  });
  await until(() =>
    audio.some((chunk) => {
      const bytes = Buffer.from(chunk, "base64");
      return (
        bytes.length === 640 &&
        Array.from({ length: 320 }, (_, i) => bytes.readInt16LE(i * 2)).some(
          (n) => Math.abs(n) > 1000,
        )
      );
    }),
  );
  assert.ok(
    audio.every((chunk) => Buffer.from(chunk, "base64").length === 640),
  );
  assert.deepEqual(errors, []);
});

test("avatar audio and camera feed the virtual devices, with observed speech required before completion", async (t) => {
  const { page, audio, errors } = await media(t);
  await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const other = iframe.contentWindow as Window & typeof globalThis;
    const context = new other.AudioContext(),
      destination = context.createMediaStreamDestination(),
      gain = context.createGain(),
      oscillator = context.createOscillator();
    oscillator.frequency.value = 440;
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    await context.resume();
    const canvas = other.document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    setInterval(() => {
      const paint = canvas.getContext("2d")!;
      paint.fillStyle = "rgb(255, 0, 0)";
      paint.fillRect(0, 0, 640, 360);
    }, 40);
    const stream = new other.MediaStream([
      ...destination.stream.getAudioTracks(),
      ...canvas.captureStream(25).getVideoTracks(),
    ]);
    await window.__aiTwinMedia.attachAvatar(stream);
    const out = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      }),
      video = document.createElement("video");
    video.srcObject = out;
    video.muted = true;
    await video.play();
    const probe = context.createAnalyser();
    context.createMediaStreamSource(out).connect(probe);
    (window as any).testAvatar = { gain, context, probe, video };
  });
  await assert.rejects(
    () => page.evaluate(() => window.__aiTwinMedia.drainAvatar()),
    /did not start/,
  );
  await page.evaluate(() => {
    window.__aiTwinMedia.speaking(true);
    (window as any).testAvatar.gain.gain.value = 0.3;
  });
  await until(async () =>
    page.evaluate(() => {
      const { probe } = (window as any).testAvatar as { probe: AnalyserNode };
      const samples = new Float32Array(probe.fftSize);
      probe.getFloatTimeDomainData(samples);
      return samples.some((v) => Math.abs(v) > 0.05);
    }),
  );
  await until(async () =>
    page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const paint = canvas.getContext("2d")!;
      paint.drawImage((window as any).testAvatar.video, 0, 0);
      return paint.getImageData(320, 180, 1, 1).data[0] > 240;
    }),
  );
  const draining = page.evaluate(() => window.__aiTwinMedia.drainAvatar());
  let done = false;
  void draining.then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(done, false, "speaker is still audible");
  await page.evaluate(() => ((window as any).testAvatar.gain.gain.value = 0));
  await draining;
  assert.equal(
    audio.length,
    0,
    "avatar audio must not feed the incoming transcription channel",
  );
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.__aiTwinMedia.clear());
});

const record: MeetingRecord = {
  ...meetingInputSchema.parse({
    agentId: "00000000-0000-4000-8000-000000000001",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  }),
  displayName: "Test AI assistant",
  id: "test-meeting",
  phase: "joining",
  createdAt: 0,
  updatedAt: 0,
};
async function fixtureDriver(t: TestContext, body: string) {
  let page!: Page, browser!: Browser;
  const saved = env.MEET_GOOGLE_STORAGE_STATE_PATH;
  env.MEET_GOOGLE_STORAGE_STATE_PATH = "";
  t.after(() => {
    env.MEET_GOOGLE_STORAGE_STATE_PATH = saved;
  });
  const driver = new GoogleMeetBrowserDriver(async () => {
    browser = await chromium.launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      await context.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body }),
      );
      context.on("page", (value) => {
        page = value;
      });
      return context;
    };
    return browser;
  });
  t.after(() => driver.close());
  const states: string[] = [],
    errors: Error[] = [],
    controller = new AbortController();
  const join = driver.join(
    record,
    {
      onWaiting: () => {
        states.push("waiting");
      },
      onAudio: () => {},
      onMark: () => {},
      onEnded: () => {
        states.push("ended");
      },
      onError: (error) => {
        errors.push(error);
      },
    },
    controller.signal,
  );
  void join.catch(() => {});
  return {
    driver,
    join,
    controller,
    states,
    errors,
    page: () => page,
    browser: () => browser,
  };
}
test("browser waits for host admission and notices removal; cancellation closes its worker", async (t) => {
  const f = await fixtureDriver(
    t,
    "<label>Your name<input></label><button onclick=\"document.body.innerHTML='Waiting for admission'\">Ask to join</button>",
  );
  let joined = false;
  void f.join.then(() => {
    joined = true;
  });
  await until(() => f.states.includes("waiting"));
  assert.equal(joined, false);
  await f.page().evaluate(() => {
    document.body.innerHTML = "<button>Leave call</button>";
  });
  await f.join;
  assert.equal(joined, true);
  await f.page().evaluate(() => {
    document.body.innerHTML = "The host removed you";
  });
  await until(() => f.states.includes("ended"));
  await f.driver.close();
  assert.equal(f.browser().isConnected(), false);
  assert.deepEqual(f.errors, []);
});
test("browser reports login requirements and respects cancellation in the waiting room", async (t) => {
  const login = await fixtureDriver(t, "<p>You need to sign in to join</p>");
  await assert.rejects(login.join, MeetingLoginRequired);
  await login.driver.close();
  const waiting = await fixtureDriver(
    t,
    "<button onclick=\"document.body.innerHTML='Waiting'\">Ask to join</button>",
  );
  await until(() => waiting.states.includes("waiting"));
  waiting.controller.abort();
  await assert.rejects(waiting.join, /cancelled/);
  await waiting.driver.close();
  assert.equal(waiting.browser().isConnected(), false);
});
