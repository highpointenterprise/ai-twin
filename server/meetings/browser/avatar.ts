import { Room, RoomEvent, Track } from "livekit-client";
import type { MeetingMediaBridge } from "./media";
declare global {
  interface Window {
    __aiTwinAvatar: {
      connect: (url: string, token: string) => Promise<void>;
      close: () => Promise<void>;
    };
  }
}
// This bundle belongs only in the avatar child frame. Its peer connections are
// not captured as customer speech, preventing the agent from hearing itself.
let room: Room | undefined;
window.__aiTwinAvatar = {
  connect: async (url, token) => {
    const parentMedia = (
      window.parent as Window & { __aiTwinMedia: MeetingMediaBridge }
    ).__aiTwinMedia;
    const receiver = new Room({ adaptiveStream: false, dynacast: false });
    room = receiver;
    const stream = new MediaStream();
    let attaching = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Avatar audio/video tracks did not arrive.")),
        30000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Avatar media disconnected."));
      };
      receiver.on(RoomEvent.Disconnected, () => {
        if (attaching)
          void (window.parent as Window).__aiTwinMediaError(
            "Avatar media disconnected.",
          );
        fail();
      });
      receiver.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio)
          return;
        stream.addTrack(track.mediaStreamTrack);
        if (
          !attaching &&
          stream.getAudioTracks().length &&
          stream.getVideoTracks().length
        ) {
          attaching = true;
          void parentMedia.attachAvatar(stream).then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            },
          );
        }
      });
      void receiver.connect(url, token).catch(fail);
    });
  },
  close: async () => {
    await room?.disconnect();
    room = undefined;
  },
};
