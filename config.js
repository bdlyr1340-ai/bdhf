import "dotenv/config";

function parseAdminIds(value = "") {
  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x));
}

export const config = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: Number(process.env.PORT || 3000),
  CHANNEL_USERNAME: process.env.CHANNEL_USERNAME || "",
  CHANNEL_URL: process.env.CHANNEL_URL || "",
  CHANNEL_ID: process.env.CHANNEL_ID || "",
  ADMIN_IDS: parseAdminIds(process.env.ADMIN_IDS || ""),
  REFERRAL_TARGET: Number(process.env.REFERRAL_TARGET || 10),
  REFERRAL_REWARD_PRODUCT_SLUG: process.env.REFERRAL_REWARD_PRODUCT_SLUG || "",
  START_BONUS_USD: Number(process.env.START_BONUS_USD || 0),
};

const required = ["BOT_TOKEN", "DATABASE_URL"];
const missing = required.filter((key) => !config[key]);
if (missing.length) {
  console.error("Missing env vars:", missing.join(", "));
  process.exit(1);
}
