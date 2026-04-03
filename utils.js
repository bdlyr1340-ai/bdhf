import { Markup } from "telegraf";
import { config } from "./config.js";

export function isAdmin(userId) {
  return config.ADMIN_IDS.includes(Number(userId));
}

export function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

export function slugify(value = "") {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function randomCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const op = Math.random() > 0.5 ? "+" : "-";
  return {
    question: `${a} ${op} ${b} = ?`,
    answer: op === "+" ? a + b : a - b,
  };
}

export function forceSubKeyboard() {
  const buttons = [];
  if (config.CHANNEL_URL) {
    buttons.push([Markup.button.url("اشترك بالقناة", config.CHANNEL_URL)]);
  } else if (config.CHANNEL_USERNAME) {
    buttons.push([Markup.button.url("اشترك بالقناة", `https://t.me/${config.CHANNEL_USERNAME.replace("@", "")}`)]);
  }
  buttons.push([Markup.button.callback("تحققت من الاشتراك", "CHECK_SUB")]);
  return Markup.inlineKeyboard(buttons);
}

export function mainKeyboard() {
  return Markup.keyboard([
    ["🛍 المتجر", "💰 محفظتي"],
    ["🎁 دعواتي", "📦 طلباتي"],
    ["✅ تحقق الاشتراك"],
  ]).resize();
}

export function adminKeyboard() {
  return Markup.keyboard([
    ["➕ إضافة منتج", "📥 رفع أكواد"],
    ["💵 شحن رصيد", "📊 المخزون"],
    ["👥 المستخدمين", "🛍 المتجر"],
  ]).resize();
}
