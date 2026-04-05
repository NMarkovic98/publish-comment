const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const PROFILE_DIR = path.join(__dirname, "..", "browser-profile");
const AUTH_STATE_PATH = path.join(__dirname, "..", "auth-state.json");

let persistentContext = null;

async function getContext() {
  if (persistentContext && persistentContext.pages) {
    try {
      persistentContext.pages();
      return persistentContext;
    } catch {}
  }

  persistentContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  if (fs.existsSync(AUTH_STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf-8"));
      if (state.cookies?.length) {
        await persistentContext.addCookies(state.cookies);
      }
    } catch {}
  }

  return persistentContext;
}

async function postReplyToReddit({ redditUrl, imagePath, paypalLink }) {
  const context = await getContext();
  const page = await context.newPage();

  try {
    console.log("  [bot] Navigating to", redditUrl);
    await page.goto(redditUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // ── Block client-side navigation to /submit/ ──
    // Reddit uses pushState for SPA navigation. Override it to prevent
    // the comment trigger from navigating away from the post page.
    await page.evaluate(() => {
      const origPushState = history.pushState.bind(history);
      const origReplaceState = history.replaceState.bind(history);
      history.pushState = function(...args) {
        if (args[2] && String(args[2]).includes('/submit')) {
          console.log('[bot-override] Blocked pushState to', args[2]);
          return;
        }
        return origPushState(...args);
      };
      history.replaceState = function(...args) {
        if (args[2] && String(args[2]).includes('/submit')) {
          console.log('[bot-override] Blocked replaceState to', args[2]);
          return;
        }
        return origReplaceState(...args);
      };
    });
    console.log("  [bot] Blocked client-side navigation to /submit/");

    // Also block HTTP navigation to /submit/
    await page.route('**/submit/**', (route) => {
      console.log("  [bot] BLOCKED HTTP request to:", route.request().url());
      route.abort();
    });

    // ── Step 1: Wait for comment-composer-host ──
    console.log("  [bot] Waiting for comment-composer-host...");
    try {
      await page.waitForSelector('comment-composer-host', { timeout: 15000 });
    } catch {
      throw new Error("comment-composer-host not found");
    }

    // ── Step 2: Click the trigger to open the rich text editor ──
    console.log("  [bot] Clicking comment trigger...");
    // Use Playwright click (not JS evaluate) so the editor actually opens
    try {
      await page.locator('faceplate-textarea-input[data-testid="trigger-button"]').first().click({ timeout: 5000 });
    } catch {
      // Fallback: click the "Join the conversation" area
      await page.locator('comment-composer-host').first().click({ timeout: 5000 });
    }
    console.log("  [bot] Trigger clicked, waiting for editor...");

    // Verify URL didn't change
    console.log("  [bot] URL after trigger:", page.url());

    // Wait for the RTE toolbar to appear (proves editor is open)
    console.log("  [bot] Waiting for editor toolbar...");
    try {
      await page.waitForSelector('div[contenteditable="true"][data-lexical-editor="true"]', { timeout: 10000 });
      console.log("  [bot] Editor is open");
    } catch {
      console.log("  [bot] Editor not found, taking debug screenshot...");
      const debugPath = path.join(__dirname, "..", "tmp", `debug-editor-${Date.now()}.png`);
      try { await page.screenshot({ path: debugPath, fullPage: false }); } catch {}
      console.log("  [bot] Debug screenshot:", debugPath);
      throw new Error("Editor did not open after trigger click");
    }

    // Click into the editor to ensure focus and toolbar is active
    await page.locator('div[contenteditable="true"][data-lexical-editor="true"]').first().click();

    // ── Step 4: Upload image ──
    console.log("  [bot] Uploading image:", imagePath);

    // Set up network listeners BEFORE triggering the upload so we don't miss anything.
    // Reddit flow: POST /api/media/asset.json → returns S3 presigned URL →
    // browser does POST (multipart) to reddit-uploaded-media.s3-accelerate.amazonaws.com
    const assetPromise = page
      .waitForResponse(
        (r) => /\/api\/media\/asset\.json/.test(r.url()) && r.status() < 400,
        { timeout: 30000 }
      )
      .catch(() => null);

    const s3Promise = page
      .waitForResponse(
        (r) =>
          /reddit-uploaded-media.*amazonaws\.com/.test(r.url()) &&
          (r.request().method() === "POST" || r.request().method() === "PUT") &&
          r.status() < 400,
        { timeout: 180000 }
      )
      .catch(() => null);

    const uploaded = await uploadImage(page, imagePath);
    if (!uploaded) throw new Error("Failed to upload image");
    console.log("  [bot] Image upload initiated, waiting for network...");

    const assetResp = await assetPromise;
    console.log("  [bot] asset.json response:", assetResp ? "ok" : "not seen");
    const s3Resp = await s3Promise;
    console.log("  [bot] S3 upload response:", s3Resp ? "ok" : "not seen");

    if (!s3Resp) {
      // Fallback: wait for network idle in case Reddit changed the host
      console.log("  [bot] S3 not matched, falling back to networkidle...");
      try {
        await page.waitForLoadState("networkidle", { timeout: 60000 });
      } catch {}
    }

    // Small settle delay for Lexical to swap the blob for the CDN URL
    await page.waitForTimeout(1500);

    // ── Step 5: Add tip text below the image ──
    console.log("  [bot] Typing tip text...");
    try {
      const tipText = paypalLink
        ? `tip is appreciated :) ${paypalLink}`
        : "tip is appreciated :)";
      const editor = page.locator('div[contenteditable="true"][data-lexical-editor="true"]').first();
      await editor.click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type(tipText, { delay: 10 });
    } catch (e) {
      console.log("  [bot] Typing text failed:", e.message.split('\n')[0]);
    }

    console.log("  [bot] URL after upload:", page.url());

    // ── Step 6: Submit ──
    console.log("  [bot] Submitting comment...");

    let submitted = false;

    // Click the submit button via JS
    try {
      const result = await page.evaluate(() => {
        const btn = document.querySelector('button[slot="submit-button"]');
        if (btn && btn.textContent.includes('Comment')) {
          btn.click();
          return "slot-btn";
        }
        // Search all buttons
        const buttons = document.querySelectorAll('button[type="submit"]');
        for (const b of buttons) {
          if (b.textContent.includes('Comment') && (b.offsetParent !== null || b.offsetHeight > 0)) {
            b.click();
            return "visible-submit";
          }
        }
        return null;
      });
      if (result) {
        submitted = true;
        console.log("  [bot] Submit via:", result);
      }
    } catch (e) {
      console.log("  [bot] Submit JS click failed:", e.message.split('\n')[0]);
    }

    // Fallback: Playwright locator
    if (!submitted) {
      try {
        await page.locator('button[slot="submit-button"]').first().click({ timeout: 5000, force: true });
        submitted = true;
        console.log("  [bot] Submit via Playwright locator");
      } catch (e) {
        console.log("  [bot] Submit Playwright failed:", e.message.split('\n')[0]);
      }
    }

    if (!submitted) throw new Error("Could not submit comment");

    console.log("  [bot] Submitted, waiting...");
    try {
      await page.waitForSelector('div[contenteditable="true"][data-lexical-editor="true"]', {
        state: "detached",
        timeout: 15000,
      });
    } catch {}

    const postPath = path.join(__dirname, "..", "tmp", `post-submit-${Date.now()}.png`);
    try { await page.screenshot({ path: postPath, fullPage: true }); } catch {}
    console.log("  [bot] Post-submit screenshot:", postPath);

    try { await page.unroute('**/submit/**'); } catch {}
    await page.close();
    return { success: true };
  } catch (err) {
    const sp = path.join(__dirname, "..", "tmp", `error-${Date.now()}.png`);
    try { await page.screenshot({ path: sp, fullPage: true }); } catch {}
    try { await page.unroute('**/submit/**'); } catch {}
    await page.close();
    return { success: false, error: err.message, screenshot: sp };
  }
}

async function uploadImage(page, imagePath) {
  // Method 1: Direct locator
  try {
    const input = page.locator("rte-toolbar-button-image").locator("input[type='file']");
    const count = await input.count();
    console.log("  [bot] Upload method 1: found", count, "file inputs");
    if (count > 0) {
      await input.first().setInputFiles(imagePath);
      console.log("  [bot] Upload method 1: SUCCESS");
      return true;
    }
  } catch (e) {
    console.log("  [bot] Upload method 1 failed:", e.message.split('\n')[0]);
  }

  // Method 2: Shadow DOM
  try {
    const handle = await page.evaluateHandle(() => {
      for (const btn of document.querySelectorAll("rte-toolbar-button-image")) {
        if (btn.shadowRoot) {
          const input = btn.shadowRoot.querySelector('input[type="file"]');
          if (input) return input;
        }
      }
      return null;
    });
    const el = handle?.asElement();
    if (el) {
      await el.setInputFiles(imagePath);
      await page.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })), el);
      console.log("  [bot] Upload method 2 (shadow): SUCCESS");
      return true;
    } else {
      console.log("  [bot] Upload method 2: no shadow input found");
    }
  } catch (e) {
    console.log("  [bot] Upload method 2 failed:", e.message.split('\n')[0]);
  }

  // Method 3: Any file input on the page
  try {
    const allInputs = page.locator('input[type="file"]');
    const count = await allInputs.count();
    console.log("  [bot] Upload method 3: found", count, "file inputs on page");
    if (count > 0) {
      await allInputs.first().setInputFiles(imagePath);
      console.log("  [bot] Upload method 3 (any input): SUCCESS");
      return true;
    }
  } catch (e) {
    console.log("  [bot] Upload method 3 failed:", e.message.split('\n')[0]);
  }

  console.log("  [bot] All upload methods failed");
  return false;
}

module.exports = { postReplyToReddit };
