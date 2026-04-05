/**
 * Setup: Opens a separate Chrome window to log into Reddit.
 * Uses its own profile dir so it doesn't conflict with your open Chrome.
 *
 * Usage: node src/setup-auth.js
 */

const { chromium } = require("playwright");
const path = require("path");

const PROFILE_DIR = path.join(__dirname, "..", "browser-profile");
const AUTH_STATE_PATH = path.join(__dirname, "..", "auth-state.json");

(async () => {
  console.log("\nOpening a browser window — log into Reddit there.");
  console.log("(Your normal Chrome can stay open, this is separate.)\n");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto("https://www.reddit.com/login/");

  console.log("========================================");
  console.log("  Log into Reddit in the browser.");
  console.log("  Once logged in, press ENTER here.");
  console.log("========================================\n");

  await new Promise((resolve) => process.stdin.once("data", resolve));

  await context.storageState({ path: AUTH_STATE_PATH });
  console.log(`Session saved to ${AUTH_STATE_PATH}`);

  await context.close();
  process.exit(0);
})();
