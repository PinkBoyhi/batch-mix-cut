import { describe, expect, it } from "vitest";
import { isDecodableAudioStream } from "./mediaProbe.js";

describe("isDecodableAudioStream", () => {
  it("accepts ISO-BMFF PCM even when an older probe cannot name its codec", () => {
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "none", codec_tag_string: "ipcm" })).toBe(true);
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "pcm_s16le", codec_tag_string: "ipcm" })).toBe(true);
  });

  it("accepts regular decoded audio streams", () => {
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "aac", codec_tag_string: "mp4a" })).toBe(true);
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "mp3" })).toBe(true);
    expect(isDecodableAudioStream({ codec_type: "audio", codec_name: "pcm_s16be", codec_tag_string: "twos" })).toBe(true);
  });
});
