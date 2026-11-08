import { randomUUID } from "node:crypto";
import type { AudioOutputPort } from "../core/ports";
import type { AvatarEvents, AvatarSession, MeetingDriver } from "./ports";
export class MeetingOutput implements AudioOutputPort {
  private current = "";
  private marks = new Map<string, string>();
  private live = new Set<string>();
  private closed = false;
  constructor(
    private readonly driver: MeetingDriver,
    private readonly onMark: (name: string) => void,
    private readonly onError: (error: Error) => void,
    private avatar?: AvatarSession,
  ) {}
  setAvatar(avatar: AvatarSession): void {
    this.avatar = avatar;
  }
  events: AvatarEvents = {
    onStarted: (id) => {
      if (!this.closed && this.live.has(id)) this.driver.avatarSpeaking(true);
    },
    onEnded: (id) => {
      if (this.closed || !this.live.has(id)) return;
      const mark = this.marks.get(id);
      if (!mark) return;
      void this.driver
        .drainAvatar()
        .then(() => {
          if (this.closed || !this.live.has(id)) return;
          this.live.delete(id);
          this.marks.delete(id);
          this.driver.avatarSpeaking(false);
          this.onMark(mark);
        })
        .catch(() => {
          if (!this.closed && this.live.has(id))
            this.onError(new Error("Avatar playback could not be confirmed."));
        });
    },
    onError: (error) => {
      if (!this.closed) this.onError(error);
    },
  };
  audio = (audio: string): void => {
    if (this.closed) return;
    if (!this.avatar) {
      this.driver.output.audio(audio);
      return;
    }
    if (!this.current) {
      this.current = randomUUID();
      this.live.add(this.current);
    }
    this.avatar.pushAudio(audio, this.current);
  };
  mark = (name: string): void => {
    if (this.closed) return;
    if (!this.avatar) {
      this.driver.output.mark(name);
      return;
    }
    if (!this.current) throw new Error("No avatar audio is awaiting playback.");
    this.marks.set(this.current, name);
    this.avatar.finish(this.current);
    this.current = "";
  };
  clear = (): void => {
    this.current = "";
    this.live.clear();
    this.marks.clear();
    this.driver.output.clear();
    try {
      this.avatar?.interrupt();
    } catch {
      if (!this.closed)
        this.onError(new Error("Could not interrupt avatar playback."));
    }
  };
  close(): void {
    this.closed = true;
    this.current = "";
    this.live.clear();
    this.marks.clear();
    this.driver.output.clear();
  }
}
