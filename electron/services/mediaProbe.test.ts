import { describe, expect, it } from "vitest";
import { isDecodableAudioStream } from "./mediaProbe.js";

describe("isDecodableAudioStream", () => {
  it("rejects ipcm streams that ffmpeg cannot decode", () => {
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "none", codec_tag_string: "ipcm" })).toBe(false);
  });

  it("accepts regular decoded audio streams", () => {
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "aac", codec_tag_string: "mp4a" })).toBe(true);
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "mp3" })).toBe(true);
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "pcm_s16be", codec_tag_string: "twos" })).toBe(true);
  });
});
