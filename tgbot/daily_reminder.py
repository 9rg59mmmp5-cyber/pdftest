"""
pdftest günlük hatırlatma scripti — cron'dan çalıştırılır
Sınav yaklaştıkça mesaj sayısı artar:
  >100 gün: günde 1 (sabah)
  60-100:   günde 1 + akşam
  30-60:    günde 2 (sabah + akşam)
  <30:      günde 3 (sabah + öğle + akşam)

Cron örneği:
  0 8,12,20 * * * /usr/bin/python3 /var/www/pdftest-tgbot/daily_reminder.py
  (script kendi içinde "şu an gönderilmeli mi" kontrol eder)
"""
import os
import sys
import json
import sqlite3
import logging
import requests
from datetime import datetime, date, timedelta

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("pdftest-reminder")

# ── Config ────────────────────────────────────────────────────────────────
TG_TOKEN = os.environ.get("PDFTEST_TG_TOKEN")
CHAT_ID = int(os.environ.get("PDFTEST_TG_CHAT_ID", "860174169"))
DB_PATH = os.environ.get("PDFTEST_DB", "/var/www/pdftest-data/pdftest.sqlite")
PDFTEST_UID = os.environ.get("PDFTEST_UID", "user1")
EXAM_DATE_FILE = os.environ.get("EXAM_DATE_FILE", "/var/www/pdftest-data/exam_date.txt")

if not TG_TOKEN:
    print("PDFTEST_TG_TOKEN env yok", file=sys.stderr)
    sys.exit(1)

# ── Sınav tarihi oku ─────────────────────────────────────────────────────
def get_exam_date():
    """Frontend'den localforage'a kaydedilmiş tarihi okuyamayız.
    Bunun yerine /var/www/pdftest-data/exam_date.txt dosyasını okuyacağız.
    İlk kurulumda bu dosyayı manuel oluşturman lazım:
      echo "2026-09-13" | sudo tee /var/www/pdftest-data/exam_date.txt
    """
    try:
        with open(EXAM_DATE_FILE) as f:
            d = f.read().strip()
        return datetime.strptime(d, "%Y-%m-%d").date()
    except Exception:
        return None

def days_to_exam():
    ed = get_exam_date()
    if not ed:
        return None
    return (ed - date.today()).days

def intensity():
    d = days_to_exam()
    if d is None:
        return 'normal'
    if d < 30:
        return 'kritik'
    if d < 60:
        return 'yogun'
    if d < 100:
        return 'orta'
    return 'normal'

# ── Hangi mesaj zamanı? ──────────────────────────────────────────────────
def should_send_now():
    """Cron her saat çalışsın, biz burada gönderim saatlerini kontrol edelim."""
    hour = datetime.now().hour
    inten = intensity()

    # 8 = sabah, 12 = öğle, 20 = akşam
    if inten == 'normal':
        # Sadece sabah
        return hour == 8
    elif inten == 'orta':
        # Sabah + akşam (60-100 gün arası "akşam ek" mesajı)
        return hour in (8, 20)
    elif inten == 'yogun':
        return hour in (8, 20)
    elif inten == 'kritik':
        return hour in (8, 12, 20)
    return False

# ── DB'den durum çek ─────────────────────────────────────────────────────
def get_stats():
    """Bekleyen tekrarlar, hatalar, dünkü performans"""
    now_ms = int(datetime.now().timestamp() * 1000)
    yesterday_ms = now_ms - 86400000

    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    try:
        # Bekleyen tekrarlar (srsNextReview <= şu an)
        rows = conn.execute(
            "SELECT data FROM questions WHERE uid=?", (PDFTEST_UID,)
        ).fetchall()

        due = 0
        new = 0
        total = 0
        wrong_total = 0
        weakest_topics = {}  # topic -> error count
        for r in rows:
            try:
                d = json.loads(r[0])
                if not d.get('correctAnswer'):
                    continue
                total += 1
                if d.get('srsLapses', 0) > 0:
                    wrong_total += 1
                    key = f"{d.get('subject','?')} / {d.get('topic','Genel')}"
                    weakest_topics[key] = weakest_topics.get(key, 0) + d.get('srsLapses', 0)
                if not d.get('srsReviewCount'):
                    new += 1
                elif d.get('srsNextReview', 0) <= now_ms:
                    due += 1
            except Exception:
                continue

        # En zayıf 1 konu
        weakest = ''
        if weakest_topics:
            weakest = max(weakest_topics.items(), key=lambda x: x[1])[0]

        # Bekleyen ezber kartları
        try:
            mem_due = conn.execute(
                "SELECT COUNT(*) FROM memorize_cards WHERE uid=? AND (next_review_date IS NULL OR next_review_date <= ?)",
                (PDFTEST_UID, now_ms)
            ).fetchone()[0]
        except Exception:
            mem_due = 0

        return {
            'due': due, 'new': new, 'total': total,
            'wrong_total': wrong_total, 'weakest': weakest,
            'mem_due': mem_due,
        }
    finally:
        conn.close()

# ── Mesaj oluştur ────────────────────────────────────────────────────────
def build_message(when: str):
    """when: 'morning' | 'noon' | 'evening'"""
    days = days_to_exam()
    inten = intensity()
    stats = get_stats()

    inten_emoji = {'normal':'📚', 'orta':'⚡', 'yogun':'🔥', 'kritik':'🚨'}[inten]
    inten_name = {'normal':'Normal Tempo', 'orta':'Orta Tempo', 'yogun':'Yoğun Tempo', 'kritik':'KRİTİK DÖNEM'}[inten]

    if when == 'morning':
        greet = '🌅 *Günaydın!*'
    elif when == 'noon':
        greet = '🌞 *Öğlen molası*'
    else:
        greet = '🌙 *İyi akşamlar*'

    lines = [greet, '']
    if days is not None:
        if days == 0:
            lines.append('🚨 *BUGÜN SINAV GÜNÜ! Başarılar!*')
        elif days <= 7:
            lines.append(f'📅 *Sınava {days} gün kaldı* {inten_emoji}')
        else:
            lines.append(f'📅 Sınava *{days} gün* kaldı  ({inten_emoji} {inten_name})')
    lines.append('')

    # Bekleyen iş
    if stats['due'] + stats['new'] > 0:
        lines.append(f'📚 *Bekleyen tekrar:* {stats["due"]} soru')
        if stats['new'] > 0:
            lines.append(f'🆕 *Yeni soru:* {stats["new"]}')
    else:
        lines.append('✨ Bekleyen tekrar yok — yeni soru ekle!')

    if stats['mem_due'] > 0:
        lines.append(f'🧠 *Ezber kartı:* {stats["mem_due"]} kart')

    if stats['wrong_total'] > 0:
        lines.append(f'📕 *Hatalı sorular:* {stats["wrong_total"]} adet')

    if stats['weakest']:
        lines.append('')
        lines.append(f'⚠️ *En zayıf konun:* {stats["weakest"]}')

    # Yoğunluğa göre motivasyon
    lines.append('')
    if inten == 'kritik':
        lines.append('🔥 _Son düzlüğüsün, her dakika değerli! Hatalı sorularını mutlaka tekrar et._')
    elif inten == 'yogun':
        lines.append('💪 _Çıtayı yükselt — yoğun tempo başladı. Düzenli çalış._')
    elif inten == 'orta':
        lines.append('📖 _Tempoyu artırma vakti. Hatalarını çöz._')
    else:
        lines.append('🎯 _Düzenli çalış. Yeni soru ekleyerek tabanı genişlet._')

    lines.append('')
    lines.append('👉 [Çalışmaya başla](https://hissetarama.com/pdftest)')

    return '\n'.join(lines)

# ── Telegram'a gönder ────────────────────────────────────────────────────
def send_message(text: str):
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json={
                "chat_id": CHAT_ID,
                "text": text,
                "parse_mode": "Markdown",
                "disable_web_page_preview": True,
            },
            timeout=10
        )
        r.raise_for_status()
        logger.info("Mesaj gönderildi")
    except Exception as e:
        logger.error(f"Mesaj gönderilemedi: {e}")

# ── Ana ──────────────────────────────────────────────────────────────────
def main():
    if not should_send_now():
        logger.info(f"Bu saatte gönderim yok ({datetime.now().hour}:00, intensity={intensity()})")
        return

    hour = datetime.now().hour
    when = 'morning' if hour < 11 else ('noon' if hour < 17 else 'evening')

    msg = build_message(when)
    send_message(msg)

if __name__ == '__main__':
    main()
