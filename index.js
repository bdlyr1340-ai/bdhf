import express from "express";
import { Telegraf, Markup } from "telegraf";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { getSession, clearSession } from "./session.js";
import {
  adminKeyboard,
  forceSubKeyboard,
  isAdmin,
  mainKeyboard,
  money,
  randomCaptcha,
  slugify,
} from "./utils.js";
import fs from "fs/promises";

const bot = new Telegraf(config.BOT_TOKEN);
const app = express();
app.use(express.json());

async function ensureUser(ctx) {
  const tgUser = ctx.from;
  const telegramId = BigInt(tgUser.id);

  let user = await prisma.user.findUnique({ where: { telegramId } });

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        fullName: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" "),
        username: tgUser.username || null,
        balanceUsd: config.START_BONUS_USD,
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        fullName: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" "),
        username: tgUser.username || null,
      },
    });
  }

  return user;
}

function getChannelTarget() {
  return config.CHANNEL_ID || config.CHANNEL_USERNAME;
}

async function checkSubscription(userTelegramId) {
  const target = getChannelTarget();
  if (!target) return true;
  try {
    const member = await bot.telegram.getChatMember(target, Number(userTelegramId));
    const allowed = ["creator", "administrator", "member"];
    return allowed.includes(member.status);
  } catch (error) {
    console.error("checkSubscription error:", error?.description || error?.message || error);
    return false;
  }
}

async function requireSubscription(ctx, user) {
  const ok = await checkSubscription(user.telegramId);
  if (!ok) {
    await prisma.user.update({
      where: { id: user.id },
      data: { isSubscribed: false },
    });

    await ctx.reply(
      "⚠️ لازم تشترك بالقناة أولاً حتى تقدر تستخدم البوت.",
      forceSubKeyboard()
    );
    return false;
  }

  if (!user.isSubscribed) {
    await prisma.user.update({
      where: { id: user.id },
      data: { isSubscribed: true },
    });
  }

  return true;
}

async function requireVerification(ctx, user) {
  if (user.isVerified) return true;
  const session = getSession(ctx.from.id);
  if (!session.captcha) {
    session.captcha = randomCaptcha();
  }
  await ctx.reply(`🤖 تحقق أنك إنسان.\n\n${session.captcha.question}`);
  return false;
}

async function grantReferralIfEligible(userId) {
  const invitedUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!invitedUser || !invitedUser.referredById || !invitedUser.isSubscribed || !invitedUser.isVerified) return;

  const existing = await prisma.referral.findUnique({
    where: { invitedUserId: invitedUser.id },
  });

  if (existing?.isCounted) return;

  const inviter = await prisma.user.findUnique({ where: { id: invitedUser.referredById } });
  if (!inviter) return;

  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.referral.update({
        where: { id: existing.id },
        data: { isCounted: true },
      });
    } else {
      await tx.referral.create({
        data: {
          inviterUserId: inviter.id,
          invitedUserId: invitedUser.id,
          isCounted: true,
        },
      });
    }

    const updatedInviter = await tx.user.update({
      where: { id: inviter.id },
      data: { referralsCount: { increment: 1 } },
    });

    const rewardSlug = config.REFERRAL_REWARD_PRODUCT_SLUG;
    if (
      rewardSlug &&
      !updatedInviter.referralRewarded &&
      updatedInviter.referralsCount >= config.REFERRAL_TARGET
    ) {
      const product = await tx.product.findUnique({ where: { slug: rewardSlug } });
      if (product) {
        const code = await tx.productCode.findFirst({
          where: { productId: product.id, isSold: false },
          orderBy: { id: "asc" },
        });

        if (code) {
          const order = await tx.order.create({
            data: {
              userId: inviter.id,
              productId: product.id,
              quantity: 1,
              totalPrice: 0,
              status: "referral_reward",
            },
          });

          await tx.orderItem.create({
            data: {
              orderId: order.id,
              productCodeId: code.id,
              codeValue: code.codeValue,
            },
          });

          await tx.productCode.update({
            where: { id: code.id },
            data: {
              isSold: true,
              soldToUserId: inviter.id,
              soldAt: new Date(),
            },
          });

          await tx.user.update({
            where: { id: inviter.id },
            data: { referralRewarded: true },
          });

          try {
            await bot.telegram.sendMessage(
              Number(inviter.telegramId),
              `🎉 مبروك! وصلت ${config.REFERRAL_TARGET} دعوات واستلمت كود مجاني من ${product.name}\n\nالكود:\n${code.codeValue}`
            );
          } catch (e) {
            console.error("Failed to notify inviter reward:", e?.message || e);
          }
        }
      }
    }
  });
}

async function showMainMenu(ctx, user) {
  let text = "أهلاً بك في المتجر ✅";
  if (isAdmin(ctx.from.id)) {
    text += "\n\nأنت مدير، ويمكنك استخدام لوحة الإدارة أيضاً.";
  }
  const keyboard = isAdmin(ctx.from.id) ? adminKeyboard() : mainKeyboard();
  await ctx.reply(text, keyboard);
}

function parseReferral(startText = "") {
  const match = String(startText).match(/u(\d+)/);
  return match ? Number(match[1]) : null;
}

bot.start(async (ctx) => {
  const startPayload = ctx.message.text.split(" ").slice(1).join(" ").trim();
  let user = await ensureUser(ctx);

  const refTelegramId = parseReferral(startPayload);
  if (refTelegramId && refTelegramId !== Number(user.telegramId) && !user.referredById) {
    const inviter = await prisma.user.findUnique({
      where: { telegramId: BigInt(refTelegramId) },
    });
    if (inviter && inviter.id !== user.id) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { referredById: inviter.id },
      });
    }
  }

  const subOk = await requireSubscription(ctx, user);
  if (!subOk) return;

  user = await prisma.user.findUnique({ where: { id: user.id } });
  const verified = await requireVerification(ctx, user);
  if (!verified) return;

  await grantReferralIfEligible(user.id);
  await showMainMenu(ctx, user);
});

bot.action("CHECK_SUB", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await ensureUser(ctx);
  const ok = await requireSubscription(ctx, user);
  if (!ok) return;
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  const verified = await requireVerification(ctx, fresh);
  if (!verified) return;
  await grantReferralIfEligible(user.id);
  await ctx.reply("✅ تم التحقق من الاشتراك.");
  await showMainMenu(ctx, fresh);
});

async function gate(ctx) {
  const user = await ensureUser(ctx);
  const subOk = await requireSubscription(ctx, user);
  if (!subOk) return { ok: false, user };
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  if (!fresh.isVerified) {
    const session = getSession(ctx.from.id);
    if (!session.captcha) session.captcha = randomCaptcha();
    await ctx.reply(`🤖 جاوب على السؤال حتى تكمل:\n${session.captcha.question}`);
    return { ok: false, user: fresh };
  }
  return { ok: true, user: fresh };
}

async function listProductsText() {
  const products = await prisma.product.findMany({
    orderBy: { id: "asc" },
    where: { isActive: true },
  });

  if (!products.length) return "لا توجد منتجات حالياً.";

  const lines = [];
  for (const product of products) {
    const stock = await prisma.productCode.count({
      where: { productId: product.id, isSold: false },
    });
    lines.push(`• ${product.name}\nالسعر: ${money(product.priceUsd)}\nالمتوفر: ${stock}`);
  }
  return lines.join("\n\n");
}

async function productsKeyboard() {
  const products = await prisma.product.findMany({
    orderBy: { id: "asc" },
    where: { isActive: true },
  });

  const rows = [];
  for (const product of products) {
    const stock = await prisma.productCode.count({
      where: { productId: product.id, isSold: false },
    });
    rows.push([
      Markup.button.callback(
        `${product.name} (${stock})`,
        `VIEW_PRODUCT:${product.id}`
      ),
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

bot.hears("🛍 المتجر", async (ctx) => {
  const guard = await gate(ctx);
  if (!guard.ok) return;
  const text = await listProductsText();
  const kb = await productsKeyboard();
  await ctx.reply(text, kb);
});

bot.action(/^VIEW_PRODUCT:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const guard = await gate(ctx);
  if (!guard.ok) return;

  const productId = Number(ctx.match[1]);
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) {
    return ctx.reply("المنتج غير متوفر حالياً.");
  }

  const stock = await prisma.productCode.count({
    where: { productId: product.id, isSold: false },
  });

  const text =
    `🛒 ${product.name}\n` +
    `السعر: ${money(product.priceUsd)}\n` +
    `المتوفر: ${stock}\n` +
    `الوصف: ${product.description || "بدون وصف"}\n\n` +
    `أرسل الكمية الآن كرقم فقط بعد الضغط على زر الشراء.`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("شراء", `BUY_PRODUCT:${product.id}`)],
  ]);

  await ctx.reply(text, kb);
});

bot.action(/^BUY_PRODUCT:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const guard = await gate(ctx);
  if (!guard.ok) return;
  const productId = Number(ctx.match[1]);
  const session = getSession(ctx.from.id);
  session.mode = "await_buy_quantity";
  session.productId = productId;
  await ctx.reply("أرسل الكمية المطلوبة الآن. مثال: 1 أو 2 أو 3");
});

bot.hears("💰 محفظتي", async (ctx) => {
  const guard = await gate(ctx);
  if (!guard.ok) return;
  const user = guard.user;
  await ctx.reply(
    `💰 رصيدك: ${money(user.balanceUsd)}\n⭐ نقاطك: ${user.points}\n👥 دعواتك: ${user.referralsCount}`
  );
});

bot.hears("🎁 دعواتي", async (ctx) => {
  const guard = await gate(ctx);
  if (!guard.ok) return;
  const user = guard.user;
  const username = (await bot.telegram.getMe()).username;
  const link = `https://t.me/${username}?start=u${user.telegramId}`;
  const remaining = Math.max(config.REFERRAL_TARGET - user.referralsCount, 0);
  await ctx.reply(
    `🎁 رابط دعوتك:\n${link}\n\n` +
      `عدد الدعوات المحتسبة: ${user.referralsCount}\n` +
      `المتبقي للمكافأة: ${remaining}`
  );
});

bot.hears("📦 طلباتي", async (ctx) => {
  const guard = await gate(ctx);
  if (!guard.ok) return;

  const orders = await prisma.order.findMany({
    where: { userId: guard.user.id },
    orderBy: { id: "desc" },
    take: 10,
    include: { product: true, items: true },
  });

  if (!orders.length) {
    return ctx.reply("ما عندك طلبات بعد.");
  }

  const text = orders
    .map(
      (o) =>
        `#${o.id} - ${o.product.name}\nالكمية: ${o.quantity}\nالمبلغ: ${money(o.totalPrice)}\nالحالة: ${o.status}\nالأكواد: ${o.items.length}`
    )
    .join("\n\n");

  await ctx.reply(text);
});

bot.hears("✅ تحقق الاشتراك", async (ctx) => {
  const user = await ensureUser(ctx);
  const ok = await requireSubscription(ctx, user);
  if (!ok) return;
  await ctx.reply("✅ اشتراكك بالقناة صحيح.");
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply("لوحة المدير", adminKeyboard());
});

bot.hears("➕ إضافة منتج", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const session = getSession(ctx.from.id);
  session.mode = "admin_add_product_name";
  session.productDraft = {};
  await ctx.reply("أرسل اسم المنتج الجديد.");
});

bot.hears("📥 رفع أكواد", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const products = await prisma.product.findMany({ orderBy: { id: "asc" } });
  if (!products.length) return ctx.reply("ماكو منتجات حالياً. أضف منتج أولاً.");

  const rows = products.map((p) => [
    Markup.button.callback(p.name, `ADMIN_UPLOAD_CODES:${p.id}`),
  ]);
  await ctx.reply("اختر المنتج الذي تريد رفع الأكواد له:", Markup.inlineKeyboard(rows));
});

bot.action(/^ADMIN_UPLOAD_CODES:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const session = getSession(ctx.from.id);
  session.mode = "admin_upload_codes_wait_file";
  session.productId = productId;
  await ctx.reply("أرسل الآن ملف TXT، وكل سطر داخل الملف = كود واحد.");
});

bot.hears("💵 شحن رصيد", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const session = getSession(ctx.from.id);
  session.mode = "admin_charge_user_id";
  await ctx.reply("أرسل آيدي المستخدم في تيليجرام (رقم فقط).");
});

bot.hears("📊 المخزون", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const products = await prisma.product.findMany({ orderBy: { id: "asc" } });
  if (!products.length) return ctx.reply("ماكو منتجات.");

  const lines = [];
  for (const product of products) {
    const available = await prisma.productCode.count({
      where: { productId: product.id, isSold: false },
    });
    const sold = await prisma.productCode.count({
      where: { productId: product.id, isSold: true },
    });
    lines.push(
      `• ${product.name}\nالسعر: ${money(product.priceUsd)}\nمتوفر: ${available}\nمباع: ${sold}\nالحالة: ${product.isActive ? "مفعل" : "موقف"}`
    );
  }

  await ctx.reply(lines.join("\n\n"));
});

bot.hears("👥 المستخدمين", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const total = await prisma.user.count();
  const verified = await prisma.user.count({ where: { isVerified: true } });
  const subscribed = await prisma.user.count({ where: { isSubscribed: true } });
  await ctx.reply(`إجمالي المستخدمين: ${total}\nالمتحققين: ${verified}\nالمشتركين: ${subscribed}`);
});

bot.on("document", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const session = getSession(ctx.from.id);
  if (session.mode !== "admin_upload_codes_wait_file" || !session.productId) return;

  const doc = ctx.message.document;
  const fileName = doc.file_name || "";
  if (!fileName.toLowerCase().endsWith(".txt")) {
    return ctx.reply("أرسل ملف TXT فقط.");
  }

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const response = await fetch(link.href);
    const content = await response.text();

    const lines = content
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);

    if (!lines.length) {
      return ctx.reply("الملف فارغ.");
    }

    let added = 0;
    let duplicates = 0;

    for (const code of lines) {
      try {
        await prisma.productCode.create({
          data: {
            productId: session.productId,
            codeValue: code,
          },
        });
        added++;
      } catch {
        duplicates++;
      }
    }

    clearSession(ctx.from.id);
    await ctx.reply(`✅ تم رفع الأكواد.\nالمضاف: ${added}\nالمكرر: ${duplicates}`);
  } catch (error) {
    console.error("upload codes error:", error);
    await ctx.reply("صار خطأ أثناء قراءة الملف.");
  }
});

bot.on("text", async (ctx, next) => {
  if (ctx.message.text.startsWith("/")) return next();

  const user = await ensureUser(ctx);
  const session = getSession(ctx.from.id);
  const text = ctx.message.text.trim();

  if (!user.isVerified) {
    if (!session.captcha) session.captcha = randomCaptcha();

    const answer = Number(text);
    if (Number.isNaN(answer)) {
      return ctx.reply(`جاوب برقم فقط:\n${session.captcha.question}`);
    }

    if (answer !== session.captcha.answer) {
      session.captcha = randomCaptcha();
      return ctx.reply(`إجابة خطأ. حاول مرة ثانية:\n${session.captcha.question}`);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true },
    });

    delete session.captcha;
    await ctx.reply("✅ تم التحقق من أنك إنسان.");
    await grantReferralIfEligible(user.id);
    return showMainMenu(ctx, user);
  }

  if (session.mode === "await_buy_quantity" && session.productId) {
    const qty = Number(text);
    if (!Number.isInteger(qty) || qty <= 0) {
      return ctx.reply("أرسل كمية صحيحة كرقم أكبر من صفر.");
    }

    const product = await prisma.product.findUnique({ where: { id: session.productId } });
    if (!product || !product.isActive) {
      clearSession(ctx.from.id);
      return ctx.reply("المنتج غير متوفر الآن.");
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const freshUser = await tx.user.findUnique({ where: { id: user.id } });
        const stockCount = await tx.productCode.count({
          where: { productId: product.id, isSold: false },
        });

        const total = Number(product.priceUsd) * qty;

        if (stockCount < qty) {
          throw new Error(`الكمية غير متوفرة. المتاح حالياً: ${stockCount}`);
        }

        if (Number(freshUser.balanceUsd) < total) {
          throw new Error(`رصيدك غير كافٍ. المطلوب ${money(total)} ورصيدك ${money(freshUser.balanceUsd)}`);
        }

        const codes = await tx.productCode.findMany({
          where: { productId: product.id, isSold: false },
          orderBy: { id: "asc" },
          take: qty,
        });

        const order = await tx.order.create({
          data: {
            userId: user.id,
            productId: product.id,
            quantity: qty,
            totalPrice: total,
            status: "completed",
          },
        });

        await tx.user.update({
          where: { id: user.id },
          data: {
            balanceUsd: { decrement: total },
          },
        });

        await tx.walletTransaction.create({
          data: {
            userId: user.id,
            type: "purchase",
            amount: -total,
            reason: `شراء ${qty} من ${product.name}`,
          },
        });

        for (const code of codes) {
          await tx.productCode.update({
            where: { id: code.id },
            data: {
              isSold: true,
              soldToUserId: user.id,
              soldAt: new Date(),
            },
          });

          await tx.orderItem.create({
            data: {
              orderId: order.id,
              productCodeId: code.id,
              codeValue: code.codeValue,
            },
          });
        }

        return { orderId: order.id, codes: codes.map((c) => c.codeValue), total };
      });

      clearSession(ctx.from.id);
      await ctx.reply(
        `✅ تم شراء ${qty} من ${product.name}\nرقم الطلب: #${result.orderId}\nالمبلغ: ${money(result.total)}\n\nالأكواد:\n${result.codes.join("\n")}`
      );
    } catch (error) {
      await ctx.reply(error.message || "صار خطأ أثناء تنفيذ الطلب.");
    }

    return;
  }

  if (isAdmin(ctx.from.id) && session.mode === "admin_add_product_name") {
    session.productDraft = { name: text };
    session.mode = "admin_add_product_price";
    return ctx.reply("أرسل السعر بالدولار. مثال: 5 أو 9.99");
  }

  if (isAdmin(ctx.from.id) && session.mode === "admin_add_product_price") {
    const price = Number(text);
    if (Number.isNaN(price) || price <= 0) {
      return ctx.reply("أرسل سعر صحيح.");
    }
    session.productDraft.priceUsd = price;
    session.mode = "admin_add_product_description";
    return ctx.reply("أرسل وصف المنتج، أو اكتب 0 إذا ما تريد وصف.");
  }

  if (isAdmin(ctx.from.id) && session.mode === "admin_add_product_description") {
    const draft = session.productDraft || {};
    const name = draft.name;
    const priceUsd = draft.priceUsd;
    const description = text === "0" ? null : text;
    const slug = slugify(name);

    try {
      const product = await prisma.product.create({
        data: { name, slug, priceUsd, description },
      });
      clearSession(ctx.from.id);
      return ctx.reply(`✅ تم إنشاء المنتج:\n${product.name}\nSlug: ${product.slug}\nالسعر: ${money(product.priceUsd)}`);
    } catch (error) {
      console.error(error);
      return ctx.reply("تعذر إنشاء المنتج. ربما الاسم مكرر، غيّر الاسم وحاول مرة أخرى.");
    }
  }

  if (isAdmin(ctx.from.id) && session.mode === "admin_charge_user_id") {
    const telegramId = Number(text);
    if (!telegramId) return ctx.reply("أرسل آيدي صحيح.");
    session.chargeTargetTelegramId = telegramId;
    session.mode = "admin_charge_amount";
    return ctx.reply("أرسل مبلغ الشحن بالدولار. مثال: 10");
  }

  if (isAdmin(ctx.from.id) && session.mode === "admin_charge_amount") {
    const amount = Number(text);
    if (Number.isNaN(amount) || amount <= 0) return ctx.reply("أرسل مبلغ صحيح.");
    const targetTelegramId = session.chargeTargetTelegramId;
    const target = await prisma.user.findUnique({
      where: { telegramId: BigInt(targetTelegramId) },
    });

    if (!target) {
      clearSession(ctx.from.id);
      return ctx.reply("المستخدم غير موجود داخل قاعدة البيانات. لازم يدخل البوت أولاً.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: { balanceUsd: { increment: amount } },
      });

      await tx.walletTransaction.create({
        data: {
          userId: target.id,
          type: "admin_charge",
          amount,
          reason: `شحن من المدير ${ctx.from.id}`,
        },
      });
    });

    clearSession(ctx.from.id);
    try {
      await bot.telegram.sendMessage(
        Number(target.telegramId),
        `💵 تم شحن رصيدك بمبلغ ${money(amount)}`
      );
    } catch {}
    return ctx.reply("✅ تم شحن الرصيد بنجاح.");
  }

  return next();
});

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

async function startApp() {
  app.get("/", (_req, res) => {
    res.status(200).json({ ok: true, service: "telegram-store-bot" });
  });

  app.get("/health", (_req, res) => {
    res.status(200).send("OK");
  });

  await prisma.$connect();
  await bot.launch();

  app.listen(config.PORT, () => {
    console.log(`HTTP server running on port ${config.PORT}`);
    console.log("Telegram bot started");
  });

  process.once("SIGINT", async () => {
    await bot.stop("SIGINT");
    await prisma.$disconnect();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await bot.stop("SIGTERM");
    await prisma.$disconnect();
    process.exit(0);
  });
}

startApp().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
