# Telegram Bot for Railway

## 1) التثبيت
```bash
npm install
```

## 2) إنشاء ملف البيئة
انسخ `.env.example` إلى `.env`

```bash
cp .env.example .env
```

ثم أضف توكن البوت من BotFather.

## 3) التشغيل محليًا
```bash
npm start
```

## 4) الرفع إلى Railway
- ارفع الملفات إلى GitHub
- أنشئ مشروع جديد في Railway من المستودع
- أضف متغير البيئة:
  - `BOT_TOKEN`
- Railway سيشغّل:
```bash
npm start
```

## الملفات
- `index.js` الملف الرئيسي
- `package.json` dependencies و scripts
- `.env.example` مثال لمتغيرات البيئة
