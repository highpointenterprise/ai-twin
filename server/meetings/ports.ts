import type { MeetingRecord } from "../../lib/meetings";
import type { AudioOutputPort } from "../core/ports";

export interface AvatarRoom {
  url: string;
  token: string;
}
export interface MeetingDriverEvents {
  onWaiting: () => void;
  onAudio: (pcm16kBase64: string) => void;
  onMark: (name: string) => void;
  onEnded: (reason: string) => void;
  onError: (error: Error) => void;
}
export interface MeetingDriver {
  join: (
    meeting: MeetingRecord,
    events: MeetingDriverEvents,
    signal: AbortSignal,
  ) => Promise<void>;
  output: AudioOutputPort;
  attachAvatar: (room: AvatarRoom, signal: AbortSignal) => Promise<void>;
  avatarSpeaking: (speaking: boolean) => void;
  drainAvatar: () => Promise<void>;
  close: () => Promise<void>;
}
export type MeetingDriverFactory = () => MeetingDriver;
export interface AvatarEvents {
  onStarted: (eventId: string) => void;
  onEnded: (eventId: string) => void;
  onError: (error: Error) => void;
}
export interface AvatarSession {
  room: AvatarRoom;
  pushAudio: (pcm24kBase64: string, eventId: string) => void;
  finish: (eventId: string) => void;
  interrupt: () => void;
  stop: () => Promise<void>;
}
export type AvatarFactory = (
  avatarId: string,
  events: AvatarEvents,
  signal: AbortSignal,
) => Promise<AvatarSession>;
