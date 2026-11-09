// Runs before Google Meet's scripts. Only the meeting frame is instrumented;
// the avatar receiver runs in an uninstrumented, same-origin child frame.
// FILE: src/server/meetings/browser/media.ts  (replace the entire file with this)
export interface MeetingMediaBridge {
  ready: Promise<void>;
  audio: (pcm24k: string) => void;
  mark: (name: string) => void;
  clear: () => void;
  attachAvatar: (stream: MediaStream) => Promise<void>;
  speaking: (active: boolean) => void;
  drainAvatar: () => Promise<void>;
}
declare global {
  interface Window {
    __aiTwinMedia: MeetingMediaBridge;
    __aiTwinAudio: (base64: string) => Promise<void>;
    __aiTwinMark: (name: string) => Promise<void>;
    __aiTwinMediaError: (reason: string) => Promise<void>;
  }
}

const CAPTURE_FRAME_SAMPLES = 800;
const MAX_INFLIGHT_PACKETS = 40;
const MAX_CONSECUTIVE_DROPS = 100;
const BASE64_CHUNK_BYTES = 0x8000;

export function installMeetingMedia(): void {
  if (window.top !== window || window.__aiTwinMedia) return;
  const input = new AudioContext({ sampleRate: 16000 }),
    output = new AudioContext({ sampleRate: 24000 });
  const microphone = output.createMediaStreamDestination();
  const mixer = input.createGain();
  const sources = new Map<string, MediaStreamAudioSourceNode>();
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const paint = canvas.getContext("2d")!;
  const camera = canvas.captureStream(25);
  const avatarVideo = document.createElement("video");
  avatarVideo.autoplay = true;
  avatarVideo.muted = true;
  avatarVideo.playsInline = true;
  const avatarGain = output.createGain();
  avatarGain.gain.value = 0;
  avatarGain.connect(microphone);
  const analyser = output.createAnalyser();
  analyser.fftSize = 1024;
  const analysis = new Float32Array(analyser.fftSize);
  let avatar = false,
    speaking = false,
    seenSpeech = false,
    quietSince = performance.now(),
    inflight = 0,
    consecutiveDrops = 0;
  let nextAt = 0,
    queuedFrames = 0,
    playedFrames = 0;
  const nodes = new Set<AudioBufferSourceNode>();
  const marks: { name: string; frame: number }[] = [];
  const fatal = (reason: string) => {
    void window.__aiTwinMediaError?.(reason).catch(() => {});
  };
  const emitMark = (name: string) => {
    void window
      .__aiTwinMark(name)
      .catch(() => fatal("Playback acknowledgement failed."));
  };
  const processMarks = () => {
    while (marks[0] && marks[0].frame <= playedFrames)
      emitMark(marks.shift()!.name);
  };
  const addTrack = (track: MediaStreamTrack) => {
    if (track.kind !== "audio" || sources.has(track.id)) return;
    const source = input.createMediaStreamSource(new MediaStream([track]));
    source.connect(mixer);
    sources.set(track.id, source);
    track.addEventListener(
      "ended",
      () => {
        source.disconnect();
        sources.delete(track.id);
      },
      { once: true },
    );
  };
  const NativePeerConnection = window.RTCPeerConnection;
  class MeetingPeerConnection extends NativePeerConnection {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      this.addEventListener("track", (event) => addTrack(event.track));
    }
  }
  window.RTCPeerConnection = MeetingPeerConnection;
  const ready = (async () => {
    const source = `class Capture extends AudioWorkletProcessor {
      constructor(){super();this.samples=new Int16Array(${CAPTURE_FRAME_SAMPLES});this.used=0;}
      process(inputs){const channels=inputs[0];if(!channels?.length)return true;
        for(let i=0;i<channels[0].length;i++){let value=0;for(const channel of channels)value+=channel[i]||0;value/=channels.length;
          this.samples[this.used++]=Math.max(-32768,Math.min(32767,Math.round(value*32767)));
          if(this.used===${CAPTURE_FRAME_SAMPLES}){this.port.postMessage(this.samples.buffer,[this.samples.buffer]);this.samples=new Int16Array(${CAPTURE_FRAME_SAMPLES});this.used=0;}}
        return true;}}
      registerProcessor('ai-twin-capture',Capture);`;
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    try {
      await input.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const capture = new AudioWorkletNode(input, "ai-twin-capture");
    const silent = input.createGain();
    silent.gain.value = 0;
    mixer.connect(capture);
    capture.connect(silent);
    silent.connect(input.destination);
    capture.port.onmessage = (event) => {
      if (!sources.size) return;
      if (inflight >= MAX_INFLIGHT_PACKETS) {
        if (++consecutiveDrops >= MAX_CONSECUTIVE_DROPS)
          fatal("Meeting audio processing cannot keep up.");
        return;
      }
      consecutiveDrops = 0;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES),
        );
      inflight++;
      void window
        .__aiTwinAudio(btoa(binary))
        .catch(() => fatal("Meeting audio transport failed."))
        .finally(() => inflight--);
    };
    await Promise.all([input.resume(), output.resume()]);
  })();
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    await ready;
    const tracks: MediaStreamTrack[] = [];
    if (constraints?.audio)
      tracks.push(
        ...microphone.stream.getAudioTracks().map((track) => track.clone()),
      );
    if (constraints?.video)
      tracks.push(...camera.getVideoTracks().map((track) => track.clone()));
    if (!tracks.length)
      throw new DOMException("Request audio or video.", "TypeError");
    return new MediaStream(tracks);
  };
  setInterval(() => {
    if (avatar && avatarVideo.readyState >= 2)
      paint.drawImage(avatarVideo, 0, 0, 640, 360);
    else {
      paint.fillStyle = "#18181b";
      paint.fillRect(0, 0, 640, 360);
      paint.fillStyle = "#fafafa";
      paint.font = "28px sans-serif";
      paint.textAlign = "center";
      paint.fillText("AI assistant", 320, 180);
    }
    if (avatar && speaking) {
      analyser.getFloatTimeDomainData(analysis);
      const rms = Math.sqrt(
        analysis.reduce((v, n) => v + n * n, 0) / analysis.length,
      );
      if (rms > 0.004) {
        seenSpeech = true;
        quietSince = performance.now();
      }
    }
  }, 40);
  window.__aiTwinMedia = {
    ready,
    audio: (base64) => {
      if (avatar)
        throw new Error(
          "Raw speech must go through LiveAvatar when an avatar is enabled.",
        );
      const binary = atob(base64);
      if (binary.length % 2) throw new Error("Expected PCM16 audio.");
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        view = new DataView(bytes.buffer);
      const buffer = output.createBuffer(1, bytes.length / 2, 24000),
        channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++)
        channel[i] = view.getInt16(i * 2, true) / 32768;
      const node = output.createBufferSource();
      node.buffer = buffer;
      node.connect(microphone);
      nextAt = Math.max(nextAt, output.currentTime + 0.02);
      queuedFrames += channel.length;
      const endFrame = queuedFrames;
      node.onended = () => {
        nodes.delete(node);
        playedFrames = Math.max(playedFrames, endFrame);
        processMarks();
      };
      nodes.add(node);
      node.start(nextAt);
      nextAt += buffer.duration;
    },
    mark: (name) => {
      marks.push({ name, frame: queuedFrames });
      processMarks();
    },
    clear: () => {
      marks.length = 0;
      for (const node of nodes) {
        node.onended = null;
        node.stop();
        node.disconnect();
      }
      nodes.clear();
      nextAt = 0;
      queuedFrames = 0;
      playedFrames = 0;
      avatarGain.gain.value = 0;
      speaking = false;
      seenSpeech = false;
    },
    attachAvatar: async (stream) => {
      await ready;
      if (!stream.getAudioTracks().length || !stream.getVideoTracks().length)
        throw new Error("Avatar requires audio and video tracks.");
      avatarVideo.srcObject = stream;
      await avatarVideo.play();
      const source = output.createMediaStreamSource(stream);
      source.connect(avatarGain);
      source.connect(analyser);
      avatar = true;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Avatar video did not produce a frame.")),
          15000,
        );
        avatarVideo.requestVideoFrameCallback(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    speaking: (active) => {
      if (active) {
        seenSpeech = false;
        quietSince = performance.now();
      }
      speaking = active;
      avatarGain.gain.value = active ? 1 : 0;
    },
    drainAvatar: async () => {
      if (!speaking) throw new Error("Avatar playback did not start.");
      const began = performance.now();
      while (performance.now() - began < 5000) {
        if (!speaking) return;
        if (
          seenSpeech &&
          performance.now() - began >= 300 &&
          performance.now() - quietSince >= 250
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error("Avatar playback could not be confirmed.");
    },
  };
  void ready.catch(() =>
    fatal("Could not initialize the meeting audio devices."),
  );
}
installMeetingMedia();