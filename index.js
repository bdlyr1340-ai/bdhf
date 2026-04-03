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
  return /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)\/\S+/i.test(
    text
  );
}

function pickBestVideoUrl(data) {
  const candidates = [
    data?.result?.video?.downloadAddr,
    data?.result?.video?.playAddr,
    data?.result?.video1,
    data?.result?.video2,
    data?.result?.video_hd,
    data?.result?.video_watermark,
  ].filter(Boolean);

  return candidates[0] || null;
}

function pickCaption(data) {
  const title =
    data?.result?.desc ||
    data?.result?.title ||
    "TikTok Video";

  const author =
    data?.result?.author?.nickname ||
    data?.result?.author?.unique_id ||
    "";

  return author ? `🎬 ${title}\n👤 ${author}` : `🎬 ${title}`;
}

async function sendTikTok(ctx, inputUrl) {
  const waiting = await ctx.reply("جاري تحميل الفيديو... ⏳");

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
        "ما كدرت أستخرج رابط الفيديو من هذا الرابط."
      );
      return;
    }

    await ctx.replyWithVideo(
      { url: mediaUrl },
      {
        caption: pickCaption(data),
        supports_streaming: true,
      }
    );

    await ctx.telegram
      .deleteMessage(ctx.chat.id, waiting.message_id)
      .catch(() => {});
  } catch (error) {
    console.error("TikTok download failed:", error);

    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        waiting.message_id,
        undefined,
        "صار خطأ أثناء التحميل. تأكد من الرابط وجرب مرة ثانية."
      )
      .catch(async () => {
        await ctx.reply("صار خطأ أثناء التحميل. تأكد من الرابط وجرب مرة ثانية.");
      });
  }
}

bot.start((ctx) => {
  return ctx.reply(
    "هلا 👋\n\n" +
      "أرسل رابط TikTok وأنا أرسل لك الفيديو مباشرة.\n\n" +
      "الأوامر:\n" +
      "/start - تشغيل البوت\n" +
      "/help - شرح الاستخدام"
  );
});

bot.help((ctx) => {
  return ctx.reply(
    "طريقة الاستخدام:\n" +
      "1) انسخ رابط فيديو تيك توك\n" +
      "2) أرسله إلى البوت\n" +
      "3) البوت يرسل لك الفيديو مباشرة"
  );
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text?.trim();

  if (!text) {
    return ctx.reply("أرسل رابط TikTok صحيح.");
  }

  if (!isTikTokUrl(text)) {
    return ctx.reply("أرسل رابط TikTok صحيح حتى أقدر أحمل الفيديو.");
  }

  await sendTikTok(ctx, text);
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
