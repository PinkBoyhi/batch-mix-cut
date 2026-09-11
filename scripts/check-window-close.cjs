const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const electronBinary = require("electron");

const root = path.resolve(__dirname, "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "batchmix-window-close-"));

(async () => {
  const child = spawn(electronBinary, [path.join(root, "dist-electron/electron/main.js"), `--user-data-dir=${userDataDir}`], {
    cwd: root,
    env: { ...process.env, BATCH_MIX_WINDOW_CLOSE_SMOKE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("主窗口关闭回归超时"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  if (exitCode !== 0 || !stdout.includes("主窗口关闭回归通过")) {
    throw new Error(`主窗口关闭回归失败（退出码 ${exitCode}）\n${stderr || stdout}`);
  }
  process.stdout.write(stdout);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
