import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const chromePath = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
  (candidate) => fs.existsSync(candidate),
);

export default defineConfig({
  testDir: path.resolve("e2e"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://paperhub.test",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ignoreDefaultArgs: ["--enable-crash-reporter"],
      args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"],
      executablePath: chromePath,
    },
  },
});
