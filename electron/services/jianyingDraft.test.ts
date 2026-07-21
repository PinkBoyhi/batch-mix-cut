import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJianyingDraft } from "./jianyingDraft.js";

describe("parseJianyingDraft", () => {
  it("reads main video slots from draft_content tracks and materials", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jianying-draft-"));
    await fs.writeFile(
      path.join(dir, "draft_content.json"),
      JSON.stringify({
        materials: {
          videos: [
            { id: "mat_b", material_name: "模板B.mov", path: "/template/B.mov" },
            { id: "mat_a", material_name: "模板A.mp4", path: "/template/A.mp4" }
          ],
          audios: [{ id: "music", path: "/template/music.mp3" }]
        },
        tracks: [
          {
            id: "audio-track",
            type: "audio",
            segments: [{ id: "audio-seg", material_id: "music", target_timerange: { start: 0, duration: 9_000_000 } }]
          },
          {
            id: "main-video",
            type: "video",
            segments: [
              { id: "seg_b", material_id: "mat_b", target_timerange: { start: 3_000_000, duration: 2_000_000 } },
              { id: "seg_a", material_id: "mat_a", target_timerange: { start: 0, duration: 3_000_000 } }
            ]
          }
        ]
      })
    );

    const mapping = await parseJianyingDraft(dir);

    expect(mapping.slots.map((slot) => slot.slotName)).toEqual(["A", "B"]);
    expect(mapping.slots.map((slot) => slot.materialId)).toEqual(["mat_a", "mat_b"]);
    expect(mapping.slots.map((slot) => slot.sourceName)).toEqual(["模板A.mp4", "模板B.mov"]);
    expect(mapping.slots.map((slot) => slot.targetDurationUs)).toEqual([3_000_000, 2_000_000]);
  });
});
