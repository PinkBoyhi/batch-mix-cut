import { describe, expect, it } from "vitest";
import { findRejectedCloudLabelIds, reconcileCloudLabelIds } from "../../src/shared/cloudLabels.js";

describe("cloud label validation", () => {
  const labels = [
    {
      id: 10,
      name: "脚本类型",
      level: 1,
      children: [
        { id: 11, name: "口播", level: 2 },
        { id: 12, name: "产品展示", level: 2 }
      ]
    }
  ];

  it("keeps only labels returned for the current category", () => {
    expect(reconcileCloudLabelIds("11,999,12", labels)).toEqual({ validLabelIds: ["11", "12"], invalidLabelIds: ["999"] });
  });

  it("extracts rejected label IDs from import feedback", () => {
    expect(
      findRejectedCloudLabelIds([
        { index: 0, errors: [{ field: "labelIds", message: "标签ID(579943)不存在" }] },
        { index: 1, errors: [{ field: "labelIds", message: "标签ID（579943）不存在" }] }
      ])
    ).toEqual(["579943"]);
  });
});
