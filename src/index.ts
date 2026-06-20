/**
 * PaperHub main entry point.
 * Initializes database, starts API server, and starts scheduler.
 */

import "dotenv/config";
import { initDatabase, closeDb } from "@/db/index";
import { startServer } from "@/api/server";
import { startScheduler, stopScheduler, waitForRunningTasks } from "@/scheduler";
import { resolveLlmRuntime } from "@/providers/index";
import { getLogsDir } from "@/config";
import { initDefaultPreferences } from "@/db/user";
import { startIndexer, stopIndexer } from "@/search-indexer";
import { getEmbeddingConfiguration } from "@/embedding";
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
  const runtime = resolveLlmRuntime();
  const requiresApiKey = runtime.connection.auth.type !== "none";
  if (requiresApiKey && !runtime.connection.apiKey) {
    console.warn(
      `[app] WARNING: LLM connection "${runtime.connection.name}" has no API key configured. ` +
        "Set one in Profile > LLM connection or through an environment variable.",
    );
  } else {
    console.log(
      `[app] LLM connection "${runtime.connection.name}" validated (${runtime.source}).`,
    );
  }

  // Embeddings initialize in the background so an unavailable local model
  // never prevents the API, FTS search, or desktop shell from starting.
  try {
    const embedding = getEmbeddingConfiguration();
    if (embedding.provider === "openai" && !embedding.apiKey) {
      console.warn(
        "[app] WARNING: OpenAI embedding configured but no API key found. " +
          "Semantic search will fail. Set EMBEDDING_API_KEY or OPENAI_API_KEY.",
      );
    } else {
      console.log(`[app] Embedding provider configured: ${embedding.provider}/${embedding.model}.`);
    }
  } catch (error) {
    console.warn(
      `[app] WARNING: Invalid embedding configuration. Keyword search remains available. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[app] PaperHub starting...");

  setupLogging();

  // Log exit code for post-mortem debugging
  process.on("exit", (code) => {
    if (code !== 0) {
      try {
        const dir = getLogsDir();
        const file = path.join(dir, "app.log");
        fs.appendFileSync(
          file,
          `[${new Date().toISOString()}] [app] Process exited with code ${code}\n`,
          "utf-8",
        );
      } catch {
        /* ignore */
      }
    }
  });

  // 1. Init database
  try {
    initDatabase();
    console.log("[app] Database initialized.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ABI mismatch — better-sqlite3 compiled for a different Node version
    if (msg.includes("NODE_MODULE_VERSION") || msg.includes("ERR_DLOPEN_FAILED")) {
      console.error(
        "[app] Database initialization failed: native module ABI mismatch.\n" +
          "  The 'better-sqlite3' module was compiled for a different Node.js version.\n" +
          "  Fix: run 'pnpm rebuild better-sqlite3' and rebuild the app.\n" +
          "  Error detail:", e,
      );
    } else if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      console.error(
        "[app] Database initialization failed: database is locked.\n" +
          "  Another PaperHub instance may still be running.\n" +
          "  Fix: close all other PaperHub windows, then restart.\n" +
          "  Error detail:", e,
      );
    } else {
      console.error("[app] Database initialization failed:", e);
    }
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
