import type { CloudUploadPauseState } from "../../src/shared/types.js";

export class CloudUploadPauseGate {
  private state: CloudUploadPauseState = "running";
  private resumeWaiters: Array<() => void> = [];

  getState(): CloudUploadPauseState {
    return this.state;
  }

  requestPause(): CloudUploadPauseState {
    if (this.state === "running") {
      this.state = "pause_requested";
    }
    return this.state;
  }

  resume(): CloudUploadPauseState {
    this.state = "running";
    for (const resolve of this.resumeWaiters.splice(0)) {
      resolve();
    }
    return this.state;
  }

  isPauseRequested(): boolean {
    return this.state === "pause_requested" || this.state === "paused";
  }

  async waitUntilResumed(): Promise<void> {
    if (!this.isPauseRequested()) return;
    this.state = "paused";
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }
}
