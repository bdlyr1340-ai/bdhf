import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import Tiktok from "@tobyg74/tiktok-api-dl";

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
  return /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)\/\S+/i.test(text);
}

function pickBestVideoUrl(data) {
  const candidates = [
    data?.result?.video?.downloadAddr,
    data?.result?.video?.playAddr,
    data?.result?.video?.cover,
    data?.result?.video1,
    data?.result?.video2,
    data?.result?.video_hd,
    data?.result?.video_watermark,
    data?.result?.music,
  ].filter(Boolean);

  return candidates[0] || null;
}

function pickCaption(data) {
  const title =
    data?.result?.desc ||
    data?.result?.title ||
    data?.result?.author?.nickname ||
    "TikTok media";

  const author =
    data?.result?.author?.nickname ||
    data?.result?.author?.unique_id ||
    data?.result?.author?.username ||
    "";

  return author ? `🎵 ${title}\n👤 ${author}` : `🎵 ${title}`;
}

async function sendTikTok(ctx, inputUrl) {
  const waiting = await ctx.reply("جاري جلب المقطع من تيك توك... ⏳");

  try {
    const data = await Tiktok.Downloader(inputUrl, {
      version: "v3",
      showOriginalResponse: true,
    });

    const mediaUrl = pickBestVideoUrl(data);

    if (!mediaUrl) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waiting.message_id,
        undefined,
        "ما قدرت أطلع رابط التحميل من هذا الرابط."
      );
      return;
    }

    const caption = pickCaption(data);

    await ctx.replyWithVideo(
      { url: mediaUrl },
      {
        caption,
        supports_streaming: true,
      }
    );

    await ctx.telegram.deleteMessage(ctx.chat.id, waiting.message_id).catch(() => {});
  } catch (error) {
    console.error("TikTok download failed:", error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waiting.message_id,
      undefined,
      "صار خطأ أثناء تحميل الرابط. تأكد أن الرابط صحيح وجرب مرة ثانية."
    ).catch(async () => {
      await ctx.reply("صار خطأ أثناء تحميل الرابط. تأكد أن الرابط صحيح وجرب مرة ثانية.");
    });
  }
}

// ===== أوامر البوت =====
bot.start((ctx) => {
  return ctx.reply(
    "هلا 👋\n" +
      "أرسل رابط تيك توك وأنا أحاول أحمّل لك الفيديو مباشرة.\n\n" +
      "الأوامر:\n" +
      "/start - تشغيل البوت\n" +
      "/help - شرح الاستخدام"
  );
});

bot.help((ctx) => {
  return ctx.reply(
    "طريقة الاستخدام:\n" +
      "1) انسخ رابط فيديو تيك توك\n" +
      "2) أرسله للبوت\n" +
      "3) البوت يرسل لك المقطع مباشرة\n\n" +
      "الروابط المدعومة:\n" +
      "- tiktok.com\n" +
      "- vt.tiktok.com\n" +
      "- vm.tiktok.com"
  );
});

// ===== استقبال الرسائل =====
bot.on("text", async (ctx) => {
  const text = ctx.message.text?.trim();

  if (!text) {
    return ctx.reply("أرسل رابط تيك توك صحيح.");
  }

  if (!isTikTokUrl(text)) {
    return ctx.reply("أرسل رابط تيك توك صحيح حتى أقدر أحمل المقطع.");
  }

  await sendTikTok(ctx, text);
});

// ===== سيرفر الصحة لـ Railway =====
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

// ===== التشغيل =====
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
