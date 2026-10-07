declare const NEN_BROWSER_VERSION: string;
import { Together, browserSourceHash } from "../app/electron/together";
import type { Playback, TogetherState } from "../app/src/shared";
export function browserRoom(
  playback: () => Playback,
  prepare: (id: number, episode: number) => Promise<void>,
  getVideo: () => HTMLVideoElement | undefined,
) {
  const listeners = new Set<(s: TogetherState) => void>();
  const room = new Together({
    version: NEN_BROWSER_VERSION,
    url:
      (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      "/nen-session",
    sourceHash: browserSourceHash,
    changed: (s) => listeners.forEach((fn) => fn(structuredClone(s))),
    playback,
    prepare,
    command: async (command) => {
      const video = getVideo();
      if (!video) return;
      if (command[0] === "seek") video.currentTime = Number(command[1]);
      if (command[1] === "speed") video.playbackRate = Number(command[2]);
      if (command[1] === "pause") {
        if (command[2]) video.pause();
        else
          try {
            await video.play();
          } catch {
            video.muted = true;
            await video.play();
          }
      }
    },
  });
  return {
    room,
    api: {
      togetherState: async () => structuredClone(room.state),
      togetherConnect: async (code?: string) => {
        if (code !== undefined && !/^[A-Za-z0-9_-]{24}$/.test(code))
          throw Error("Invalid session code.");
        await room.connect(code);
      },
      togetherCopyCode: async () => {
        if (room.state.code)
          await navigator.clipboard.writeText(room.state.code);
      },
      togetherSend: async (message: object) => {
        room.send(message);
      },
      togetherReload: async () => room.reload(),
      onTogether: (fn: (s: TogetherState) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
}
