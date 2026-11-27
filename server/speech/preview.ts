import type { AgentConfig } from "../../lib/types";
import type { SynthesizerFactory } from "../core/ports";

export async function previewVoice(synthesize: SynthesizerFactory, voiceId: string, voice: AgentConfig["voice"], text: string, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const synth = synthesize(voiceId, audio => {
    signal.throwIfAborted();
    const chunk = Buffer.from(audio, "base64");
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Voice preview exceeded the audio limit.");
    chunks.push(chunk);
  }, voice, { encoding: "pcm_s16le", sampleRate: 8000 });
  const cancel = () => synth.close();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await synth.push(text);
    await synth.end();
    signal.throwIfAborted();
    if (!bytes || bytes % 2) throw new Error("Voice preview returned invalid audio.");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + bytes, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(bytes, 40);
    return Buffer.concat([header, ...chunks]);
  } finally { signal.removeEventListener("abort", cancel); synth.close(); }
}
