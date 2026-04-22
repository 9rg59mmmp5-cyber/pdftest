"""
pdftest-tgbot — Telegram botu üzerinden pdftest'e otomatik soru kaydı
Port: 4003 (basit health check için)

Akış:
  1. Sürekli long-polling ile Telegram'dan update çek
  2. Sadece ALLOWED_CHAT_ID'den gelen fotoğraflı mesajları kabul et
  3. Caption'da A-E harfi var mı kontrol et — yoksa hata mesajı dön
  4. Fotoğrafı indir, küçült
  5. SHA256 hash ile duplicate kontrolü
  6. pdftest DB'ye doğrudan INSERT
  7. Kullanıcıya başarı mesajı gönder

Caption formatı: "C" veya "C tarih" veya "C tarih osmanlı" veya "C tarih osmanlı zor"
  - Büyük/küçük harf farketmez
  - Ders: tarih, coğrafya, vatandaşlık, türkçe, matematik, genel (varsayılan)
  - Konu: serbest metin
  - Zorluk: kolay / orta / zor (varsayılan orta)
"""
import os
import re
import io
import sys
import time
import uuid
import hashlib
import sqlite3
import logging
import requests
import threading
from pathlib import Path
from PIL import Image
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── Config ────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.environ.get("PDFTEST_TG_TOKEN")
if not TELEGRAM_BOT_TOKEN:
    raise RuntimeError("PDFTEST_TG_TOKEN ortam değişkeni yok")

ALLOWED_CHAT_ID = int(os.environ.get("PDFTEST_TG_CHAT_ID", "860174169"))
PDFTEST_UID = os.environ.get("PDFTEST_UID", "user1")
DB_PATH = os.environ.get("PDFTEST_DB", "/var/www/pdftest-data/pdftest.sqlite")
UPLOADS_DIR = os.environ.get("PDFTEST_UPLOADS", "/var/www/pdftest-data/uploads")
HEALTH_PORT = int(os.environ.get("PORT", "4003"))
SITE_URL = os.environ.get("PDFTEST_SITE", "https://hissetarama.com/pdftest")

TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

# ── Logging ───────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("pdftest-tgbot")

# ── Yardımcılar ───────────────────────────────────────────────────────────
VALID_ANSWERS = {'A', 'B', 'C', 'D', 'E'}
SUBJECT_MAP = {
    'tarih': 'Tarih',
    'cografya': 'Coğrafya', 'coğrafya': 'Coğrafya', 'cog': 'Coğrafya',
    'vatandaslik': 'Vatandaşlık', 'vatandaşlık': 'Vatandaşlık', 'vat': 'Vatandaşlık',
    'turkce': 'Türkçe', 'türkçe': 'Türkçe', 'tur': 'Türkçe',
    'matematik': 'Matematik', 'mat': 'Matematik',
    'genel': 'Genel',
}
DIFFICULTY_MAP = {
    'kolay': 'Kolay',
    'orta': 'Orta',
    'zor': 'Zor',
}

def parse_caption(caption: str):
    """
    Caption parse eder.
    Dönüş: (answer, subject, topic, difficulty) veya (None, reason) hata durumunda
    """
    if not caption:
        return None, "Caption yok. Fotoğrafın altına en az cevap harfi (A-E) yaz."

    parts = caption.strip().split()
    if not parts:
        return None, "Boş caption. Cevap harfini yaz (A-E)."

    # 1. Cevap harfi (her zaman ilk kelime ve tek harf olmalı)
    first = parts[0].upper()
    if first not in VALID_ANSWERS:
        return None, f"İlk kelime cevap harfi olmalı (A/B/C/D/E). Senin yazdığın: '{parts[0]}'"

    answer = first
    subject = 'Genel'
    topic = None
    difficulty = 'Orta'

    # 2. Opsiyonel ders + konu + zorluk
    remaining = parts[1:]
    if remaining:
        # İlk kelime ders?
        maybe_subject = remaining[0].lower()
        if maybe_subject in SUBJECT_MAP:
            subject = SUBJECT_MAP[maybe_subject]
            remaining = remaining[1:]

        # Son kelime zorluk mu?
        if remaining and remaining[-1].lower() in DIFFICULTY_MAP:
            difficulty = DIFFICULTY_MAP[remaining[-1].lower()]
            remaining = remaining[:-1]

        # Kalan: konu
        if remaining:
            topic = ' '.join(remaining)

    return {
        'answer': answer,
        'subject': subject,
        'topic': topic,
        'difficulty': difficulty,
    }, None

def send_message(chat_id: int, text: str, reply_to: int = None):
    try:
        data = {"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}
        if reply_to:
            data["reply_to_message_id"] = reply_to
        requests.post(f"{TELEGRAM_API}/sendMessage", json=data, timeout=10)
    except Exception as e:
        logger.error(f"sendMessage hatası: {e}")

def get_file_url(file_id: str) -> str:
    """Telegram'dan file_path al"""
    r = requests.get(f"{TELEGRAM_API}/getFile", params={"file_id": file_id}, timeout=10)
    r.raise_for_status()
    data = r.json()
    if not data.get('ok'):
        raise ValueError(f"getFile hatası: {data}")
    file_path = data['result']['file_path']
    return f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}"

def download_and_compress(url: str, max_w: int = 1600, quality: int = 85) -> tuple[bytes, str]:
    """
    URL'den fotoğrafı indir, küçült, JPEG olarak döndür.
    Dönüş: (bytes, hash)
    """
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    img = Image.open(io.BytesIO(r.content))

    # RGB'ye çevir (RGBA/Palette JPEG desteklemez)
    if img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')

    # Küçült
    w, h = img.size
    if w > max_w:
        ratio = max_w / w
        img = img.resize((max_w, int(h * ratio)), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    data = buf.getvalue()
    h = hashlib.sha256(data).hexdigest()[:16]
    return data, h

def is_duplicate(image_hash: str) -> bool:
    """Aynı hash daha önce kaydedilmiş mi"""
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    try:
        c = conn.execute("SELECT COUNT(*) FROM questions WHERE uid=? AND data LIKE ?",
                         (PDFTEST_UID, f'%"tgHash":"{image_hash}"%'))
        return c.fetchone()[0] > 0
    finally:
        conn.close()

def save_question_to_db(image_bytes: bytes, image_hash: str, parsed: dict) -> str:
    """
    Sorunun hem diskteki dosyasını hem DB kaydını oluştur.
    uploads/<uid>/questions/<id>.jpg olarak kaydedilir, Node.js backend serve eder.
    """
    question_id = str(uuid.uuid4())
    now = int(time.time() * 1000)

    # Dosya yaz
    user_qdir = Path(UPLOADS_DIR) / PDFTEST_UID / 'questions'
    user_qdir.mkdir(parents=True, exist_ok=True)
    filepath = user_qdir / f"{question_id}.jpg"
    filepath.write_bytes(image_bytes)

    # Node.js image serve URL
    image_url = f"/pdftest/api/questions/image/{PDFTEST_UID}/{question_id}.jpg"

    # JSON data (Node.js bu formatı bekliyor — frontend SavedQuestion interface'i)
    import json
    question_data = {
        "id": question_id,
        "sessionId": "",
        "questionNumber": 0,
        "subject": parsed['subject'],
        "topic": parsed['topic'],
        "difficulty": parsed['difficulty'],
        "image": image_url,
        "date": now,
        "correctAnswer": parsed['answer'],
        "notes": None,
        "tgHash": image_hash,  # duplicate için
        "tgImported": True,    # bot'tan geldiğini işaretle
    }

    # DB'ye yaz
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO questions (id, uid, data, date) VALUES (?, ?, ?, ?)",
            (question_id, PDFTEST_UID, json.dumps(question_data, ensure_ascii=False), now)
        )
        conn.commit()
    finally:
        conn.close()

    return question_id

# ── Mesaj işleme ──────────────────────────────────────────────────────────
def handle_photo_message(message: dict):
    chat_id = message['chat']['id']
    message_id = message['message_id']

    # Erişim kontrolü
    if chat_id != ALLOWED_CHAT_ID:
        logger.warning(f"İzinsiz erişim denemesi: chat_id={chat_id}")
        # Hiçbir şey yazmıyoruz — bot sessiz
        return

    # Caption kontrolü
    caption = message.get('caption', '')
    parsed, err = parse_caption(caption)
    if err:
        send_message(chat_id, f"❌ {err}\n\n*Örnek:*\n`C` → sadece cevap\n`C tarih` → cevap + ders\n`C tarih osmanlı zor` → tam format", reply_to=message_id)
        return

    # En yüksek çözünürlüklü foto
    photos = message.get('photo', [])
    if not photos:
        return
    largest = max(photos, key=lambda p: p.get('file_size', 0))
    file_id = largest['file_id']

    try:
        url = get_file_url(file_id)
        image_bytes, image_hash = download_and_compress(url)

        # Duplicate kontrolü
        if is_duplicate(image_hash):
            send_message(chat_id, f"⚠️ Bu soru zaten kayıtlı (aynı fotoğraf daha önce gönderilmiş).", reply_to=message_id)
            return

        question_id = save_question_to_db(image_bytes, image_hash, parsed)

        # Başarı mesajı
        topic_str = f" / {parsed['topic']}" if parsed['topic'] else ""
        send_message(
            chat_id,
            f"✅ Soru kaydedildi!\n"
            f"*Cevap:* {parsed['answer']} • *Ders:* {parsed['subject']}{topic_str} • *Zorluk:* {parsed['difficulty']}\n"
            f"[Sitede gör]({SITE_URL})",
            reply_to=message_id
        )
        logger.info(f"Soru kaydedildi: {question_id} ({parsed['answer']}/{parsed['subject']})")

    except Exception as e:
        logger.exception(f"Hata: {e}")
        send_message(chat_id, f"❌ Hata oluştu: {str(e)[:200]}", reply_to=message_id)

def handle_text_message(message: dict):
    chat_id = message['chat']['id']
    text = (message.get('text') or '').strip()

    if chat_id != ALLOWED_CHAT_ID:
        return

    if text == '/start' or text == '/help':
        send_message(chat_id,
            "*pdftest Soru Botu*\n\n"
            "Fotoğraf gönder + caption'a cevap harfini yaz:\n\n"
            "📝 *Caption örnekleri:*\n"
            "• `C` — sadece cevap\n"
            "• `C tarih` — cevap + ders\n"
            "• `C tarih osmanlı` — cevap + ders + konu\n"
            "• `C tarih osmanlı zor` — hepsi + zorluk\n\n"
            "*Dersler:* tarih, coğrafya, vatandaşlık, türkçe, matematik, genel\n"
            "*Zorluk:* kolay / orta / zor"
        )
    elif text == '/stats':
        conn = sqlite3.connect(DB_PATH, timeout=10.0)
        try:
            total = conn.execute(
                "SELECT COUNT(*) FROM questions WHERE uid=? AND data LIKE '%\"tgImported\":true%'",
                (PDFTEST_UID,)).fetchone()[0]
            all_qs = conn.execute("SELECT COUNT(*) FROM questions WHERE uid=?", (PDFTEST_UID,)).fetchone()[0]
        finally:
            conn.close()
        send_message(chat_id,
            f"📊 *İstatistik*\n"
            f"Toplam soru: {all_qs}\n"
            f"Bot ile eklenen: {total}"
        )

# ── Long polling loop ────────────────────────────────────────────────────
def poll_loop():
    offset = 0
    logger.info(f"Bot başlatıldı — chat_id={ALLOWED_CHAT_ID}, uid={PDFTEST_UID}")
    while True:
        try:
            r = requests.get(
                f"{TELEGRAM_API}/getUpdates",
                params={"offset": offset, "timeout": 30, "allowed_updates": ["message"]},
                timeout=35,
            )
            if r.status_code != 200:
                logger.warning(f"getUpdates {r.status_code}: {r.text[:400]}")
                time.sleep(3)
                continue
            data = r.json()
            if not data.get('ok'):
                logger.warning(f"getUpdates not ok: {str(data)[:400]}")
                time.sleep(3)
                continue

            for update in data.get('result', []):
                offset = update['update_id'] + 1
                msg = update.get('message')
                if not msg:
                    continue

                if 'photo' in msg:
                    handle_photo_message(msg)
                elif 'text' in msg:
                    handle_text_message(msg)
        except requests.exceptions.Timeout:
            continue
        except Exception as e:
            logger.exception(f"Poll hatası: {e}")
            time.sleep(5)

# ── Basit health server ───────────────────────────────────────────────────
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/pdftest/tgbot/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":true,"service":"pdftest-tgbot"}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # sessiz

def start_health():
    try:
        HTTPServer(('127.0.0.1', HEALTH_PORT), HealthHandler).serve_forever()
    except Exception as e:
        logger.error(f"Health server hatası: {e}")

if __name__ == '__main__':
    # Health server arka planda
    threading.Thread(target=start_health, daemon=True).start()
    poll_loop()
