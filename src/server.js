const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { postReplyToReddit } = require("./reddit-poster");

// Load .env manually (no dotenv dependency)
try {
  const envPath = path.join(__dirname, "..", ".env");
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const PORT = process.env.PORT || 3099;
const PAYPAL_LINK = process.env.PAYPAL_LINK || "https://paypal.me/YOURLINK";
const BOT_SECRET = process.env.BOT_SECRET || "";

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "50mb" }));

const upload = multer({
  dest: path.join(__dirname, "..", "tmp"),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /reply
 * Body (multipart):
 *   - image: the watermarked image file
 *   - redditUrl: the Reddit post URL
 *
 * OR JSON body:
 *   - imageUrl: URL to download the image from
 *   - redditUrl: the Reddit post URL
 */
app.post("/reply", upload.single("image"), async (req, res) => {
  try {
    // Auth check
    if (BOT_SECRET) {
      const token = req.headers.authorization?.replace("Bearer ", "") || req.body?.secret;
      if (token !== BOT_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const redditUrl = req.body.redditUrl;
    if (!redditUrl) {
      return res.status(400).json({ error: "redditUrl is required" });
    }

    let imagePath;
    if (req.file) {
      // Rename to proper extension
      const ext = req.file.originalname?.match(/\.(jpe?g|png|webp)$/i)?.[0] || ".jpg";
      imagePath = req.file.path + ext;
      fs.renameSync(req.file.path, imagePath);
    } else if (req.body.imageUrl) {
      // Download the image
      const fetch = (await import("node-fetch")).default;
      const resp = await fetch(req.body.imageUrl);
      if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      imagePath = path.join(__dirname, "..", "tmp", `dl-${Date.now()}.jpg`);
      fs.writeFileSync(imagePath, buffer);
    } else if (req.body.imageBase64) {
      // Base64 encoded image
      const buffer = Buffer.from(req.body.imageBase64, "base64");
      imagePath = path.join(__dirname, "..", "tmp", `b64-${Date.now()}.jpg`);
      fs.writeFileSync(imagePath, buffer);
    } else {
      return res.status(400).json({ error: "image file, imageUrl, or imageBase64 is required" });
    }

    console.log(`[${new Date().toISOString()}] Posting reply to ${redditUrl}`);

    const result = await postReplyToReddit({
      redditUrl,
      imagePath,
      paypalLink: req.body.paypalLink || PAYPAL_LINK,
    });

    // Clean up temp file
    try { fs.unlinkSync(imagePath); } catch {}

    console.log(`[${new Date().toISOString()}] Done: ${result.success ? "OK" : "FAILED"}`);
    res.json(result);
  } catch (err) {
    console.error("Reply failed:", err);
    // Clean up temp file on error
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Reddit reply bot listening on 0.0.0.0:${PORT}`);
});
