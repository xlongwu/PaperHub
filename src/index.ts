/**
 * PaperHub main entry point.
 * Initializes database, starts API server, and starts scheduler.
 */

import "dotenv/config";
import { initDatabase, closeDb } from "@/db/index";
import { startServer } from "@/api/server";
import { startScheduler, stopScheduler, waitForRunningTasks } from "@/scheduler";
import { getLlmSettingsState } from "@/providers/index";
import { getLogsDir } from "@/config";
import { initDefaultPreferences } from "@/db/user";
import { startIndexer, stopIndexer } from "@/search-indexer";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Logging setup
// ---------------------------------------------------------------------------

function setupLogging(): void {
  const dir = getLogsDir();
  const file = path.join(dir, "app.log");

  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
    originalLog(...args);
    try {
      fs.appendFileSync(file, line, "utf-8");
    } catch {
      // Logging must never break the desktop app startup path.
    }
  };

  console.error = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ERROR: ${args.join(" ")}\n`;
    originalError(...args);
    try {
      fs.appendFileSync(file, line, "utf-8");
    } catch {
      // Logging must never break the desktop app startup path.
    }
  };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(server: ReturnType<typeof startServer>): void {
  const shutdown = async (signal: string) => {
    console.log(`[app] Received ${signal}, shutting down gracefully...`);

    stopScheduler();
    stopIndexer();
    await waitForRunningTasks();
    server.close(() => {
      console.log("[app] Server closed.");
      closeDb();
      console.log("[app] Database closed.");
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      console.error("[app] Forced exit after timeout.");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Catch unhandled rejections and exceptions — log, then exit gracefully
  process.on("unhandledRejection", (reason) => {
    console.error("[app] Unhandled rejection:", reason);
    shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    console.error("[app] Uncaught exception:", error);
    shutdown("uncaughtException");
  });
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Fail fast if the configured LLM provider lacks an API key.
 * The provider object may be created without a key (e.g., Anthropic SDK
 * accepts undefined), but runtime calls would fail with confusing errors.
 */
function validateLlmProvider(): void {
  const settings = getLlmSettingsState();
  if (!settings.hasApiKey) {
    console.warn(
      `[app] WARNING: LLM provider "${settings.provider}" has no API key configured. ` +
        "Set one in Profile > LLM connection or through an environment variable.",
    );
  } else {
    console.log(`[app] LLM provider "${settings.provider}" validated (${settings.apiKeySource} key).`);
  }

  // Also validate embedding provider
  const embedProvider = process.env["EMBEDDING_PROVIDER"]?.trim().toLowerCase() ?? "openai";
  if (embedProvider !== "local") {
    const hasApiKey = process.env["EMBEDDING_API_KEY"] || process.env["OPENAI_API_KEY"];
    if (!hasApiKey) {
      console.warn(
        "[app] WARNING: OpenAI embedding configured but no API key found. " +
          "Semantic search will fail. Set EMBEDDING_API_KEY or OPENAI_API_KEY.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[app] PaperHub starting...");

  setupLogging();

  // 1. Init database
  try {
    initDatabase();
    console.log("[app] Database initialized.");
  } catch (e) {
    console.error("[app] Database initialization failed:", e);
    throw e;
  }

  // 1.5. Init default user preferences
  try {
    initDefaultPreferences();
    console.log("[app] User preferences initialized.");
  } catch (e) {
    console.error("[app] User preferences initialization failed:", e);
    // Non-fatal — continue without preferences
  }

  // 1.6. Validate LLM provider is usable (fail fast if api key missing)
  validateLlmProvider();
  startIndexer();

  // 2. Start API server
  const server = startServer();

  // 3. Start scheduler
  if (process.env["PAPERHUB_DISABLE_SCHEDULER"] === "1") {
    console.log("[app] Scheduler disabled by PAPERHUB_DISABLE_SCHEDULER=1.");
  } else {
    startScheduler(true);
  }

  // 4. Setup shutdown handlers
  setupShutdownHandlers(server);

  console.log("[app] PaperHub is ready.");
}

main().catch((err) => {
  console.error("[app] Fatal error:", err);
  process.exit(1);
});
