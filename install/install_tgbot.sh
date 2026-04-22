#!/bin/bash
# pdftest-tgbot kurulum scripti
# Telegram'dan otomatik soru yükleme servisi
set -e

echo "🤖 pdftest-tgbot kurulum..."

# ── Env kontrolü ─────────────────────────────────────────────────────────
if [ ! -f /etc/pdftest-tgbot.env ]; then
    echo ""
    echo "❌ /etc/pdftest-tgbot.env dosyası eksik!"
    echo ""
    echo "Önce bu dosyayı oluştur:"
    echo ""
    echo "  sudo tee /etc/pdftest-tgbot.env <<EOF"
    echo "  PDFTEST_TG_TOKEN=XXX_YENI_BOT_TOKEN_BURAYA_XXX"
    echo "  PDFTEST_TG_CHAT_ID=860174169"
    echo "  PDFTEST_UID=user1"
    echo "  EOF"
    echo ""
    echo "  sudo chmod 600 /etc/pdftest-tgbot.env"
    echo ""
    echo "Yeni bot oluşturma:"
    echo "  1. Telegram'da @BotFather'a yaz"
    echo "  2. /newbot → isim ver → kullanıcı adı ver"
    echo "  3. Verilen token'ı PDFTEST_TG_TOKEN olarak kullan"
    exit 1
fi

# ── Python paketleri ─────────────────────────────────────────────────────
echo "📦 Python paketleri yükleniyor..."
pip3 install --break-system-packages --upgrade requests pillow 2>&1 | tail -3

# ── Servis dizini ────────────────────────────────────────────────────────
SERVICE_DIR="/var/www/pdftest-tgbot"
sudo mkdir -p "$SERVICE_DIR"
sudo cp tgbot_server.py "$SERVICE_DIR/"
sudo chown -R www-data:www-data "$SERVICE_DIR" 2>/dev/null || true

# ── pm2 ecosystem ────────────────────────────────────────────────────────
cat > /tmp/pdftest-tgbot.ecosystem.cjs << EOF
module.exports = {
  apps: [{
    name: 'pdftest-tgbot',
    cwd: '$SERVICE_DIR',
    script: '/usr/bin/python3',
    args: '$SERVICE_DIR/tgbot_server.py',
    env_file: '/etc/pdftest-tgbot.env',
    env: {
      PORT: 4003,
      PDFTEST_DB: '/var/www/pdftest-data/pdftest.sqlite',
      PDFTEST_UPLOADS: '/var/www/pdftest-data/uploads',
      PDFTEST_SITE: 'https://hissetarama.com/pdftest',
    },
    instances: 1,
    autorestart: true,
    max_memory_restart: '300M',
    error_file: '/var/log/pm2/pdftest-tgbot-error.log',
    out_file: '/var/log/pm2/pdftest-tgbot-out.log',
  }]
};
EOF

# Eski instance varsa durdur
if pm2 list | grep -q pdftest-tgbot; then
    pm2 delete pdftest-tgbot || true
fi
pm2 start /tmp/pdftest-tgbot.ecosystem.cjs
pm2 save

# ── Kontrol ──────────────────────────────────────────────────────────────
sleep 3
echo ""
echo "🔍 Health check..."
if curl -sf http://localhost:4003/pdftest/tgbot/health > /dev/null; then
    echo "✅ pdftest-tgbot çalışıyor (port 4003)"
else
    echo "⚠️  Health check başarısız. Log:"
    pm2 logs pdftest-tgbot --lines 20 --nostream
    exit 1
fi

echo ""
echo "──────────────────────────────────────────────"
echo "✅ Bot kurulumu tamamlandı!"
echo ""
echo "Şimdi Telegram'da bot ile konuş:"
echo "  1. Bot'a /start yaz — yardım mesajı gelecek"
echo "  2. Bir soru fotoğrafı gönder, caption'a cevap harfi yaz (ör: C)"
echo "  3. Bot 'Soru kaydedildi' mesajı verecek"
echo "  4. Sitende Sorular sayfasına bak — orada olacak"
echo ""
echo "Logları izle:"
echo "  pm2 logs pdftest-tgbot"
echo ""
