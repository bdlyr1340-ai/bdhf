import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';

const requiredVars = ['BOT_TOKEN'];
const missingVars = requiredVars.filter((key) => !process.env[key]);

if (missingVars.length) {
  console.error(`Missing env vars: ${missingVars.join(', ')}`);
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use(express.json());

// ===== أوامر البوت =====
bot.start((ctx) => {
  return ctx.reply(
    'هلا 👋\n' +
    'البوت شغال على Railway.\n\n' +
    'الأوامر:\n' +
    '/start - تشغيل البوت\n' +
    '/help - عرض المساعدة\n' +
    '/ping - اختبار'
  );
});

bot.help((ctx) => {
  return ctx.reply(
    'مساعدة البوت:\n' +
    '/start\n' +
    '/help\n' +
    '/ping'
  );
});

bot.command('ping', (ctx) => ctx.reply('pong 🏓'));

// رد على أي رسالة نصية
bot.on('text', (ctx) => {
  const text = ctx.message.text?.trim();

  if (!text) {
    return ctx.reply('أرسل نص حتى أرد عليك.');
  }

  return ctx.reply(`وصلتني رسالتك:\n${text}`);
});

// ===== سيرفر الصحة لـ Railway =====
app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'telegram-bot',
    mode: 'polling',
  });
});

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// ===== التشغيل =====
const PORT = Number(process.env.PORT || 3000);

async function startApp() {
  try {
    await bot.launch();
    console.log('Telegram bot started');

    app.listen(PORT, () => {
      console.log(`HTTP server running on port ${PORT}`);
    });

    process.once('SIGINT', async () => {
      await bot.stop('SIGINT');
      process.exit(0);
    });

    process.once('SIGTERM', async () => {
      await bot.stop('SIGTERM');
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
}

startApp();
