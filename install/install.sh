#!/bin/bash
# pdftest YouTube → Ezber Kartı mikroservis kurulum
set -e

echo "🔧 pdftest-ytgen kurulum başlıyor..."

# ── 1. Ortam kontrolü ────────────────────────────────────────────────────
if [ -z "$GEMINI_API_KEY" ]; then
    if [ ! -f /etc/pdftest-ytgen.env ]; then
        echo ""
        echo "❌ GEMINI_API_KEY eksik!"
        echo ""
        echo "Önce API anahtarını /etc/pdftest-ytgen.env dosyasına yaz:"
        echo ""
        echo "  sudo tee /etc/pdftest-ytgen.env <<EOF"
        echo "  GEMINI_API_KEY=AIzaSy...senin_yeni_anahtarın..."
        echo "  EOF"
        echo ""
        echo "Sonra bu scripti tekrar çalıştır."
        exit 1
    fi
fi

# ── 2. Python paketleri ──────────────────────────────────────────────────
echo "📦 Python paketleri yükleniyor..."
pip3 install --break-system-packages --upgrade \
    fastapi \
    uvicorn \
    youtube-transcript-api \
    google-generativeai \
    yt-dlp \
    firebase-admin \
    pydantic 2>&1 | tail -5

# ── 3. Servis dizini ─────────────────────────────────────────────────────
SERVICE_DIR="/var/www/pdftest-ytgen"
sudo mkdir -p "$SERVICE_DIR"
sudo cp ytgen_server.py "$SERVICE_DIR/"
sudo chown -R www-data:www-data "$SERVICE_DIR" 2>/dev/null || true
echo "✅ Servis dosyaları: $SERVICE_DIR"

# ── 4. Env dosyası hazırlama ─────────────────────────────────────────────
if [ ! -f /etc/pdftest-ytgen.env ] && [ -n "$GEMINI_API_KEY" ]; then
    echo "GEMINI_API_KEY=$GEMINI_API_KEY" | sudo tee /etc/pdftest-ytgen.env > /dev/null
    sudo chmod 600 /etc/pdftest-ytgen.env
fi

# ── 5. pm2 ecosystem ─────────────────────────────────────────────────────
cat > /tmp/pdftest-ytgen.ecosystem.cjs << EOF
module.exports = {
  apps: [{
    name: 'pdftest-ytgen',
    cwd: '$SERVICE_DIR',
    script: '/usr/bin/python3',
    args: '$SERVICE_DIR/ytgen_server.py',
    env_file: '/etc/pdftest-ytgen.env',
    env: {
      PORT: 4002,
      PDFTEST_DB: '/var/www/pdftest-data/pdftest.sqlite',
      FIREBASE_CRED: '/var/www/pdftest-data/firebase-service-account.json',
    },
    instances: 1,
    autorestart: true,
    max_memory_restart: '500M',
    error_file: '/var/log/pm2/pdftest-ytgen-error.log',
    out_file: '/var/log/pm2/pdftest-ytgen-out.log',
  }]
};
EOF

# ── 6. Eski instance varsa durdur, yeni başlat ───────────────────────────
if pm2 list | grep -q pdftest-ytgen; then
    pm2 delete pdftest-ytgen || true
fi
pm2 start /tmp/pdftest-ytgen.ecosystem.cjs
pm2 save

# ── 7. Kontrol ───────────────────────────────────────────────────────────
sleep 3
echo ""
echo "🔍 Health check..."
if curl -sf http://localhost:4002/pdftest/ytgen/health > /dev/null; then
    echo "✅ pdftest-ytgen çalışıyor (port 4002)"
else
    echo "⚠️  Health check başarısız. Log:"
    pm2 logs pdftest-ytgen --lines 20 --nostream
    exit 1
fi

echo ""
echo "──────────────────────────────────────────────"
echo "✅ Backend kurulumu tamamlandı!"
echo ""
echo "SON ADIM: Nginx'e proxy satırı eklenmesi gerekiyor."
echo "Aşağıdaki dosyayı düzenle:"
echo ""
echo "  sudo nano /etc/nginx/sites-enabled/<siten>"
echo ""
echo "PDF test location bloğunun yanına şunu ekle:"
echo ""
echo "  location /pdftest/ytgen/ {"
echo "      proxy_pass http://127.0.0.1:4002;"
echo "      proxy_set_header Host \$host;"
echo "      proxy_set_header X-Real-IP \$remote_addr;"
echo "      proxy_read_timeout 300s;"
echo "      proxy_connect_timeout 60s;"
echo "  }"
echo ""
echo "Sonra:"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo ""
