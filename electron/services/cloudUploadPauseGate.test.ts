import { describe, expect, it } from "vitest";
import { CloudUploadPauseGate } from "./cloudUploadPauseGate.js";

describe("CloudUploadPauseGate", () => {
  it("pauses at a safe checkpoint and resumes the same upload", async () => {
    const gate = new CloudUploadPauseGate();

    expect(gate.requestPause()).toBe("pause_requested");
    const waiting = gate.waitUntilResumed();
    expect(gate.getState()).toBe("paused");

    expect(gate.resume()).toBe("running");
    await waiting;
    expect(gate.getState()).toBe("running");
  });

  it("does not block when no pause was requested", async () => {
    const gate = new CloudUploadPauseGate();
    await expect(gate.waitUntilResumed()).resolves.toBeUndefined();
    expect(gate.getState()).toBe("running");
  });
});
