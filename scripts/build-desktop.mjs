import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Build the Windows desktop ZIP on Windows.");
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const overlayManifest = path.join(root, "overlay", "package.json");
const requireElectron = createRequire(overlayManifest);
const expected = requireElectron(overlayManifest).devDependencies.electron;
if (requireElectron("electron/package.json").version !== expected) {
  throw new Error("Run npm ci --prefix overlay to install the pinned Electron runtime.");
}
const executable = requireElectron("electron");
const electron = path.dirname(executable);
await fs.mkdir(dist, { recursive: true });
const stage = await fs.mkdtemp(path.join(dist, "desktop-"));
const bundle = path.join(stage, "Cuelensa");
const app = path.join(bundle, "resources", "app");
const zip = path.join(dist, `cuelensa-${manifest.version}-windows-${process.arch}.zip`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

try {
  await fs.cp(electron, bundle, { recursive: true });
  await fs.rename(path.join(bundle, path.basename(executable)), path.join(bundle, "Cuelensa.exe"));
  await fs.mkdir(app, { recursive: true });
  // Use the checked-in application and a fresh dependency install. User data lives outside the bundle.
  for (const source of ["package-lock.json", "LICENSE", "server.js", "lib", "public", "overlay/package.json", "overlay/main.js", "overlay/preload.js", "overlay/workspace-preload.js", "overlay/offline.html"]) {
    await fs.cp(path.join(root, source), path.join(app, source), { recursive: true });
  }
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ ...manifest, main: "overlay/main.js", productName: "Cuelensa" }, null, 2));
  run(process.execPath, [process.env.npm_execpath, "ci", "--omit=dev", "--no-audit", "--no-fund"], app);
  await fs.copyFile(path.join(root, "docs", "desktop.md"), path.join(bundle, "Getting Started.md"));
  run("tar.exe", ["-a", "-c", "-f", zip, "-C", stage, "Cuelensa"], root);
  console.log(zip);
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
