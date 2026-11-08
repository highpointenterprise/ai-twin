import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { env } from "../../lib/env";
import {
  meetingInputSchema,
  type MeetingRecord,
  type MeetingReadiness,
  type MeetingPhase,
} from "../../lib/meetings";
import type {
  ConversationSession,
  EngineDeps,
  SessionFactory,
} from "../core/ports";
import type { AgentStore } from "../store/agents";
import type { ToolRegistry } from "../tools/registry";
import { HttpError } from "../core/errors";
import { StandardSession } from "../engine/standard-session";
import { TraceStore } from "../observability/trace";
import type {
  MeetingDriver,
  MeetingDriverFactory,
  AvatarFactory,
  AvatarSession,
} from "./ports";
import { MeetingOutput } from "./output";
import { MeetingStore, terminalMeeting } from "./store";
import { chromiumAvailable, MeetingLoginRequired } from "./browser-driver";
interface ActiveMeeting {
  controller: AbortController;
  driver: MeetingDriver;
  output: MeetingOutput;
  session?: ConversationSession;
  avatar?: AvatarSession;
  timer?: NodeJS.Timeout;
  joinTimer?: NodeJS.Timeout;
  stopPromise?: Promise<void>;
}
export class MeetingService {
  private readonly active = new Map<string, ActiveMeeting>();
  private closed = false;
  constructor(
    private readonly deps: {
      store: MeetingStore;
      agents: AgentStore;
      tools: ToolRegistry;
      engine: EngineDeps;
      drivers: MeetingDriverFactory;
      avatars: AvatarFactory;
      traces: TraceStore;
      browserReady?: () => boolean;
      sessionFactory?: SessionFactory;
    },
  ) {}
  readiness(): MeetingReadiness {
    const missing: string[] = [];
    for (const name of [
      "DEEPGRAM_API_KEY",
      "OPENAI_API_KEY",
      "ELEVENLABS_API_KEY",
    ] as const)
      if (!env[name]) missing.push(name);
    if (!(this.deps.browserReady ?? chromiumAvailable)())
      missing.push(
        "Chromium (install Playwright Chromium or set CHROMIUM_EXECUTABLE_PATH)",
      );
    if (
      env.MEET_GOOGLE_STORAGE_STATE_PATH &&
      !existsSync(env.MEET_GOOGLE_STORAGE_STATE_PATH)
    )
      missing.push("MEET_GOOGLE_STORAGE_STATE_PATH (file not found)");
    return {
      missing,
      avatarMissing: env.LIVEAVATAR_API_KEY ? [] : ["LIVEAVATAR_API_KEY"],
      defaultAvatarId: env.LIVEAVATAR_AVATAR_ID,
      maxConcurrentMeetings: env.MAX_CONCURRENT_MEETINGS,
    };
  }
  list(): MeetingRecord[] {
    return this.deps.store.list();
  }
  get(id: string): MeetingRecord {
    return this.deps.store.get(id);
  }
  trace(id: string) {
    this.get(id);
    const trace = this.deps.traces.get(id);
    if (!trace)
      throw new HttpError(
        404,
        "No trace is available after this backend restart.",
      );
    return trace.view();
  }
  join(value: unknown): MeetingRecord {
    if (this.closed)
      throw new HttpError(503, "Meeting workers are shutting down.");
    const input = meetingInputSchema.parse(value),
      agent = structuredClone(this.deps.agents.get(input.agentId));
    const tools = structuredClone(
      this.deps.tools.resolve(agent.toolIds),
    ).filter((t) => t.type === "function");
    const readiness = this.readiness(),
      missing = [...readiness.missing];
    const avatarId = input.avatarId || env.LIVEAVATAR_AVATAR_ID;
    if (!agent.voiceId) missing.push("Assistant ElevenLabs voice ID");
    if (input.avatarEnabled) {
      missing.push(...readiness.avatarMissing);
      if (!avatarId) missing.push("HeyGen LiveAvatar ID");
    }
    if (missing.length)
      throw new HttpError(
        503,
        `Meeting is not configured: ${missing.join(", ")}`,
      );
    if (this.active.size >= env.MAX_CONCURRENT_MEETINGS)
      throw new HttpError(503, "Concurrent meeting limit reached.");
    if (
      this.list().some(
        (r) => !terminalMeeting(r.phase) && r.meetingUrl === input.meetingUrl,
      )
    )
      throw new HttpError(
        409,
        "An agent is already joining or attending this meeting.",
      );
    const now = Date.now(),
      id = randomUUID();
    const record: MeetingRecord = {
      ...input,
      avatarId,
      displayName: input.displayName ?? `${agent.name} (AI assistant)`,
      id,
      phase: "joining",
      createdAt: now,
      updatedAt: now,
    };
    const controller = new AbortController(),
      driver = this.deps.drivers();
    const output = new MeetingOutput(
      driver,
      (name) => this.active.get(id)?.session?.handleMark(name),
      (error) => {
        void this.stop(id, error.message, "failed");
      },
    );
    const active: ActiveMeeting = { controller, driver, output };
    this.active.set(id, active);
    this.deps.store.create(record);
    const trace = this.deps.traces.for(id);
    trace.log("meeting.joining", { avatar: input.avatarEnabled });
    active.joinTimer = setTimeout(() => {
      void this.stop(id, "Meeting admission timed out.", "failed");
    }, input.joinTimeoutSeconds * 1000);
    void (async () => {
      await driver.join(
        record,
        {
          onWaiting: () => this.phase(id, "waiting"),
          onAudio: (audio) => {
            if (this.get(id).phase === "active")
              active.session?.pushAudio(audio);
          },
          onMark: (name) => active.session?.handleMark(name),
          onEnded: (reason) => {
            void this.stop(id, reason);
          },
          onError: (error) => {
            void this.stop(id, error.message, "failed");
          },
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      clearTimeout(active.joinTimer);
      // Provider sessions begin only after admission, keeping waiting-room time
      // separate from speech processing and avatar usage.
      if (record.avatarEnabled) {
        this.phase(id, "starting-avatar");
        const avatar = await this.deps.avatars(
          record.avatarId,
          output.events,
          controller.signal,
        );
        if (controller.signal.aborted) {
          await avatar.stop();
          return;
        }
        active.avatar = avatar;
        output.setAvatar(avatar);
        await driver.attachAvatar(avatar.room, controller.signal);
      }
      controller.signal.throwIfAborted();
      const duration = Math.min(
        agent.maxDurationSeconds,
        input.maxDurationSeconds,
      );
      active.timer = setTimeout(() => {
        void this.stop(id, "Maximum meeting duration reached.");
      }, duration * 1000);
      const init = {
        agent: { ...agent, silenceTimeoutSeconds: input.idleTimeoutSeconds },
        tools,
        callSid: id,
        streamSid: id,
        purpose: "meeting" as const,
        direction: "inbound" as const,
        brief: `You are participating in a Google Meet meeting as ${record.displayName}. Help the customers in real time. Keep spoken responses concise, listen when people interrupt, and do not claim to see screen shares or people: only meeting audio is provided.\n${input.context}`,
        deadline: Date.now() + duration * 1000,
        inputAudioFormat: {
          encoding: "pcm_s16le" as const,
          sampleRate: 16000 as const,
        },
        outputAudioFormat: {
          encoding: "pcm_s16le" as const,
          sampleRate: 24000 as const,
        },
        audioOutput: output,
        send: () => {},
        trace,
      };
      const engine: EngineDeps = {
        ...this.deps.engine,
        onScreening: undefined,
        endCall: async (_id, reason) => {
          await this.stop(
            id,
            reason,
            reason.includes("error") ? "failed" : "ended",
          );
        },
      };
      active.session = this.deps.sessionFactory
        ? this.deps.sessionFactory(init)
        : new StandardSession(init, engine);
      this.phase(id, "active");
    })().catch((error) => {
      if (!controller.signal.aborted)
        void this.stop(
          id,
          error instanceof Error ? error.message : "Meeting setup failed.",
          error instanceof MeetingLoginRequired ? "needs-login" : "failed",
        );
    });
    return record;
  }
  async stop(
    id: string,
    reason = "Agent left the meeting.",
    phase: MeetingPhase = "ended",
  ): Promise<void> {
    this.get(id);
    const active = this.active.get(id);
    if (!active) return;
    if (active.stopPromise) return active.stopPromise;
    this.phase(id, "leaving");
    // Set stopPromise before cancellation can synchronously trigger callbacks.
    active.stopPromise = Promise.resolve().then(async () => {
      clearTimeout(active.timer);
      clearTimeout(active.joinTimer);
      active.controller.abort();
      const results = await Promise.allSettled(
        [
          () => active.output.close(),
          () => active.session?.close(),
          () => active.driver.close(),
          () => active.avatar?.stop(),
        ].map((cleanup) => Promise.resolve().then(cleanup)),
      );
      const cleanupFailed = results.some((r) => r.status === "rejected");
      this.deps.store.update(
        id,
        cleanupFailed ? "failed" : phase,
        cleanupFailed
          ? `${reason} Media cleanup failed; the provider may take time to expire the session.`
          : reason,
      );
      this.deps.traces.for(id).log("meeting.ended", { reason, cleanupFailed });
      this.deps.traces.for(id).finish();
      this.active.delete(id);
    });
    return active.stopPromise;
  }
  private phase(id: string, phase: MeetingPhase): void {
    const current = this.get(id).phase;
    if (terminalMeeting(current) || current === "leaving") return;
    this.deps.store.update(id, phase);
    this.deps.traces.for(id).log(`meeting.${phase}`);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.active.keys()].map((id) =>
        this.stop(id, "Server shutting down."),
      ),
    );
  }
}
