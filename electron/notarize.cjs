const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);

exports.default = async function notarize(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const requiredEnvironment = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID"
  ];
  const missing = requiredEnvironment.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.warn(`Skipping macOS notarization because ${missing.join(", ")} is not configured.`);
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const archivePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}-notarization.zip`);
  const credentials = [
    "--apple-id",
    process.env.APPLE_ID,
    "--password",
    process.env.APPLE_APP_SPECIFIC_PASSWORD,
    "--team-id",
    process.env.APPLE_TEAM_ID
  ];

  await execFileAsync("ditto", ["-c", "-k", "--keepParent", appPath, archivePath]);
  await execFileAsync("xcrun", ["notarytool", "submit", archivePath, ...credentials, "--wait"], { maxBuffer: 10 * 1024 * 1024 });
  await execFileAsync("xcrun", ["stapler", "staple", appPath], { maxBuffer: 10 * 1024 * 1024 });
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { maxBuffer: 10 * 1024 * 1024 });
};
