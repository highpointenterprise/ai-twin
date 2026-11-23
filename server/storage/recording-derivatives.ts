import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { env } from "../../lib/env";
import type { MongoCallRepository } from "./calls";
import type { ObjectStore } from "./objects";

const run = promisify(execFile);
const FILTER =
  "[0:a]pan=mono|c0=0.5*c0+0.5*c1[mix];[0:a]pan=mono|c0=c0[left];[0:a]pan=mono|c0=c1[right]";

export async function deriveRecordings(
  sid: string,
  source: Readable,
  objects: ObjectStore,
  calls: MongoCallRepository,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "recording-"));
  try {
    const input = join(directory, "stereo.wav");
    await pipeline(source, createWriteStream(input, { mode: 0o600 }));
    const probe = await run(
      env.FFPROBE_PATH,
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=channels,duration",
        "-of",
        "json",
        input,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const stream = JSON.parse(probe.stdout).streams?.[0];
    if (stream?.channels !== 2 || !(Number(stream.duration) > 0))
      throw new Error(
        "A dual-channel source is required to separate assistant and customer audio.",
      );
    const outputs = {
      stereo: join(directory, "normalized.wav"),
      monoRecording: join(directory, "mono.wav"),
      left: join(directory, "left.wav"),
      right: join(directory, "right.wav"),
    };
    await run(
      env.FFMPEG_PATH,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-filter_complex",
        FILTER,
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s16le",
        outputs.stereo,
        "-map",
        "[mix]",
        "-c:a",
        "pcm_s16le",
        outputs.monoRecording,
        "-map",
        "[left]",
        "-c:a",
        "pcm_s16le",
        outputs.left,
        "-map",
        "[right]",
        "-c:a",
        "pcm_s16le",
        outputs.right,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    const customerFile =
      env.RECORDING_CUSTOMER_CHANNEL === 0 ? outputs.left : outputs.right;
    const assistantFile =
      env.RECORDING_CUSTOMER_CHANNEL === 0 ? outputs.right : outputs.left;
    const prefix = `calls/${sid}/recordings`;
    const upload = async (name: string, file: string) =>
      objects.putStream(
        `${prefix}/${name}.wav`,
        createReadStream(file),
        "audio/wav",
      );
    await calls.setArtifact(
      sid,
      "recording",
      await upload("stereo", outputs.stereo),
    );
    await calls.setArtifact(
      sid,
      "monoRecording",
      await upload("mono", outputs.monoRecording),
    );
    await calls.setArtifact(
      sid,
      "customerRecording",
      await upload("customer", customerFile),
    );
    await calls.setArtifact(
      sid,
      "assistantRecording",
      await upload("assistant", assistantFile),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
