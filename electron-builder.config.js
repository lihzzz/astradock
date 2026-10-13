const path = require("path");
const fs = require("fs");
const { createHash } = require("crypto");
const { finished } = require("node:stream/promises");
const { rebuildNativeModules } = require("./scripts/rebuild-native.cjs");
const { checkNativeDependencies } = require("./scripts/check-native-dependencies.cjs");

// Keep includes and exclusions in ONE matcher per platform. Builder 26
// normalizes global `files` into FileSets but leaves platform strings separate;
// a negative-only platform matcher then includes the whole project root.
// Mutable logs/test outputs must never enter the original ASAR stream.
const APP_FILES = [
  "package.json",
  "dist/**/*",
  "electron/dist/**/*",
  "!**/{test,tests,__tests__,__mocks__,spec,specs}/**",
  "!**/*.d.ts",
  "!**/*.d.cts",
  "!**/*.d.mts",
  "!**/*.map",
];

// Preserve native unpacking and verify archive bytes before repacking. The
// allowlist remains a final guard; platform files rules exclude source inputs.
const KEEP_ENTRIES = new Set([
  "package.json",
  "index.html",
  "dist",         // Vite-bundled renderer output
  "electron",     // tsup-compiled main/preload (electron/dist/)
  "node_modules", // production dependencies (already filtered by electron-builder)
]);

async function afterPackHook(context) {
  const resourcesDir = ["darwin", "mas"].includes(context.electronPlatformName)
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");

  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) return;

  // Direct dev dependency: pnpm does not expose transitive packages at this root.
  const asar = require("@electron/asar");
  asar.uncache(asarPath);
  // Fail before repacking if source files changed while the builder streamed them.
  // Otherwise extraction would preserve damaged bytes and compute fresh hashes for them.
  for (const file of ["package.json", "electron/dist/main.js", "electron/dist/history-worker.js", "dist/index.html"]) {
    const archiveFile = path.normalize(file);
    const expected = asar.statFile(asarPath, archiveFile).integrity?.hash;
    const actual = createHash("sha256").update(asar.extractFile(asarPath, archiveFile)).digest("hex");
    if (!expected || actual !== expected) throw new Error(`ASAR integrity mismatch: ${file}. Keep build inputs unchanged while packaging.`);
  }
  const unpackedDirectories = new Set();
  const unpackedFiles = new Set(["*.node", "*.dylib", "*.so", "*.dll"]);
  for (const entry of asar.listPackage(asarPath)) {
    const relative = entry.replace(/^[/\\]/, "");
    if (!asar.statFile(asarPath, relative).unpacked) continue;
    const parts = relative.split(/[/\\]/);
    const modules = parts.lastIndexOf("node_modules");
    if (modules >= 0 && parts[modules + 1]) {
      const end = modules + (parts[modules + 1].startsWith("@") ? 3 : 2);
      // ASAR lookups use native separators, while minimatch patterns use '/'.
      unpackedDirectories.add(parts.slice(0, end).join("/"));
    } else unpackedFiles.add(path.basename(relative));
  }
  const tmpDir = path.join(resourcesDir, "_asar_tmp");

  console.log("  \u2022 afterPack: extracting asar to strip bloat...");
  asar.extractAll(asarPath, tmpDir);

  // Remove everything not in the whitelist
  const entries = fs.readdirSync(tmpDir);
  for (const entry of entries) {
    if (!KEEP_ENTRIES.has(entry)) {
      fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
    }
  }

  // Inside electron/, keep only dist/ (compiled JS), remove src/ and other dev files
  const electronDir = path.join(tmpDir, "electron");
  if (fs.existsSync(electronDir)) {
    for (const sub of fs.readdirSync(electronDir)) {
      if (sub !== "dist") {
        fs.rmSync(path.join(electronDir, sub), { recursive: true, force: true });
      }
    }
  }

  console.log("  \u2022 afterPack: repacking asar...");
  fs.rmSync(asarPath, { force: true });
  // Preserve native runtime locations (including ONNX) when rebuilding the archive.
  const directories = [...unpackedDirectories];
  const stream = await asar.createPackageWithOptions(tmpDir, asarPath, {
    unpack: `{${[...unpackedFiles].join(",")}}`,
    ...(directories.length ? { unpackDir: directories.length === 1 ? directories[0] : `{${directories.join(",")}}` } : {}),
  });
  await finished(stream);
  asar.uncache(asarPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Log final size for visibility
  const finalSize = fs.statSync(asarPath).size;
  const mb = (finalSize / 1024 / 1024).toFixed(1);
  console.log(`  \u2022 afterPack: asar cleaned \u2014 ${mb} MB`);
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.harnss.app",
  productName: "AstraDock",

  directories: {
    output: "release/${version}",
    buildResources: "build",
  },

  // --- ASAR packing ---
  asar: true,
  extraResources: [{ from: "build/icon.png", to: "astradock-tray.png" }],
  asarUnpack: [
    "node_modules/onnxruntime-node/**",
    "node_modules/node-pty/**",
    "node_modules/electron-liquid-glass/**",
    "node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/*.wasm",
    "node_modules/@anthropic-ai/claude-agent-sdk/vendor/**",
    "node_modules/@anthropic-ai/claude-agent-sdk/manifest*.json",
    "node_modules/@trycua/cua-driver/**",
    "node_modules/@trycua/cua-driver-*/**",
    "node_modules/@ubjs/**",
    "node_modules/@img/**",
    "electron/dist/computer-use-mcp.js",
  ],

  // Reuse installation's platform-aware rebuild policy during packaging.
  // beforeBuild returning false would also disable normal dependency collection.
  npmRebuild: false,
  beforePack: async (context) => {
    await rebuildNativeModules({
      buildPath: context.packager.info.appDir,
      electronVersion: context.packager.info.framework.version,
      platform: context.packager.platform.nodeName,
      arch: require("electron-builder").Arch[context.arch],
      buildFromSource: context.packager.config.buildDependenciesFromSource === true,
    });
    checkNativeDependencies({
      buildPath: context.packager.info.appDir,
      platform: context.packager.platform.nodeName,
      arch: require("electron-builder").Arch[context.arch],
    });
  },
  nodeGypRebuild: false,
  includePdb: false,

  afterPack: async (context) => {
    await afterPackHook(context);
    const resources = ["darwin", "mas"].includes(context.electronPlatformName)
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
    checkNativeDependencies({
      archive: path.join(resources, "app.asar"),
      platform: context.packager.platform.nodeName,
      arch: require("electron-builder").Arch[context.arch],
    });
  },

  // --- macOS ---
  mac: {
    target: ["dmg", "zip"],
    files: [...APP_FILES],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    extendInfo: {
      NSMicrophoneUsageDescription: "AstraDock uses the microphone for voice dictation to transcribe speech into text.",
    },
  },

  dmg: {
    icon: "build/icon.icns",
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
    window: { width: 540, height: 380 },
  },

  // --- Windows ---
  win: {
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    icon: "build/icon.ico",
    files: [
      ...APP_FILES,
      "!node_modules/electron-liquid-glass/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-darwin/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-darwin/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-linux/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-linux/**",
      "!node_modules/node-pty/prebuilds/darwin-*/**",
      "!node_modules/node-pty/prebuilds/linux-*/**",
    ],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    // Include arch in filename so x64 and arm64 installers don't collide
    artifactName: "${productName}-Setup-${version}-${arch}.${ext}",
  },

  // --- Linux ---
  linux: {
    target: [
      { target: "AppImage" },
      { target: "deb" },
    ],
    category: "Development",
    icon: "build/icon.png",
    files: [
      ...APP_FILES,
      "!node_modules/electron-liquid-glass/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-darwin/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-darwin/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-win32/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-win32/**",
      "!node_modules/node-pty/prebuilds/darwin-*/**",
      "!node_modules/node-pty/prebuilds/win32-*/**",
    ],
  },

  deb: {
    depends: ["libnotify4", "libsecret-1-0"],
  },

};
