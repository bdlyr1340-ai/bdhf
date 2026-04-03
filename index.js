import "dotenv/config";
import express from "express";
import { Telegraf, Markup } from "telegraf";
import pkg from "pg";
const { Pool } = pkg;

const requiredVars = ["BOT_TOKEN", "DATABASE_URL"];
const missingVars = requiredVars.filter((key) => !process.env[key]);
if (missingVars.length) {
  console.error(`Missing env vars: ${missingVars.join(", ")}`);
  process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "";
const CHANNEL_ID = process.env.CHANNEL_ID || "";
const CHANNEL_URL = process.env.CHANNEL_URL || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean).map(Number);
const REFERRAL_TARGET = Number(process.env.REFERRAL_TARGET || 10);
const REFERRAL_REWARD_PRODUCT_SLUG = process.env.REFERRAL_REWARD_PRODUCT_SLUG || "";

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const sessions = new Map();
function getSession(userId) { if (!sessions.has(userId)) sessions.set(userId, {}); return sessions.get(userId); }
function clearSession(userId) { sessions.delete(userId); }
function isAdmin(userId) { return ADMIN_IDS.includes(Number(userId)); }
function money(value) { return `$${Number(value).toFixed(2)}`; }
function slugify(value = "") { return value.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-"); }
function randomCaptcha() { const a = Math.floor(Math.random()*9)+1; const b = Math.floor(Math.random()*9)+1; const op = Math.random()>0.5 ? "+" : "-"; return { question: `${a} ${op} ${b} = ?`, answer: op === "+" ? a+b : a-b }; }
function mainKeyboard() { return Markup.keyboard([["🛍 المتجر","💰 محفظتي"],["🎁 دعواتي","📦 طلباتي"],["✅ تحقق الاشتراك"]]).resize(); }
function adminKeyboard() { return Markup.keyboard([["➕ إضافة منتج","📥 رفع أكواد"],["💵 شحن رصيد","📊 المخزون"],["👥 المستخدمين","🛍 المتجر"]]).resize(); }
function forceSubKeyboard() { const rows=[]; if (CHANNEL_URL) rows.push([Markup.button.url("اشترك بالقناة", CHANNEL_URL)]); else if (CHANNEL_USERNAME) rows.push([Markup.button.url("اشترك بالقناة", `https://t.me/${CHANNEL_USERNAME.replace("@","")}`)]); rows.push([Markup.button.callback("تحققت من الاشتراك","CHECK_SUB")]); return Markup.inlineKeyboard(rows); }
function getChannelTarget() { return CHANNEL_ID || CHANNEL_USERNAME; }
function parseReferral(text="") { const m = String(text).match(/u(\d+)/); return m ? Number(m[1]) : null; }

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, telegram_id BIGINT UNIQUE NOT NULL, full_name TEXT, username TEXT, balance_usd NUMERIC(12,2) DEFAULT 0, points INTEGER DEFAULT 0, is_subscribed BOOLEAN DEFAULT FALSE, is_verified BOOLEAN DEFAULT FALSE, referred_by BIGINT, referrals_count INTEGER DEFAULT 0, referral_rewarded BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT, price_usd NUMERIC(12,2) NOT NULL, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS product_codes (id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, code_value TEXT UNIQUE NOT NULL, is_sold BOOLEAN DEFAULT FALSE, sold_to_telegram_id BIGINT, sold_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, quantity INTEGER NOT NULL, total_price NUMERIC(12,2) NOT NULL, status TEXT DEFAULT 'completed', created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_code_id INTEGER NOT NULL REFERENCES product_codes(id) ON DELETE CASCADE, code_value TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS referrals (id SERIAL PRIMARY KEY, inviter_telegram_id BIGINT NOT NULL, invited_telegram_id BIGINT UNIQUE NOT NULL, is_counted BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wallet_transactions (id SERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, type TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, reason TEXT, created_at TIMESTAMP DEFAULT NOW());`);
}

async function ensureUser(ctx) {
  const tg = ctx.from;
  const telegramId = String(tg.id);
  const fullName = [tg.first_name, tg.last_name].filter(Boolean).join(" ");
  const username = tg.username || null;
  const existing = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
  if (!existing.rows.length) {
    const created = await pool.query(`INSERT INTO users (telegram_id, full_name, username) VALUES ($1, $2, $3) RETURNING *`, [telegramId, fullName, username]);
    return created.rows[0];
  }
  const updated = await pool.query(`UPDATE users SET full_name = $2, username = $3, updated_at = NOW() WHERE telegram_id = $1 RETURNING *`, [telegramId, fullName, username]);
  return updated.rows[0];
}
async function getUserByTelegramId(telegramId) { const r = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [String(telegramId)]); return r.rows[0] || null; }

async function checkSubscription(telegramId) {
  const target = getChannelTarget();
  if (!target) return true;
  try {
    const member = await bot.telegram.getChatMember(target, Number(telegramId));
    return ["creator","administrator","member"].includes(member.status);
  } catch (error) {
    console.error("Subscription check error:", error?.description || error);
    return false;
  }
}
async function requireSubscription(ctx, user) {
  const ok = await checkSubscription(user.telegram_id);
  if (!ok) {
    await pool.query(`UPDATE users SET is_subscribed = FALSE, updated_at = NOW() WHERE telegram_id = $1`, [String(user.telegram_id)]);
    await ctx.reply("⚠️ لازم تشترك بالقناة أولاً حتى تستخدم البوت.", forceSubKeyboard());
    return false;
  }
  if (!user.is_subscribed) await pool.query(`UPDATE users SET is_subscribed = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [String(user.telegram_id)]);
  return true;
}
async function requireVerification(ctx, user) {
  if (user.is_verified) return true;
  const s = getSession(ctx.from.id);
  if (!s.captcha) s.captcha = randomCaptcha();
  await ctx.reply(`🤖 تحقق أنك إنسان.\n\n${s.captcha.question}`);
  return false;
}

async function registerReferral(startPayload, newUserTelegramId) {
  const inviterTelegramId = parseReferral(startPayload);
  if (!inviterTelegramId || Number(inviterTelegramId) === Number(newUserTelegramId)) return;
  const newUser = await getUserByTelegramId(newUserTelegramId);
  if (!newUser || newUser.referred_by) return;
  const inviter = await getUserByTelegramId(inviterTelegramId);
  if (!inviter) return;
  await pool.query(`UPDATE users SET referred_by = $2, updated_at = NOW() WHERE telegram_id = $1 AND referred_by IS NULL`, [String(newUserTelegramId), String(inviterTelegramId)]);
  await pool.query(`INSERT INTO referrals (inviter_telegram_id, invited_telegram_id, is_counted) VALUES ($1, $2, FALSE) ON CONFLICT (invited_telegram_id) DO NOTHING`, [String(inviterTelegramId), String(newUserTelegramId)]);
}

async function grantReferralIfEligible(invitedTelegramId) {
  const user = await getUserByTelegramId(invitedTelegramId);
  if (!user || !user.referred_by || !user.is_verified || !user.is_subscribed) return;
  const refRow = await pool.query(`SELECT * FROM referrals WHERE invited_telegram_id = $1`, [String(invitedTelegramId)]);
  const ref = refRow.rows[0];
  if (!ref || ref.is_counted) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE referrals SET is_counted = TRUE WHERE invited_telegram_id = $1`, [String(invitedTelegramId)]);
    const updatedInviter = await client.query(`UPDATE users SET referrals_count = referrals_count + 1, updated_at = NOW() WHERE telegram_id = $1 RETURNING *`, [String(user.referred_by)]);
    const inviter = updatedInviter.rows[0];
    if (REFERRAL_REWARD_PRODUCT_SLUG && inviter && !inviter.referral_rewarded && Number(inviter.referrals_count) >= REFERRAL_TARGET) {
      const productRes = await client.query(`SELECT * FROM products WHERE slug = $1 AND is_active = TRUE LIMIT 1`, [REFERRAL_REWARD_PRODUCT_SLUG]);
      const product = productRes.rows[0];
      if (product) {
        const codeRes = await client.query(`SELECT * FROM product_codes WHERE product_id = $1 AND is_sold = FALSE ORDER BY id ASC LIMIT 1 FOR UPDATE`, [product.id]);
        const code = codeRes.rows[0];
        if (code) {
          const orderRes = await client.query(`INSERT INTO orders (telegram_id, product_id, quantity, total_price, status) VALUES ($1, $2, 1, 0, 'referral_reward') RETURNING *`, [String(inviter.telegram_id), product.id]);
          const order = orderRes.rows[0];
          await client.query(`UPDATE product_codes SET is_sold = TRUE, sold_to_telegram_id = $2, sold_at = NOW() WHERE id = $1`, [code.id, String(inviter.telegram_id)]);
          await client.query(`INSERT INTO order_items (order_id, product_code_id, code_value) VALUES ($1, $2, $3)`, [order.id, code.id, code.code_value]);
          await client.query(`UPDATE users SET referral_rewarded = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [String(inviter.telegram_id)]);
          try { await bot.telegram.sendMessage(Number(inviter.telegram_id), `🎉 مبروك، وصلت ${REFERRAL_TARGET} دعوات واستلمت كود مجاني من ${product.name}\n\nالكود:\n${code.code_value}`); } catch (e) { console.error("Reward notify error:", e); }
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Referral reward error:", e);
  } finally {
    client.release();
  }
}

async function getProducts() { const res = await pool.query(`SELECT * FROM products WHERE is_active = TRUE ORDER BY id ASC`); return res.rows; }
async function getProductStock(productId) { const res = await pool.query(`SELECT COUNT(*)::int AS count FROM product_codes WHERE product_id = $1 AND is_sold = FALSE`, [productId]); return res.rows[0]?.count || 0; }
async function productsKeyboard() {
  const products = await getProducts();
  const rows = [];
  for (const p of products) { const stock = await getProductStock(p.id); rows.push([Markup.button.callback(`${p.name} (${stock})`, `VIEW_PRODUCT:${p.id}`)]); }
  return Markup.inlineKeyboard(rows);
}
async function listProductsText() {
  const products = await getProducts();
  if (!products.length) return "لا توجد منتجات حالياً.";
  const lines = [];
  for (const p of products) { const stock = await getProductStock(p.id); lines.push(`• ${p.name}\nالسعر: ${money(p.price_usd)}\nالمتوفر: ${stock}`); }
  return lines.join("\n\n");
}

async function gate(ctx) {
  const user = await ensureUser(ctx);
  const subOk = await requireSubscription(ctx, user);
  if (!subOk) return { ok: false, user };
  const fresh = await getUserByTelegramId(user.telegram_id);
  if (!fresh.is_verified) {
    const s = getSession(ctx.from.id);
    if (!s.captcha) s.captcha = randomCaptcha();
    await ctx.reply(`🤖 جاوب على السؤال حتى تكمل:\n${s.captcha.question}`);
    return { ok: false, user: fresh };
  }
  return { ok: true, user: fresh };
}
async function showMainMenu(ctx) { await ctx.reply("أهلاً بك في المتجر ✅", isAdmin(ctx.from.id) ? adminKeyboard() : mainKeyboard()); }

bot.start(async (ctx) => {
  const payload = ctx.message.text.split(" ").slice(1).join(" ").trim();
  const user = await ensureUser(ctx);
  await registerReferral(payload, user.telegram_id);
  if (!(await requireSubscription(ctx, user))) return;
  const fresh = await getUserByTelegramId(user.telegram_id);
  if (!(await requireVerification(ctx, fresh))) return;
  await grantReferralIfEligible(user.telegram_id);
  await showMainMenu(ctx);
});

bot.action("CHECK_SUB", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx);
  if (!(await requireSubscription(ctx, user))) return;
  const fresh = await getUserByTelegramId(user.telegram_id);
  if (!(await requireVerification(ctx, fresh))) return;
  await ctx.reply("✅ تم التحقق من الاشتراك.");
  await grantReferralIfEligible(user.telegram_id);
  await showMainMenu(ctx);
});

bot.hears("🛍 المتجر", async (ctx) => {
  const guard = await gate(ctx); if (!guard.ok) return;
  await ctx.reply(await listProductsText(), await productsKeyboard());
});
bot.action(/^VIEW_PRODUCT:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const guard = await gate(ctx); if (!guard.ok) return;
  const productId = Number(ctx.match[1]);
  const res = await pool.query(`SELECT * FROM products WHERE id = $1 AND is_active = TRUE`, [productId]);
  const product = res.rows[0];
  if (!product) return ctx.reply("المنتج غير متوفر حالياً.");
  const stock = await getProductStock(product.id);
  await ctx.reply(`🛒 ${product.name}\nالسعر: ${money(product.price_usd)}\nالمتوفر: ${stock}\nالوصف: ${product.description || "بدون وصف"}\n\nاضغط شراء ثم أرسل الكمية.`, Markup.inlineKeyboard([[Markup.button.callback("شراء", `BUY_PRODUCT:${product.id}`)]]));
});
bot.action(/^BUY_PRODUCT:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const guard = await gate(ctx); if (!guard.ok) return;
  const s = getSession(ctx.from.id); s.mode = "await_buy_quantity"; s.productId = Number(ctx.match[1]);
  await ctx.reply("أرسل الكمية المطلوبة. مثال: 1 أو 2 أو 3");
});
bot.hears("💰 محفظتي", async (ctx) => {
  const guard = await gate(ctx); if (!guard.ok) return;
  await ctx.reply(`💰 رصيدك: ${money(guard.user.balance_usd)}\n⭐ نقاطك: ${guard.user.points}\n👥 دعواتك: ${guard.user.referrals_count}`);
});
bot.hears("🎁 دعواتي", async (ctx) => {
  const guard = await gate(ctx); if (!guard.ok) return;
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=u${guard.user.telegram_id}`;
  const remaining = Math.max(REFERRAL_TARGET - Number(guard.user.referrals_count), 0);
  await ctx.reply(`🎁 رابط دعوتك:\n${link}\n\nعدد الدعوات المحتسبة: ${guard.user.referrals_count}\nالمتبقي للمكافأة: ${remaining}`);
});
bot.hears("📦 طلباتي", async (ctx) => {
  const guard = await gate(ctx); if (!guard.ok) return;
  const res = await pool.query(`SELECT o.*, p.name AS product_name FROM orders o JOIN products p ON p.id = o.product_id WHERE o.telegram_id = $1 ORDER BY o.id DESC LIMIT 10`, [String(guard.user.telegram_id)]);
  if (!res.rows.length) return ctx.reply("ما عندك طلبات بعد.");
  await ctx.reply(res.rows.map(o => `#${o.id} - ${o.product_name}\nالكمية: ${o.quantity}\nالمبلغ: ${money(o.total_price)}\nالحالة: ${o.status}`).join("\n\n"));
});
bot.hears("✅ تحقق الاشتراك", async (ctx) => { const user = await ensureUser(ctx); if (!(await requireSubscription(ctx, user))) return; await ctx.reply("✅ اشتراكك بالقناة صحيح."); });

bot.command("admin", async (ctx) => { if (!isAdmin(ctx.from.id)) return; await ctx.reply("لوحة المدير", adminKeyboard()); });
bot.hears("➕ إضافة منتج", async (ctx) => { if (!isAdmin(ctx.from.id)) return; const s = getSession(ctx.from.id); s.mode = "admin_add_product_name"; s.productDraft = {}; await ctx.reply("أرسل اسم المنتج."); });
bot.hears("📥 رفع أكواد", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const products = await getProducts();
  if (!products.length) return ctx.reply("ماكو منتجات. أضف منتج أولاً.");
  await ctx.reply("اختر المنتج الذي تريد رفع الأكواد له:", Markup.inlineKeyboard(products.map(p => [Markup.button.callback(p.name, `ADMIN_UPLOAD_CODES:${p.id}`)])));
});
bot.action(/^ADMIN_UPLOAD_CODES:(\d+)$/, async (ctx) => { if (!isAdmin(ctx.from.id)) return; await ctx.answerCbQuery(); const s = getSession(ctx.from.id); s.mode = "admin_upload_codes_wait_file"; s.productId = Number(ctx.match[1]); await ctx.reply("أرسل الآن ملف TXT، وكل سطر داخل الملف = كود واحد."); });
bot.hears("💵 شحن رصيد", async (ctx) => { if (!isAdmin(ctx.from.id)) return; const s = getSession(ctx.from.id); s.mode = "admin_charge_user_id"; await ctx.reply("أرسل آيدي المستخدم في تيليجرام كرقم فقط."); });
bot.hears("📊 المخزون", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const res = await pool.query(`SELECT * FROM products ORDER BY id ASC`);
  if (!res.rows.length) return ctx.reply("ماكو منتجات.");
  const lines = [];
  for (const p of res.rows) {
    const availableRes = await pool.query(`SELECT COUNT(*)::int AS count FROM product_codes WHERE product_id = $1 AND is_sold = FALSE`, [p.id]);
    const soldRes = await pool.query(`SELECT COUNT(*)::int AS count FROM product_codes WHERE product_id = $1 AND is_sold = TRUE`, [p.id]);
    lines.push(`• ${p.name}\nالسعر: ${money(p.price_usd)}\nمتوفر: ${availableRes.rows[0].count}\nمباع: ${soldRes.rows[0].count}\nالحالة: ${p.is_active ? "مفعل" : "موقف"}`);
  }
  await ctx.reply(lines.join("\n\n"));
});
bot.hears("👥 المستخدمين", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const total = await pool.query(`SELECT COUNT(*)::int AS count FROM users`);
  const verified = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE is_verified = TRUE`);
  const subscribed = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE is_subscribed = TRUE`);
  await ctx.reply(`إجمالي المستخدمين: ${total.rows[0].count}\nالمتحققين: ${verified.rows[0].count}\nالمشتركين: ${subscribed.rows[0].count}`);
});

bot.on("document", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const s = getSession(ctx.from.id);
  if (s.mode !== "admin_upload_codes_wait_file" || !s.productId) return;
  const doc = ctx.message.document;
  const fileName = doc.file_name || "";
  if (!fileName.toLowerCase().endsWith(".txt")) return ctx.reply("أرسل ملف TXT فقط.");
  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await fetch(fileLink.href);
    const content = await response.text();
    const lines = content.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) return ctx.reply("الملف فارغ.");
    let added = 0, duplicates = 0;
    for (const code of lines) {
      try { await pool.query(`INSERT INTO product_codes (product_id, code_value) VALUES ($1, $2)`, [s.productId, code]); added++; }
      catch { duplicates++; }
    }
    clearSession(ctx.from.id);
    await ctx.reply(`✅ تم رفع الأكواد.\nالمضاف: ${added}\nالمكرر: ${duplicates}`);
  } catch (error) {
    console.error("TXT upload error:", error);
    await ctx.reply("صار خطأ أثناء قراءة الملف.");
  }
});

bot.on("text", async (ctx, next) => {
  if (ctx.message.text.startsWith("/")) return next();
  const user = await ensureUser(ctx);
  const s = getSession(ctx.from.id);
  const text = ctx.message.text.trim();

  if (!user.is_verified) {
    if (!s.captcha) s.captcha = randomCaptcha();
    const answer = Number(text);
    if (Number.isNaN(answer)) return ctx.reply(`جاوب برقم فقط:\n${s.captcha.question}`);
    if (answer !== s.captcha.answer) { s.captcha = randomCaptcha(); return ctx.reply(`إجابة خطأ. حاول مرة ثانية:\n${s.captcha.question}`); }
    await pool.query(`UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [String(user.telegram_id)]);
    delete s.captcha;
    await ctx.reply("✅ تم التحقق من أنك إنسان.");
    await grantReferralIfEligible(user.telegram_id);
    return showMainMenu(ctx);
  }

  if (s.mode === "await_buy_quantity" && s.productId) {
    const qty = Number(text);
    if (!Number.isInteger(qty) || qty <= 0) return ctx.reply("أرسل كمية صحيحة كرقم أكبر من صفر.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const productRes = await client.query(`SELECT * FROM products WHERE id = $1 AND is_active = TRUE`, [s.productId]);
      const product = productRes.rows[0];
      if (!product) throw new Error("المنتج غير متوفر الآن.");
      const freshUserRes = await client.query(`SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE`, [String(user.telegram_id)]);
      const freshUser = freshUserRes.rows[0];
      const stockRes = await client.query(`SELECT * FROM product_codes WHERE product_id = $1 AND is_sold = FALSE ORDER BY id ASC LIMIT $2 FOR UPDATE`, [product.id, qty]);
      const codes = stockRes.rows;
      if (codes.length < qty) throw new Error(`الكمية غير متوفرة. المتاح حالياً: ${codes.length}`);
      const total = Number(product.price_usd) * qty;
      if (Number(freshUser.balance_usd) < total) throw new Error(`رصيدك غير كافٍ. المطلوب ${money(total)} ورصيدك ${money(freshUser.balance_usd)}`);
      const orderRes = await client.query(`INSERT INTO orders (telegram_id, product_id, quantity, total_price, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING *`, [String(user.telegram_id), product.id, qty, total]);
      const order = orderRes.rows[0];
      await client.query(`UPDATE users SET balance_usd = balance_usd - $2, updated_at = NOW() WHERE telegram_id = $1`, [String(user.telegram_id), total]);
      await client.query(`INSERT INTO wallet_transactions (telegram_id, type, amount, reason) VALUES ($1, 'purchase', $2, $3)`, [String(user.telegram_id), -total, `شراء ${qty} من ${product.name}`]);
      for (const code of codes) {
        await client.query(`UPDATE product_codes SET is_sold = TRUE, sold_to_telegram_id = $2, sold_at = NOW() WHERE id = $1`, [code.id, String(user.telegram_id)]);
        await client.query(`INSERT INTO order_items (order_id, product_code_id, code_value) VALUES ($1, $2, $3)`, [order.id, code.id, code.code_value]);
      }
      await client.query("COMMIT");
      clearSession(ctx.from.id);
      await ctx.reply(`✅ تم شراء ${qty} من ${product.name}\nرقم الطلب: #${order.id}\nالمبلغ: ${money(total)}\n\nالأكواد:\n${codes.map(c => c.code_value).join("\n")}`);
    } catch (error) {
      await client.query("ROLLBACK");
      await ctx.reply(error.message || "صار خطأ أثناء تنفيذ الطلب.");
    } finally {
      client.release();
    }
    return;
  }

  if (isAdmin(ctx.from.id) && s.mode === "admin_add_product_name") { s.productDraft = { name: text }; s.mode = "admin_add_product_price"; return ctx.reply("أرسل السعر بالدولار. مثال: 5 أو 9.99"); }
  if (isAdmin(ctx.from.id) && s.mode === "admin_add_product_price") {
    const price = Number(text);
    if (Number.isNaN(price) || price <= 0) return ctx.reply("أرسل سعر صحيح.");
    s.productDraft.priceUsd = price; s.mode = "admin_add_product_description";
    return ctx.reply("أرسل وصف المنتج، أو اكتب 0 إذا ما تريد وصف.");
  }
  if (isAdmin(ctx.from.id) && s.mode === "admin_add_product_description") {
    const draft = s.productDraft || {};
    const name = draft.name, priceUsd = draft.priceUsd;
    const description = text === "0" ? null : text;
    const slug = slugify(name);
    try {
      const res = await pool.query(`INSERT INTO products (name, slug, description, price_usd) VALUES ($1, $2, $3, $4) RETURNING *`, [name, slug, description, priceUsd]);
      clearSession(ctx.from.id);
      const product = res.rows[0];
      return ctx.reply(`✅ تم إنشاء المنتج:\n${product.name}\nSlug: ${product.slug}\nالسعر: ${money(product.price_usd)}`);
    } catch { return ctx.reply("تعذر إنشاء المنتج. ربما الاسم مكرر."); }
  }
  if (isAdmin(ctx.from.id) && s.mode === "admin_charge_user_id") {
    const targetTelegramId = Number(text);
    if (!targetTelegramId) return ctx.reply("أرسل آيدي صحيح.");
    s.chargeTargetTelegramId = targetTelegramId; s.mode = "admin_charge_amount";
    return ctx.reply("أرسل مبلغ الشحن بالدولار. مثال: 10");
  }
  if (isAdmin(ctx.from.id) && s.mode === "admin_charge_amount") {
    const amount = Number(text);
    if (Number.isNaN(amount) || amount <= 0) return ctx.reply("أرسل مبلغ صحيح.");
    const target = await getUserByTelegramId(s.chargeTargetTelegramId);
    if (!target) { clearSession(ctx.from.id); return ctx.reply("المستخدم غير موجود. لازم يدخل البوت أولاً."); }
    await pool.query(`UPDATE users SET balance_usd = balance_usd + $2, updated_at = NOW() WHERE telegram_id = $1`, [String(target.telegram_id), amount]);
    await pool.query(`INSERT INTO wallet_transactions (telegram_id, type, amount, reason) VALUES ($1, 'admin_charge', $2, $3)`, [String(target.telegram_id), amount, `شحن من المدير ${ctx.from.id}`]);
    clearSession(ctx.from.id);
    try { await bot.telegram.sendMessage(Number(target.telegram_id), `💵 تم شحن رصيدك بمبلغ ${money(amount)}`); } catch {}
    return ctx.reply("✅ تم شحن الرصيد بنجاح.");
  }
  return next();
});

app.get("/", (_req, res) => { res.status(200).json({ ok: true, service: "telegram-store-bot", mode: "polling" }); });
app.get("/health", (_req, res) => { res.status(200).send("OK"); });

async function startApp() {
  try {
    await initDb();
    await bot.launch();
    console.log("Telegram bot started");
    app.listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));
    process.once("SIGINT", async () => { await bot.stop("SIGINT"); await pool.end(); process.exit(0); });
    process.once("SIGTERM", async () => { await bot.stop("SIGTERM"); await pool.end(); process.exit(0); });
  } catch (error) {
    console.error("Failed to start app:", error);
    process.exit(1);
  }
}
bot.catch((err) => console.error("BOT ERROR:", err));
startApp();
