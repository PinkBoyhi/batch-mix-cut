import type { MixProjectConfig } from "../../src/shared/types.js";

const GENERIC_NAMES = new Set(["output", "outputs", "成品", "混剪", "mix", "mixed"]);

export function resolveWorkflowTitle(config: MixProjectConfig): string {
  const explicitTitle = cleanTitle(config.workflowTitle);
  if (explicitTitle) return explicitTitle;

  const projectName = fileName(config.projectDir);
  if (projectName && !isGenericName(projectName) && !/^desktop-\d+-[a-f0-9]+$/i.test(projectName)) {
    return projectName;
  }

  const outputName = cleanTitle(config.outputNamePattern);
  if (outputName) return outputName;

  const outputFolder = fileName(config.outputDir);
  if (outputFolder && !isGenericName(outputFolder)) return outputFolder;
  return "未命名混剪任务";
}

function fileName(value: string | undefined): string {
  return cleanTitle(value?.split(/[\\/]/).filter(Boolean).pop());
}

function cleanTitle(value: string | undefined): string {
  return String(value ?? "").trim().replace(/[\r\n\t]+/g, " ").slice(0, 160);
}

function isGenericName(value: string): boolean {
  return GENERIC_NAMES.has(value.toLowerCase());
}
