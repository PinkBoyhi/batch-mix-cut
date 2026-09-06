import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function assertOutputAvailable(filePath: string): Promise<void> {
  const exists = await fs.lstat(filePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (exists) throw outputConflict(filePath);
}

// Publish a completed file without replacing another task's output.
export async function publishOutput(temporaryPath: string, filePath: string): Promise<void> {
  try {
    try {
      await fs.link(temporaryPath, filePath);
    } catch (error) {
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Removable drives may not support hard links; exclusive copy still protects old files.
      await fs.copyFile(temporaryPath, filePath, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw outputConflict(filePath);
    throw error;
  }
}

function outputConflict(filePath: string): Error {
  return new Error(`成片已存在，不会覆盖：${path.basename(filePath)}。请更换输出目录或成片名称后重新开始。`);
}
