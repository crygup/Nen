import Hls from "hls.js";

export function seekFrames() {
  let source = "";
  let video: HTMLVideoElement | undefined;
  let hls: Hls | undefined;
  let cancel: (() => void) | undefined;
  const cache = new Map<number, string>();
  return {
    reset(url = "") {
      cancel?.();
      hls?.destroy();
      hls = undefined;
      if (video) {
        video.removeAttribute("src");
        video.load();
        video = undefined;
      }
      source = url;
      cache.clear();
    },
    async get(position: number): Promise<string | null> {
      if (!source || !Number.isFinite(position) || position < 0) return null;
      const seconds = Math.floor(position / 5) * 5;
      if (cache.has(seconds)) return cache.get(seconds)!;
      cancel?.();
      const url = source;
      return new Promise((resolve) => {
        const fresh = !video;
        const reader = video ?? (video = document.createElement("video"));
        reader.crossOrigin = "anonymous";
        reader.muted = true;
        reader.preload = "auto";
        let finished = false;
        const done = (image: string | null = null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reader.onloadedmetadata =
            reader.onseeked =
            reader.onloadeddata =
            reader.onerror =
              null;
          if (cancel === stop) cancel = undefined;
          if (image && source === url) {
            cache.set(seconds, image);
            if (cache.size > 120) cache.delete(cache.keys().next().value!);
          }
          resolve(source === url ? image : null);
        };
        const stop = () => done();
        cancel = stop;
        const timer = setTimeout(stop, 15000);
        const capture = () => {
          if (
            reader.seeking ||
            reader.readyState < 2 ||
            Math.abs(reader.currentTime - seconds) > 1
          )
            return;
          try {
            const canvas = document.createElement("canvas");
            canvas.width = 192;
            canvas.height = Math.max(
              1,
              Math.round((192 * reader.videoHeight) / reader.videoWidth),
            );
            canvas
              .getContext("2d")!
              .drawImage(reader, 0, 0, canvas.width, canvas.height);
            done(canvas.toDataURL("image/jpeg", 0.7));
          } catch {
            stop();
          }
        };
        reader.onloadedmetadata = () => {
          reader.currentTime = seconds;
        };
        reader.onseeked = capture;
        reader.onloadeddata = capture;
        reader.onerror = stop;
        if (fresh) {
          if (Hls.isSupported()) {
            hls = new Hls({
              startPosition: seconds,
              maxBufferLength: 2,
              maxMaxBufferLength: 4,
              backBufferLength: 0,
            });
            hls.on(Hls.Events.ERROR, (_, data) => {
              if (data.fatal) cancel?.();
            });
            hls.loadSource(url);
            hls.attachMedia(reader);
          } else reader.src = url;
        } else if (reader.readyState >= 1) {
          reader.currentTime = seconds;
          capture();
        }
      });
    },
  };
}
