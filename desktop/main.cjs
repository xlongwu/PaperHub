const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog } = require("electron");

const devUrl = process.env.PAPERHUB_UI_URL || "http://127.0.0.1:4173";
const apiUrl = process.env.PAPERHUB_API_URL || "http://127.0.0.1:3000";
const healthUrl = `${apiUrl.replace(/\/$/, "")}/health`;
const isDev = process.env.PAPERHUB_DESKTOP_DEV === "1";

let backendProcess = null;

async function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: "#eadcc8",
    title: "PaperHub",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (isDev) {
    await win.loadURL(devUrl);
    return;
  }

  ensureBackendProcess();
  await waitForHealthyServer(healthUrl, 30_000);
  await win.loadURL(apiUrl);
}

function ensureBackendProcess() {
  if (backendProcess || isDev) {
    return;
  }

  const nodeExe = process.execPath;
  const appRootDir = getAppRootDir();
  const workingDir = getWorkingDir();
  const scriptPath = path.join(appRootDir, "src/index.ts");

  const tsxLoaderUrl = resolveRuntimeImport("tsx/esm", appRootDir, workingDir);

  console.log("[desktop] Spawning backend:", nodeExe, scriptPath);
  console.log("[desktop] tsx loader:", tsxLoaderUrl);

  // Build a clean env for the child process.  `NODE_OPTIONS` may contain
  // flags (e.g. `--use-system-ca`) that Electron-in-Node mode forbids.
  const backendEnv = { ...process.env };
  delete backendEnv.NODE_OPTIONS;
  backendEnv.ELECTRON_RUN_AS_NODE = "1";
  backendEnv.PAPERHUB_APP_ROOT = appRootDir;
  if (app.isPackaged) {
    backendEnv.ESBUILD_BINARY_PATH = resolvePackagedEsbuildBinary(appRootDir);
    console.log("[desktop] esbuild binary:", backendEnv.ESBUILD_BINARY_PATH);
  }

  try {
    backendProcess = spawn(nodeExe, ["--import", tsxLoaderUrl, scriptPath], {
      cwd: workingDir,
      stdio: "inherit",
      env: backendEnv,
    });
  } catch (error) {
    void dialog.showErrorBox(
      "Failed to start backend",
      `Could not launch the API server: ${error instanceof Error ? error.message : String(error)}\n\nExe: ${nodeExe}\nScript: ${scriptPath}`,
    );
    app.quit();
    return;
  }

  backendProcess.on("error", (error) => {
    console.error("[desktop] Backend spawn error:", error);
    void dialog.showErrorBox(
      "Backend process error",
      `The API process encountered an error: ${error.message}\n\nExe: ${nodeExe}`,
    );
    app.quit();
  });

  backendProcess.on("exit", (code, signal) => {
    backendProcess = null;
    console.log(`[desktop] Backend process exited: code=${code} signal=${signal}`);
    if (code !== 0 && code !== null && !app.isQuitting) {
      void dialog.showErrorBox(
        "PaperHub API stopped",
        `The local API process exited unexpectedly with code ${code}.\n\n` +
          `This can happen if:\n` +
          `  • Port 3000 is already in use (close other PaperHub windows)\n` +
          `  • The database file is locked by another process\n` +
          `  • A required module failed to load\n\n` +
          `Check the log at: %USERPROFILE%\\PaperHub\\logs\\app.log`,
      );
      app.quit();
    }
  });
}

function stopBackendProcess() {
  if (!backendProcess) {
    return;
  }

  backendProcess.kill();
  backendProcess = null;
}

function waitForHealthyServer(url, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
          resolve();
          return;
        }

        retryOrFail();
      });

      request.on("error", retryOrFail);
      request.setTimeout(2_000, () => {
        request.destroy(new Error("timeout"));
      });
    };

    const retryOrFail = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 500);
    };

    attempt();
  });
}

function getAppRootDir() {
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, "..");
}

function getWorkingDir() {
  if (!app.isPackaged) {
    return path.join(__dirname, "..");
  }

  const appPath = app.getAppPath();
  return fs.statSync(appPath).isDirectory() ? appPath : path.dirname(appPath);
}

function resolveRuntimeImport(moduleId, appRootDir, workingDir) {
  const resolvedPath = require.resolve(moduleId, {
    paths: [appRootDir, workingDir, __dirname],
  });

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Required runtime module was not found: ${moduleId}`);
  }

  return pathToFileURL(resolvedPath).href;
}

function resolvePackagedEsbuildBinary(appRootDir) {
  const relativeBinaryPath = path.join(
    "node_modules",
    "@esbuild",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "esbuild.exe" : path.join("bin", "esbuild"),
  );
  const candidates = [
    path.join(appRootDir, relativeBinaryPath),
    path.join(process.resourcesPath, "app.asar.unpacked", relativeBinaryPath),
  ];
  const binaryPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!binaryPath) {
    throw new Error(`Packaged esbuild binary was not found: ${candidates.join(", ")}`);
  }

  return binaryPath;
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("PaperHub failed to start", message);
    app.quit();
    return;
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopBackendProcess();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
