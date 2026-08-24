import type { CloudImportJob, CloudVideoLabel } from "./types.js";

export function flattenSelectableCloudLabels(labels: CloudVideoLabel[]): CloudVideoLabel[] {
  return labels.flatMap((label) => {
    const children = label.children ? flattenSelectableCloudLabels(label.children) : [];
    return label.level === 2 ? [label, ...children] : children;
  });
}

export function parseCloudLabelIds(labelIds: string): string[] {
  return Array.from(
    new Set(
      labelIds
        .split(",")
        .map((labelId) => labelId.trim())
        .filter(Boolean)
    )
  );
}

export function reconcileCloudLabelIds(labelIds: string, labels: CloudVideoLabel[]): { validLabelIds: string[]; invalidLabelIds: string[] } {
  const allowedIds = new Set(flattenSelectableCloudLabels(labels).map((label) => String(label.id)));
  const selectedIds = parseCloudLabelIds(labelIds);
  return {
    validLabelIds: selectedIds.filter((labelId) => allowedIds.has(labelId)),
    invalidLabelIds: selectedIds.filter((labelId) => !allowedIds.has(labelId))
  };
}

export function findRejectedCloudLabelIds(errorList: CloudImportJob["errorList"]): string[] {
  const ids = new Set<string>();
  for (const item of errorList) {
    for (const error of item.errors ?? []) {
      for (const match of error.message.matchAll(/标签ID[（(]([^）)]+)[）)]\s*不存在/g)) {
        ids.add(match[1].trim());
      }
    }
  }
  return Array.from(ids);
}
