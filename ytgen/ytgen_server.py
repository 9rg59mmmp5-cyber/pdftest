"""
pdftest YouTube → Ezber Kartı üretici mikroservis
Port: 4002
Endpoints:
  POST /playlist-info        { url } → { type, playlistName?, videos: [{id, title, duration}] }
  POST /generate             { uid, videoIds[], playlistName?, subject?, topic? } → { jobId }
  GET  /job/{jobId}          → { status, progress, total, cardsCount, errors[], done }
  DELETE /job/{jobId}        → iptal
"""
import os
import re
import uuid
import time
import logging
import jwt  # PyJWT — Node.js pdftest-api ile aynı secret'ı kullanır
import sqlite3
import threading
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from youtube_transcript_api import YouTubeTranscriptApi
import google.generativeai as genai
import yt_dlp

# Firebase admin — uid doğrulama (mevcut pdftest-api ile aynı mekanizma)
import firebase_admin
from firebase_admin import credentials, auth as fb_auth

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("ytgen")

# ── Config ────────────────────────────────────────────────────────────────
JWT_SECRET = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET ortam değişkeni yok — Node.js ile aynı olmalı")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY ortam değişkeni yok")
genai.configure(api_key=GEMINI_API_KEY)
gemini_model = genai.GenerativeModel('gemini-2.0-flash')

DB_PATH = os.environ.get("PDFTEST_DB", "/var/www/pdftest-data/pdftest.sqlite")
FIREBASE_CRED = os.environ.get("FIREBASE_CRED", "/var/www/pdftest-data/firebase-service-account.json")

# Firebase başlat
# Firebase admin kaldırıldı — artık Node.js ile aynı JWT_SECRET kullanıyor

# ── Job storage (in-memory) ───────────────────────────────────────────────
jobs: Dict[str, Dict[str, Any]] = {}
jobs_lock = threading.Lock()

# ── FastAPI ──────────────────────────────────────────────────────────────
app = FastAPI(title="pdftest-ytgen")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Helpers ──────────────────────────────────────────────────────────────
def verify_token(authorization: Optional[str]) -> str:
    """Authorization: Bearer <idToken> → uid döndür. Node.js pdftest-api ile aynı JWT_SECRET."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Authorization header eksik")
    token = authorization[7:]
    try:
        # İmza doğrulamalı — Node.js jsonwebtoken ile aynı HS256 alg
        decoded = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        uid = decoded.get("uid") or decoded.get("sub")
        if not uid:
            raise ValueError("Token'da uid yok")
        return str(uid)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token süresi doldu")
    except jwt.InvalidTokenError as e:
        raise HTTPException(401, f"Token geçersiz: {e}")
    except Exception as e:
        raise HTTPException(401, f"Doğrulama hatası: {e}")

def extract_video_id(url: str) -> Optional[str]:
    patterns = [
        r'youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})',
        r'youtu\.be/([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$',
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    return None

def is_playlist_url(url: str) -> bool:
    return 'playlist?' in url or '&list=' in url or '?list=' in url

def get_playlist_info(url: str) -> dict:
    """yt-dlp ile playlist bilgisi al"""
    opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True, 'skip_download': True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get('_type') == 'playlist' or info.get('entries'):
        entries = info.get('entries', [])
        videos = []
        for e in entries:
            if not e or not e.get('id'):
                continue
            videos.append({
                'id': e['id'],
                'title': (e.get('title') or f"Video {e['id']}")[:150],
                'duration': e.get('duration') or 0,
            })
        return {
            'type': 'playlist',
            'playlistName': (info.get('title') or 'Playlist')[:150],
            'videos': videos,
        }
    else:
        # Tek video
        return {
            'type': 'video',
            'playlistName': None,
            'videos': [{
                'id': info.get('id', ''),
                'title': (info.get('title') or 'Video')[:150],
                'duration': info.get('duration') or 0,
            }],
        }

def get_video_info(video_id: str) -> tuple[str, int]:
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'skip_download': True}) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        title = re.sub(r'[<>:"/\\|?*]', '', info.get('title', f'Video_{video_id}')).strip()[:100]
        duration = info.get('duration', 0) or 0
        return title, duration
    except Exception as e:
        logger.error(f"Video info hatası {video_id}: {e}")
        return f"Video_{video_id}", 0

def get_transcript(video_id: str) -> str:
    """yt-dlp ile altyazı indir — IP ban'a dayanıklı."""
    import tempfile, os as _os, json, shutil
    from pathlib import Path

    url = f"https://www.youtube.com/watch?v={video_id}"
    tmpdir = tempfile.mkdtemp(prefix="ytgen_sub_")
    try:
        opts_list = [
            {"quiet": True, "no_warnings": True, "skip_download": True,
             "writesubtitles": True, "subtitleslangs": ["tr"],
             "subtitlesformat": "json3",
             "outtmpl": _os.path.join(tmpdir, "%(id)s.%(ext)s")},
            {"quiet": True, "no_warnings": True, "skip_download": True,
             "writeautomaticsub": True, "subtitleslangs": ["tr"],
             "subtitlesformat": "json3",
             "outtmpl": _os.path.join(tmpdir, "%(id)s.%(ext)s")},
            {"quiet": True, "no_warnings": True, "skip_download": True,
             "writeautomaticsub": True, "subtitleslangs": ["tr", "en"],
             "subtitlesformat": "json3",
             "outtmpl": _os.path.join(tmpdir, "%(id)s.%(ext)s")},
        ]
        subtitle_text = ""
        for opts in opts_list:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.download([url])
                for f in Path(tmpdir).iterdir():
                    if f.suffix == ".json3" or "tr" in f.name.lower() or "en" in f.name.lower():
                        try:
                            data = json.loads(f.read_text(encoding="utf-8"))
                            parts = []
                            for event in data.get("events", []):
                                for seg in event.get("segs", []) or []:
                                    t = seg.get("utf8", "")
                                    if t and t != "\n":
                                        parts.append(t)
                            subtitle_text = " ".join(parts).strip()
                            if subtitle_text:
                                break
                        except Exception:
                            continue
                if subtitle_text:
                    break
                for f in Path(tmpdir).iterdir():
                    try: f.unlink()
                    except: pass
            except Exception as e:
                logger.warning(f"yt-dlp subtitle denemesi: {e}")
                continue
        if not subtitle_text or len(subtitle_text) < 100:
            raise ValueError("Türkçe altyazı bulunamadı")
        return subtitle_text
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def retry_gemini(func, max_retries=3, base_wait=5):
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            err = str(e).lower()
            if any(k in err for k in ('quota', 'rate', '429', '503', 'resource_exhausted')):
                if attempt < max_retries - 1:
                    wait = base_wait * (2 ** attempt)
                    logger.warning(f"Gemini rate limit, {wait}s bekleniyor ({attempt+1}/{max_retries})")
                    time.sleep(wait)
                    continue
            raise

def generate_cards(transcript: str, video_title: str, playlist_name: Optional[str],
                   user_subject: Optional[str], user_topic: Optional[str]) -> str:
    """Gemini ile ezber kartı üret"""
    pl_hint = f"\nBu video '{playlist_name}' oynatma listesinin parçası." if playlist_name else ""
    subject_hint = f"\nBu video {user_subject} dersine ait." if user_subject else ""
    topic_hint = f"\nKonu: {user_topic}" if user_topic else ""

    prompt = f"""Sen bir KPSS Önlisans ezber kart uzmanısın.
Aşağıdaki YouTube ders videosu transkriptinden, öğrencinin pdftest uygulamasında
kullanacağı EZBER KARTLARI üretmen gerekiyor.

VIDEO BAŞLIĞI: {video_title}{pl_hint}{subject_hint}{topic_hint}

GÖREV FELSEFESİ:
Sen özet çıkarmıyorsun. Hocanın KPSS için "bunu bilmeniz lazım, bu çıkar,
dikkat edin, ezberleyin" dediği NET BİLGİLERİ karta dönüştürüyorsun.

🔥 VURGU VE TEKRAR ANALİZİ (KRİTİK):
Hocalar önemli gördükleri yerleri videoda tekrar ederler. Transkripti analiz ederken:
1. Hocanın tekrarladığı/vurguladığı bilgiler,
2. "Burası çok önemli", "Dikkat edin", "Sınavda çıkar", "Altını çiziyorum" gibi ifadelerden sonra gelen bilgiler,
Bu bilgiler YÜKSEK ÖNCELİKLİ. Ama aynı bilginin kartını 1 kez üret.

KART UYGUN İÇERİKLER:
- Kavram TANIMLARI (X nedir? / X ______ demektir)
- Yazar-Eser, Olay-Tarih, Kişi-Görev eşleştirmeleri
- Sayısal veriler, kronoloji (ilk, en, kaç tane, hangi yıl)
- Hocanın vurguladığı her kural/istisna

ÇIKTI FORMATI (kesin, başka hiçbir şey yazma):
Her satırda TEK kart:
[DERS] [KONU] Ön yüz :: Arka yüz

Örnekler:
[TARIH] [Osmanlı Duraklama] Osmanlı'nın duraklama dönemi hangi padişahla başladı? :: III. Murat
[COGRAFYA] [Göller] Türkiye'nin en büyük tatlı su gölü :: Beyşehir Gölü
[VATANDASLIK] [Yasama] TBMM'nin görev süresi kaç yıldır? :: 5 yıl

KESİN KURALLAR:
1. DERS etiketi: TARIH, COGRAFYA, VATANDASLIK, TURKCE, MATEMATIK
2. KONU etiketi: Videonun spesifik alt konusu
3. Kart tipleri sıralaması: Boşluk doldurma (______) → Eşleştirme → Soru-Cevap
4. Boşluk yeri MUTLAKA "______" (6 alt çizgi)
5. Ön yüz ile arka yüzü MUTLAKA " :: " ile ayır
6. Aynı bilgiyi farklı kelimelerle iki kez kart yapma
7. ALT SINIR: 8 kart. ÜST SINIR: 100 kart
8. Çıktı sadece kartlardan ibaret olsun. Markdown/başlık/yıldız YOK

TRANSKRIPT:
{transcript[:30000]}

Sadece kartları ver.
"""
    def _gen():
        return gemini_model.generate_content(
            prompt,
            generation_config=genai.types.GenerationConfig(
                max_output_tokens=8192,
                temperature=0.3,
            ),
        )
    resp = retry_gemini(_gen)
    return resp.text.strip() if resp.text else ""

def parse_cards(raw: str, max_cards: int = 100) -> List[Dict[str, str]]:
    """Ham metinden kart listesi çıkar"""
    lines = raw.split('\n')
    valid = []
    seen = set()
    for line in lines:
        line = line.strip()
        if not line or line.startswith('```') or line.startswith('#'):
            continue
        line = re.sub(r'^\s*(\d+[.)]|\*|-)\s+', '', line)
        if '::' not in line:
            continue
        # [DERS] [KONU] Ön :: Arka
        m = re.match(r'^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.+?)\s*::\s*(.+)$', line)
        if not m:
            continue
        subject = m.group(1).strip()
        topic = m.group(2).strip()
        front = m.group(3).strip()
        back = m.group(4).strip()
        if not front or not back:
            continue
        key = (front.lower(), back.lower())
        if key in seen:
            continue
        seen.add(key)
        # Ders adını normalize et
        subject_map = {
            'TARIH': 'Tarih', 'TARİH': 'Tarih',
            'COGRAFYA': 'Coğrafya', 'COĞRAFYA': 'Coğrafya',
            'VATANDASLIK': 'Vatandaşlık', 'VATANDAŞLIK': 'Vatandaşlık',
            'TURKCE': 'Türkçe', 'TÜRKÇE': 'Türkçe',
            'MATEMATIK': 'Matematik', 'MATEMATİK': 'Matematik',
        }
        subject = subject_map.get(subject.upper(), subject)
        valid.append({
            'subject': subject,
            'topic': topic,
            'front': front,
            'back': back,
        })
        if len(valid) >= max_cards:
            break
    return valid

def save_card_to_db(uid: str, subject: str, topic: str, front: str, back: str) -> str:
    """memorize_cards tablosuna ekle"""
    card_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    try:
        conn.execute("""INSERT INTO memorize_cards
            (id, uid, subject, topic, front, back, created_at, review_count, ease_factor, interval_days, lapses)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 2.5, 0, 0)""",
            (card_id, uid, subject, topic, front, back, now))
        conn.commit()
    finally:
        conn.close()
    return card_id

# ── Background job runner ────────────────────────────────────────────────
def run_generation_job(job_id: str, uid: str, video_ids: List[Dict[str, str]],
                        playlist_name: Optional[str], user_subject: Optional[str], user_topic: Optional[str]):
    """Tüm videoları tek tek işle, kartları DB'ye yaz"""
    try:
        for idx, v in enumerate(video_ids):
            with jobs_lock:
                if job_id not in jobs or jobs[job_id].get('cancelled'):
                    logger.info(f"Job {job_id} iptal edildi")
                    return
                jobs[job_id]['current'] = v.get('title', v['id'])
                jobs[job_id]['currentIndex'] = idx

            video_id = v['id']
            video_title = v.get('title') or f"Video_{video_id}"

            try:
                logger.info(f"[{job_id}] {idx+1}/{len(video_ids)}: {video_title}")
                transcript = get_transcript(video_id)
                if len(transcript.strip()) < 100:
                    raise ValueError("Transcript çok kısa")

                raw = generate_cards(transcript, video_title, playlist_name, user_subject, user_topic)
                cards = parse_cards(raw)

                if len(cards) < 3:
                    with jobs_lock:
                        jobs[job_id]['errors'].append(f"{video_title}: yetersiz kart ({len(cards)})")
                    continue

                # DB'ye yaz
                for c in cards:
                    save_card_to_db(uid, c['subject'], c['topic'], c['front'], c['back'])

                with jobs_lock:
                    jobs[job_id]['done'] += 1
                    jobs[job_id]['cardsCount'] += len(cards)

                # Rate limit koruması
                time.sleep(2)

            except Exception as e:
                logger.error(f"[{job_id}] video {video_id} hatası: {e}")
                with jobs_lock:
                    jobs[job_id]['errors'].append(f"{video_title}: {str(e)[:100]}")

        with jobs_lock:
            jobs[job_id]['status'] = 'completed'
            jobs[job_id]['completedAt'] = int(time.time() * 1000)
        logger.info(f"[{job_id}] tamamlandı: {jobs[job_id]['cardsCount']} kart")

    except Exception as e:
        logger.error(f"[{job_id}] genel hata: {e}")
        with jobs_lock:
            jobs[job_id]['status'] = 'error'
            jobs[job_id]['error'] = str(e)

# ── Models ──────────────────────────────────────────────────────────────
class PlaylistInfoRequest(BaseModel):
    url: str

class GenerateRequest(BaseModel):
    videos: List[Dict[str, Any]]       # [{id, title, duration?}]
    playlistName: Optional[str] = None
    subject: Optional[str] = None
    topic: Optional[str] = None

# ── Endpoints ───────────────────────────────────────────────────────────
@app.get("/pdftest/ytgen/health")
def health():
    return {"ok": True, "service": "pdftest-ytgen"}

@app.post("/pdftest/ytgen/playlist-info")
def playlist_info(req: PlaylistInfoRequest, authorization: Optional[str] = Header(None)):
    verify_token(authorization)
    if not req.url:
        raise HTTPException(400, "url gerekli")
    try:
        info = get_playlist_info(req.url)
        return info
    except Exception as e:
        logger.error(f"playlist-info hata: {e}")
        raise HTTPException(500, f"Link çözümlenemedi: {e}")

@app.post("/pdftest/ytgen/generate")
def generate(req: GenerateRequest, authorization: Optional[str] = Header(None)):
    uid = verify_token(authorization)
    if not req.videos:
        raise HTTPException(400, "videos gerekli")

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {
            'id': job_id,
            'uid': uid,
            'status': 'processing',
            'total': len(req.videos),
            'done': 0,
            'cardsCount': 0,
            'errors': [],
            'current': '',
            'currentIndex': 0,
            'playlistName': req.playlistName,
            'startedAt': int(time.time() * 1000),
            'cancelled': False,
        }

    # Background thread
    t = threading.Thread(
        target=run_generation_job,
        args=(job_id, uid, req.videos, req.playlistName, req.subject, req.topic),
        daemon=True,
    )
    t.start()
    return {"jobId": job_id, "total": len(req.videos)}

@app.get("/pdftest/ytgen/job/{job_id}")
def get_job(job_id: str, authorization: Optional[str] = Header(None)):
    uid = verify_token(authorization)
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job bulunamadı")
    if job['uid'] != uid:
        raise HTTPException(403, "erişim yok")
    return {k: v for k, v in job.items() if k != 'uid'}

@app.delete("/pdftest/ytgen/job/{job_id}")
def cancel_job(job_id: str, authorization: Optional[str] = Header(None)):
    uid = verify_token(authorization)
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "job bulunamadı")
        if job['uid'] != uid:
            raise HTTPException(403, "erişim yok")
        job['cancelled'] = True
        job['status'] = 'cancelled'
    return {"ok": True}

# Job temizleme (eski job'ları 1 saatte sil)
def cleanup_jobs():
    while True:
        time.sleep(300)  # 5 dakika
        now = int(time.time() * 1000)
        with jobs_lock:
            to_remove = [jid for jid, j in jobs.items()
                         if j.get('completedAt') and now - j['completedAt'] > 3600000]
            for jid in to_remove:
                del jobs[jid]

cleanup_thread = threading.Thread(target=cleanup_jobs, daemon=True)
cleanup_thread.start()

if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get("PORT", 4002))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
