const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const PROFILE_DIR = path.join(__dirname, "..", "browser-profile");
const AUTH_STATE_PATH = path.join(__dirname, "..", "auth-state.json");

let persistentContext = null;

async function getContext() {
  if (persistentContext) {
    try {
      persistentContext.pages();
      return persistentContext;
    } catch {
      persistentContext = null;
    }
  }

  console.log("  [bot] Launching Chrome...");
  persistentContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  // Auto-reset when Chrome closes so next request relaunches it
  persistentContext.on("close", () => {
    console.log("  [bot] Chrome closed, will relaunch on next request");
    persistentContext = null;
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

function ts() { return `[${((Date.now() - ts._start) / 1000).toFixed(1)}s]`; }
ts._start = Date.now();

async function postReplyToReddit({ redditUrl, imagePath, paypalLink }) {
  ts._start = Date.now();
  let context = await getContext();
  let page;
  try {
    page = await context.newPage();
  } catch {
    // Chrome died between the check and newPage — reset and relaunch
    persistentContext = null;
    context = await getContext();
    page = await context.newPage();
  }

  try {
    console.log(`  [bot] ${ts()} Navigating to`, redditUrl);
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
    console.log(`  [bot] ${ts()} Blocked client-side navigation to /submit/`);

    // Also block HTTP navigation to /submit/
    await page.route('**/submit/**', (route) => {
      console.log("  [bot] BLOCKED HTTP request to:", route.request().url());
      route.abort();
    });

    // ── Step 1: Wait for comment-composer-host ──
    console.log(`  [bot] ${ts()} Waiting for comment-composer-host...`);
    try {
      await page.waitForSelector('comment-composer-host', { timeout: 15000 });
    } catch {
      throw new Error("comment-composer-host not found");
    }

    // ── Step 2: Click the trigger to open the rich text editor ──
    console.log(`  [bot] ${ts()} Clicking comment trigger...`);
    // Use Playwright click (not JS evaluate) so the editor actually opens
    try {
      await page.locator('faceplate-textarea-input[data-testid="trigger-button"]').first().click({ timeout: 5000 });
    } catch {
      // Fallback: click the "Join the conversation" area
      await page.locator('comment-composer-host').first().click({ timeout: 5000 });
    }
    console.log(`  [bot] ${ts()} Trigger clicked, waiting for editor...`);

    // Verify URL didn't change
    console.log("  [bot] URL after trigger:", page.url());

    // Wait for the RTE toolbar to appear (proves editor is open)
    console.log(`  [bot] ${ts()} Waiting for editor toolbar...`);
    try {
      await page.waitForSelector('div[contenteditable="true"][data-lexical-editor="true"]', { timeout: 10000 });
      console.log(`  [bot] ${ts()} Editor is open`);
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
    console.log(`  [bot] ${ts()} Uploading image:`, imagePath);

    // Wait for S3 upload only — asset.json is unreliable and had a 30s timeout
    // that was blocking us even after S3 already finished.
    const s3Promise = page
      .waitForResponse(
        (r) =>
          /reddit-uploaded-media.*amazonaws\.com/.test(r.url()) &&
          (r.request().method() === "POST" || r.request().method() === "PUT") &&
          r.status() < 400,
        { timeout: 60000 }
      )
      .catch(() => null);

    const uploaded = await uploadImage(page, imagePath);
    if (!uploaded) throw new Error("Failed to upload image");
    console.log(`  [bot] ${ts()} Image upload initiated, waiting for S3...`);

    const s3Resp = await s3Promise;
    console.log(`  [bot] ${ts()} S3 upload:`, s3Resp ? "ok" : "not seen");

    if (!s3Resp) {
      console.log(`  [bot] ${ts()} S3 not matched, falling back to networkidle...`);
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {}
    }

    // ── Step 5: Add tip text below the image ──
    console.log(`  [bot] ${ts()} Typing tip text...`);
    try {
      // After image upload, Lexical's DOM looks like:
      //   <div data-lexical-editor>
      //     <span data-lexical-decorator contenteditable="false">  ← image, NOT editable
      //     <p><br></p>                                             ← empty paragraph, editable
      //   </div>
      // Click the <p> directly — clicking the container lands on the image.
      const tipText = paypalLink
        ? `Tip is appreciated :) ${paypalLink}`
        : 'Tip is appreciated :)';

      // Wait for the empty <p> that Lexical creates after the image
      try {
        await page.waitForSelector('div[data-lexical-editor="true"] p', { timeout: 5000 });
      } catch {
        console.log(`  [bot] ${ts()} No <p> in editor yet`);
      }

      // Click the last <p> directly (the empty one after the image)
      const lastPara = page.locator('div[data-lexical-editor="true"] p').last();
      await lastPara.click();
      // Verify focus landed in the editor, not somewhere else
      const focused = await page.evaluate(() => {
        const ed = document.querySelector('div[data-lexical-editor="true"]');
        return ed && ed.contains(document.activeElement);
      });
      console.log(`  [bot] ${ts()} Editor focused after click:`, focused);
      if (!focused) {
        // Force focus via JS
        await page.evaluate(() => {
          const p = document.querySelector('div[data-lexical-editor="true"] p:last-of-type');
          if (p) p.focus();
        });
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(200);

      // Debug screenshot before typing — check tmp/ folder if text doesn't appear
      const preTypePath = path.join(__dirname, "..", "tmp", `pre-type-${Date.now()}.png`);
      try { await page.screenshot({ path: preTypePath }); } catch {}
      console.log(`  [bot] ${ts()} Pre-type screenshot:`, preTypePath);

      await page.keyboard.type(tipText);
      console.log(`  [bot] ${ts()} Typed tip text OK`);
    } catch (e) {
      console.log(`  [bot] ${ts()} Typing/link failed:`, e.message.split('\n')[0]);
    }

    console.log("  [bot] URL after upload:", page.url());

    // ── Step 6: Submit ──
    console.log(`  [bot] ${ts()} Submitting comment...`);

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

    console.log(`  [bot] ${ts()} Submitted, waiting...`);
    // Wait for editor to close OR 5s max — don't block on this
    try {
      await page.waitForSelector('div[contenteditable="true"][data-lexical-editor="true"]', {
        state: "detached",
        timeout: 5000,
      });
    } catch {}

    const postPath = path.join(__dirname, "..", "tmp", `post-submit-${Date.now()}.png`);
    try { await page.screenshot({ path: postPath, fullPage: true }); } catch {}
    console.log(`  [bot] ${ts()} DONE. Post-submit screenshot:`, postPath);

    try { await page.unroute('**/submit/**'); } catch {}
    await page.close();
    return { success: true };
  } catch (err) {
    // If Chrome was closed externally, reset so next request relaunches it
    if (err.message.includes('closed') || err.message.includes('Target page')) {
      persistentContext = null;
    }
    const sp = path.join(__dirname, "..", "tmp", `error-${Date.now()}.png`);
    try { await page.screenshot({ path: sp, fullPage: true }); } catch {}
    try { await page.unroute('**/submit/**'); } catch {}
    try { await page.close(); } catch {}
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
