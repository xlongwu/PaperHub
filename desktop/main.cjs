const path = require("node:path");
const http = require("node:http");
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
  const rootDir = getRootDir();
  const scriptPath = path.join(rootDir, "src/index.ts");

  console.log("[desktop] Spawning backend:", nodeExe, scriptPath);

  // Build a clean env for the child process.  `NODE_OPTIONS` may contain
  // flags (e.g. `--use-system-ca`) that Electron-in-Node mode forbids.
  const backendEnv = { ...process.env };
  delete backendEnv.NODE_OPTIONS;
  backendEnv.ELECTRON_RUN_AS_NODE = "1";

  try {
    backendProcess = spawn(nodeExe, ["--import", "tsx", scriptPath], {
      cwd: rootDir,
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

  backendProcess.on("exit", (code) => {
    backendProcess = null;
    if (code && code !== 0 && !app.isQuitting) {
      void dialog.showErrorBox(
        "PaperHub API stopped",
        `The local API process exited unexpectedly with code ${code}.`,
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

function getRootDir() {
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, "..");
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
