#!/bin/bash
# Günlük Telegram hatırlatma cron kurulumu
set -e

echo "🤖 Günlük hatırlatma kuruluyor..."

# Daily reminder script'ini kopyala
sudo cp daily_reminder.py /var/www/pdftest-tgbot/
sudo chmod +x /var/www/pdftest-tgbot/daily_reminder.py
echo "✅ Script kopyalandı"

# Sınav tarihi dosyasını oluştur
if [ ! -f /var/www/pdftest-data/exam_date.txt ]; then
    echo ""
    echo "📅 Sınav tarihi gerekli (YYYY-MM-DD formatında)"
    echo "   Örnek: 2026-09-13"
    echo ""
    read -p "Sınav tarihi: " EXAM_DATE
    if [ -n "$EXAM_DATE" ]; then
        echo "$EXAM_DATE" | sudo tee /var/www/pdftest-data/exam_date.txt > /dev/null
        echo "✅ Sınav tarihi kaydedildi: $EXAM_DATE"
    fi
else
    echo "ℹ  Sınav tarihi zaten kayıtlı: $(cat /var/www/pdftest-data/exam_date.txt)"
    echo "   Değiştirmek için: sudo nano /var/www/pdftest-data/exam_date.txt"
fi

# Cron job ekle (her saat başı çalışır, script kendi içinde gönderim saatini kontrol eder)
CRON_LINE="0 * * * * /usr/bin/python3 /var/www/pdftest-tgbot/daily_reminder.py >> /var/log/pdftest-reminder.log 2>&1"

# /etc/pdftest-tgbot.env değerlerini cron için yükle (cron env'leri otomatik almaz)
CRON_WITH_ENV="0 * * * * source /etc/pdftest-tgbot.env && export PDFTEST_TG_TOKEN PDFTEST_TG_CHAT_ID PDFTEST_UID && /usr/bin/python3 /var/www/pdftest-tgbot/daily_reminder.py >> /var/log/pdftest-reminder.log 2>&1"

# Eski varsa sil, yeni ekle
(crontab -l 2>/dev/null | grep -v "daily_reminder.py" ; echo "$CRON_WITH_ENV") | crontab -

echo "✅ Cron job eklendi (her saat başı)"
echo ""
crontab -l | grep daily_reminder
echo ""
echo "──────────────────────────────────────────────"
echo "Kontrol:"
echo "  Test çalıştır: PDFTEST_TG_TOKEN=... PDFTEST_TG_CHAT_ID=... python3 /var/www/pdftest-tgbot/daily_reminder.py"
echo "  Log: tail -f /var/log/pdftest-reminder.log"
echo "  Cron'lar: crontab -l"
echo ""
echo "Sınav tarihini değiştirmek için:"
echo "  echo '2026-09-13' | sudo tee /var/www/pdftest-data/exam_date.txt"
