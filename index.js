import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import Tiktok from "@tobyg74/tiktok-api-dl";
import fs from "fs";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";

const requiredVars = ["BOT_TOKEN"];
const missingVars = requiredVars.filter((key) => !process.env[key]);

if (missingVars.length) {
  console.error(`Missing env vars: ${missingVars.join(", ")}`);
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());

function isTikTokUrl(text = "") {
  return /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)\/\S+/i.test(
    text
  );
}

function normalizeUrl(text = "") {
  return text.trim();
}

function pickVideoUrl(data) {
  const candidates = [
    data?.result?.video?.downloadAddr,
    data?.result?.video?.playAddr,
    data?.result?.video?.play,
    data?.result?.video,
    data?.result?.video1,
    data?.result?.video2,
    data?.result?.video_hd,
    data?.result?.video_watermark,
    data?.result?.nowm,
    data?.result?.wm,
    data?.result?.hdplay,
    data?.result?.play,
  ].filter((v) => typeof v === "string" && v.startsWith("http"));

  return candidates[0] || null;
}

function pickCaption(data) {
  const title =
    data?.result?.desc ||
    data?.result?.title ||
    data?.result?.author?.nickname ||
    "TikTok Video";

  const author =
    data?.result?.author?.nickname ||
    data?.result?.author?.unique_id ||
    data?.result?.author?.username ||
    "";

  return author ? `🎬 ${title}\n👤 ${author}` : `🎬 ${title}`;
}

async function downloadFile(url, filePath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      accept: "*/*",
      referer: "https://www.tiktok.com/",
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Empty response body");
  }

  const contentLength = Number(response.headers.get("content-length") || 0);

  // حد تقريبي حتى لا يفشل إرسال البوت إذا كان الملف ضخم
  if (contentLength > 49 * 1024 * 1024) {
    throw new Error("Video is too large for direct Telegram bot upload");
  }

  const writeStream = fs.createWriteStream(filePath);
  await pipeline(response.body, writeStream);
}

async function cleanupFile(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch {
    // ignore
  }
}

async function sendTikTokVideo(ctx, inputUrl) {
  const waiting = await ctx.reply("⏳ جاري تحميل الفيديو، انتظر قليلاً...");

  let tempFilePath = null;

  try {
    const data = await Tiktok.Downloader(inputUrl, {
      version: "v3",
      showOriginalResponse: true,
    });

    const mediaUrl = pickVideoUrl(data);

    if (!mediaUrl) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waiting.message_id,
        undefined,
        "❌ ما قدرت أستخرج رابط فيديو مباشر من هذا الرابط."
      );
      return;
    }

    tempFilePath = path.join(os.tmpdir(), `tiktok_${Date.now()}.mp4`);

    await downloadFile(mediaUrl, tempFilePath);

    await ctx.replyWithVideo(
      { source: fs.createReadStream(tempFilePath) },
      {
        caption: pickCaption(data),
        supports_streaming: true,
      }
    );

    await ctx.telegram
      .deleteMessage(ctx.chat.id, waiting.message_id)
      .catch(() => {});
  } catch (error) {
    console.error("TikTok video sending failed:", error);

    const message =
      error?.message === "Video is too large for direct Telegram bot upload"
        ? "❌ الفيديو حجمه كبير على الإرسال المباشر من البوت."
        : "❌ صار خطأ أثناء تحميل أو إرسال الفيديو. جرّب رابط TikTok آخر.";

    await ctx.telegram
      .editMessageText(ctx.chat.id, waiting.message_id, undefined, message)
      .catch(async () => {
        await ctx.reply(message);
      });
  } finally {
    if (tempFilePath) {
      await cleanupFile(tempFilePath);
    }
  }
}

bot.start((ctx) => {
  return ctx.reply(
    "هلا 👋\n\nأرسل رابط فيديو TikTok وأنا أرسل لك الفيديو مباشرة داخل تيليجرام.\n\n/start - تشغيل\n/help - شرح الاستخدام"
  );
});

bot.help((ctx) => {
  return ctx.reply(
    "طريقة الاستخدام:\n1) انسخ رابط فيديو TikTok\n2) أرسله إلى البوت\n3) البوت ينزّل الفيديو ثم يرسله لك مباشرة"
  );
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text?.trim();

  if (!text) {
    return ctx.reply("أرسل رابط TikTok صحيح.");
  }

  if (!isTikTokUrl(text)) {
    return ctx.reply("أرسل رابط فيديو TikTok صحيح حتى أرسله لك مباشرة.");
  }

  await sendTikTokVideo(ctx, normalizeUrl(text));
});

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "telegram-tiktok-bot",
    mode: "polling",
  });
});

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

const PORT = Number(process.env.PORT || 3000);

async function startApp() {
  try {
    await bot.launch();
    console.log("Telegram bot started");

    app.listen(PORT, () => {
      console.log(`HTTP server running on port ${PORT}`);
    });

    process.once("SIGINT", async () => {
      await bot.stop("SIGINT");
      process.exit(0);
    });

    process.once("SIGTERM", async () => {
      await bot.stop("SIGTERM");
      process.exit(0);
    });
  } catch (error) {
    console.error("Failed to start app:", error);
    process.exit(1);
  }
}

startApp();
