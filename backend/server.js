/**
 * pdftest Backend — Port 4001
 * Veriler: /var/www/pdftest-data/
 */
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 4001;

// ── Dizinler ──────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || '/var/www/pdftest-data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'pdftest.sqlite');

[DATA_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Firebase Admin (token doğrulama) ──────────────────────────────────────────
const saPath = path.join(DATA_DIR, 'firebase-service-account.json');
if (fs.existsSync(saPath)) {
  const sa = JSON.parse(readFileSync(saPath, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  console.log('✅ Firebase Admin başlatıldı');
} else {
  console.warn('⚠️  firebase-service-account.json bulunamadı — auth devre dışı!');
}

// ── JWT & Users ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'pdftest-secret-change-me-' + Math.random();
const USERS = JSON.parse(process.env.PDFTEST_USERS || '[]');
// PDFTEST_USERS örnek: [{"username":"halil","password":"sifre123","uid":"user1","displayName":"Halil"}]

// ── SQLite ────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS pdfs (
    id TEXT PRIMARY KEY, uid TEXT NOT NULL, name TEXT NOT NULL,
    subject TEXT NOT NULL, category TEXT NOT NULL,
    added_at INTEGER NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, uid TEXT NOT NULL,
    data TEXT NOT NULL, last_accessed INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, uid TEXT NOT NULL,
    data TEXT NOT NULL, date INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pdfs_uid ON pdfs(uid);
  CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);
  CREATE INDEX IF NOT EXISTS idx_questions_uid ON questions(uid);
`);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));

// Başlangıçta gerekli klasörleri oluştur
[
  path.join(UPLOADS_DIR, 'user1', 'chunks'),
  path.join(UPLOADS_DIR, 'user1', 'questions'),
].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use(express.json({ limit: '50mb' }));
app.use('/pdftest/files', express.static(UPLOADS_DIR));

// ── Auth ──────────────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token gerekli' });
  const token = h.split(' ')[1];

  // 1. Önce kendi JWT'mizi dene
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.uid = decoded.uid;
    return next();
  } catch {}

  // 2. Firebase Admin varsa dene
  if (admin.apps.length) {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      req.uid = decoded.uid;
      return next();
    } catch {}
  }

  res.status(401).json({ error: 'Geçersiz token' });
}

// ── Login endpoint ────────────────────────────────────────────────────────────
app.post('/pdftest/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });

  const user = USERS.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });

  const token = jwt.sign(
    { uid: user.uid, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token, uid: user.uid, displayName: user.displayName });
});

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const d = path.join(UPLOADS_DIR, req.uid);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    cb(null, d);
  },
  filename: (req, file, cb) => cb(null, `${req.body.id}.pdf`),
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── Chunk upload ─────────────────────────────────────────────────────────────
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const userDir = path.join(UPLOADS_DIR, req.uid);
      const chunksDir = path.join(userDir, 'chunks');
      [userDir, chunksDir].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      });
      cb(null, chunksDir);
    },
    filename: (req, file, cb) => {
      const id = req.headers['x-upload-id'] || req.body.id || 'tmp';
      const idx = req.headers['x-chunk-index'] || req.body.chunkIndex || '0';
      cb(null, `${id}_${idx}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post('/pdftest/api/pdfs/chunk', requireAuth, chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { id, chunkIndex, totalChunks, name, subject, category, addedAt, size } = req.body;
    const ci = parseInt(chunkIndex);
    const total = parseInt(totalChunks);

    if (ci < total - 1) {
      return res.json({ ok: true, chunk: ci });
    }

    const userDir = path.join(UPLOADS_DIR, req.uid);
    const chunksDir = path.join(userDir, 'chunks');
    const finalPath = path.join(userDir, `${id}.pdf`);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < total; i++) {
      const chunkPath = path.join(chunksDir, `${id}_${i}`);
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
      fs.unlinkSync(chunkPath);
    }
    writeStream.end();
    await new Promise(r => writeStream.on('finish', r));

    db.prepare(`INSERT INTO pdfs (id,uid,name,subject,category,added_at,size,filename)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(id, req.uid, name, subject, category, +addedAt, +size, `${id}.pdf`);

    const url = `${req.protocol}://${req.get('host')}/pdftest/files/${req.uid}/${id}.pdf`;
    res.json({ success: true, id, url });
  } catch (err) {
    console.error('Chunk upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Chunk upload ─────────────────────────────────────────────────────────────
// ── PDF ───────────────────────────────────────────────────────────────────────
app.get('/pdftest/api/pdfs', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM pdfs WHERE uid=? ORDER BY added_at DESC').all(req.uid);
  res.json(rows.map(r => ({
    id: r.id, name: r.name, subject: r.subject, category: r.category,
    addedAt: r.added_at, size: r.size, isCloud: true,
    url: `${req.protocol}://${req.get('host')}/pdftest/files/${req.uid}/${r.filename}`,
  })));
});

app.post('/pdftest/api/pdfs', requireAuth, upload.single('file'), (req, res) => {
  try {
    const { id, name, subject, category, addedAt, size } = req.body;
    db.prepare(`INSERT INTO pdfs (id,uid,name,subject,category,added_at,size,filename)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(id, req.uid, name, subject, category, +addedAt, +size, `${id}.pdf`);
    const url = `${req.protocol}://${req.get('host')}/pdftest/files/${req.uid}/${id}.pdf`;
    res.json({ success: true, id, url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/pdftest/api/pdfs/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM pdfs WHERE id=? AND uid=?').get(req.params.id, req.uid);
  if (!row) return res.status(404).json({ error: 'Bulunamadı' });
  const fp = path.join(UPLOADS_DIR, req.uid, row.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM pdfs WHERE id=? AND uid=?').run(req.params.id, req.uid);
  res.json({ success: true });
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/pdftest/api/sessions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT data FROM sessions WHERE uid=? ORDER BY last_accessed DESC').all(req.uid);
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.put('/pdftest/api/sessions/:id', requireAuth, (req, res) => {
  db.prepare(`INSERT INTO sessions (id,uid,data,last_accessed) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, last_accessed=excluded.last_accessed`)
    .run(req.params.id, req.uid, JSON.stringify(req.body), Date.now());
  res.json({ success: true });
});

app.delete('/pdftest/api/sessions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=? AND uid=?').run(req.params.id, req.uid);
  res.json({ success: true });
});

// ── Question Images ──────────────────────────────────────────────────────────
app.post('/pdftest/api/questions/image', requireAuth, async (req, res) => {
  try {
    const { id, image } = req.body;
    if (!id || !image) return res.status(400).json({ error: 'id ve image gerekli' });

    const userDir = path.join(UPLOADS_DIR, req.uid, 'questions');
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    // base64 → PNG dosyası
    const base64Data = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    const filePath = path.join(userDir, `${id}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    const url = `${req.protocol}://${req.get('host')}/pdftest/files/${req.uid}/questions/${id}.jpg`;
    res.json({ url, imageFile: `${id}.jpg` });
  } catch (err) {
    console.error('Image save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Questions ─────────────────────────────────────────────────────────────────
app.get('/pdftest/api/questions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT data FROM questions WHERE uid=? ORDER BY date DESC').all(req.uid);
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.put('/pdftest/api/questions/:id', requireAuth, (req, res) => {
  const date = req.body.date || Date.now();
  db.prepare(`INSERT INTO questions (id,uid,data,date) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, date=excluded.date`)
    .run(req.params.id, req.uid, JSON.stringify(req.body), date);
  res.json({ success: true });
});

app.delete('/pdftest/api/questions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM questions WHERE id=? AND uid=?').run(req.params.id, req.uid);
  res.json({ success: true });
});

// ── Storage usage ─────────────────────────────────────────────────────────────
app.get('/pdftest/api/storage-usage', requireAuth, (req, res) => {
  try {
    const uid = req.uid;

    // PDF dosyaları
    const pdfRows = db.prepare("SELECT size FROM pdfs WHERE uid=?").all(uid);
    let pdfBytes = 0;
    let pdfCount = pdfRows.length;
    for (const r of pdfRows) {
      pdfBytes += r.size || 0;
    }

    // Soru resimleri (dosya boyutları)
    let imageBytes = 0;
    let imageCount = 0;
    const qDir = path.join(UPLOADS_DIR, uid, 'questions');
    if (fs.existsSync(qDir)) {
      const files = fs.readdirSync(qDir);
      imageCount = files.length;
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(qDir, f));
          imageBytes += stat.size;
        } catch {}
      }
    }

    // Not resimleri (dosya boyutları)
    let noteImageBytes = 0;
    let noteImageCount = 0;
    const nDir = path.join(UPLOADS_DIR, uid, 'notes');
    if (fs.existsSync(nDir)) {
      const files = fs.readdirSync(nDir);
      noteImageCount = files.length;
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(nDir, f));
          noteImageBytes += stat.size;
        } catch {}
      }
    }

    // Sessions (çizimler + işaretler dahil)
    const sessionRows = db.prepare("SELECT data FROM sessions WHERE uid=?").all(uid);
    let sessionBytes = 0;
    let sessionCount = sessionRows.length;
    let drawingCount = 0;
    let bookmarkCount = 0;
    let pdfMarkCount = 0;
    let readPageCount = 0;
    for (const r of sessionRows) {
      sessionBytes += Buffer.byteLength(r.data || '', 'utf8');
      try {
        const d = JSON.parse(r.data);
        if (Array.isArray(d.drawings)) drawingCount += d.drawings.length;
        if (Array.isArray(d.bookmarks)) bookmarkCount += d.bookmarks.length;
        if (Array.isArray(d.pdfMarks)) pdfMarkCount += d.pdfMarks.length;
        if (Array.isArray(d.readPages)) readPageCount += d.readPages.length;
      } catch {}
    }

    // Notlar (metin)
    const noteRows = db.prepare("SELECT data FROM notes WHERE uid=?").all(uid);
    let noteBytes = 0;
    let noteCount = noteRows.length;
    for (const r of noteRows) {
      noteBytes += Buffer.byteLength(r.data || '', 'utf8');
    }

    // Kaydedilmiş sorular (metadata JSON — fotoğraf hariç)
    const questionRows = db.prepare("SELECT data FROM questions WHERE uid=?").all(uid);
    let questionMetaBytes = 0;
    let questionCount = questionRows.length;
    for (const r of questionRows) {
      questionMetaBytes += Buffer.byteLength(r.data || '', 'utf8');
    }

    // Ezber kartları
    let memorizeBytes = 0;
    let memorizeCount = 0;
    try {
      const memRows = db.prepare("SELECT front, back, subject, topic FROM memorize_cards WHERE uid=?").all(uid);
      memorizeCount = memRows.length;
      for (const r of memRows) {
        memorizeBytes += Buffer.byteLength((r.front||'') + (r.back||'') + (r.subject||'') + (r.topic||''), 'utf8');
      }
    } catch {}

    const totalBytes = pdfBytes + imageBytes + noteImageBytes + sessionBytes + noteBytes + questionMetaBytes + memorizeBytes;

    res.json({
      bytes: totalBytes,
      // Ana kategoriler
      pdfBytes, pdfCount,
      imageBytes, imageCount,              // Soru resimleri (geriye dönük uyumluluk)
      noteImageBytes, noteImageCount,      // Not resimleri
      sessionBytes, sessionCount,
      noteBytes, noteCount,
      questionMetaBytes, questionCount,
      memorizeBytes, memorizeCount,
      // Detaylar (session içindekiler)
      drawingCount, bookmarkCount, pdfMarkCount, readPageCount,
    });

// ── Çalışma sayacı bildirimleri — Telegram'a ilet ─────────────────────
app.post('/pdftest/api/study/notify', requireAuth, async (req, res) => {
  try {
    const { title, body } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title gerekli' });

// ═══════════════════════════════════════════════════════════════════════
// ⏱ ÇALIŞMA SAYACI — Events, Daily, State
// ═══════════════════════════════════════════════════════════════════════

// DB: study_events, study_daily, study_state tabloları install script ile oluşturulur

// Günlük özet güncelleme yardımcısı
function updateStudyDaily(uid, date, deltaSeconds, blocks, mode) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM study_daily WHERE uid=? AND date=?').get(uid, date);
  if (existing) {
    db.prepare(
      'UPDATE study_daily SET total_seconds = MAX(total_seconds, ?), completed_blocks = MAX(completed_blocks, ?), last_ts = ?, mode = COALESCE(?, mode) WHERE uid=? AND date=?'
    ).run(deltaSeconds, blocks, now, mode, uid, date);
  } else {
    db.prepare(
      'INSERT INTO study_daily (uid, date, total_seconds, completed_blocks, mode, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(uid, date, deltaSeconds, blocks, mode, now, now);
  }
}

// Event kaydet (start/pause/resume/break/stop/heartbeat)
app.post('/pdftest/api/study/event', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : [body];

    const insert = db.prepare(
      'INSERT OR IGNORE INTO study_events (uid, event_id, type, ts, date, mode, phase, elapsed_in_phase, today_total_seconds, completed_blocks, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const trx = db.transaction((evs) => {
      for (const e of evs) {
        if (!e.event_id || !e.type || !e.ts || !e.date) continue;
        insert.run(
          uid,
          String(e.event_id),
          String(e.type),
          Number(e.ts) || Date.now(),
          String(e.date),
          e.mode || null,
          e.phase || null,
          Number(e.elapsed_in_phase) || 0,
          Number(e.today_total_seconds) || 0,
          Number(e.completed_blocks) || 0,
          e.meta ? JSON.stringify(e.meta) : null
        );
        // Daily özeti de güncelle
        updateStudyDaily(uid, e.date, Number(e.today_total_seconds) || 0, Number(e.completed_blocks) || 0, e.mode);
      }
    });
    trx(events);

    res.json({ ok: true, accepted: events.length });
  } catch (e) {
    console.error('study/event error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// Anlık state'i kaydet (crash recovery için)
app.post('/pdftest/api/study/state', (req, res, next) => {
  // Beacon (tarayıcı kapanışında) query param'dan token alabilir
  const beaconToken = req.query.beacon_token;
  if (beaconToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${beaconToken}`;
  }
  next();
}, requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const s = req.body || {};
    db.prepare(
      'INSERT OR REPLACE INTO study_state (uid, phase, mode, phase_started_at, accumulated_in_phase, completed_blocks, today_total_seconds, today_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      uid,
      s.phase || 'idle',
      s.mode || 'deepwork',
      Number(s.phase_started_at) || 0,
      Number(s.accumulated_in_phase) || 0,
      Number(s.completed_blocks) || 0,
      Number(s.today_total_seconds) || 0,
      s.today_date || '',
      Date.now()
    );

    // Ayrıca daily özeti de güncelle
    if (s.today_date && typeof s.today_total_seconds === 'number') {
      updateStudyDaily(uid, s.today_date, Number(s.today_total_seconds), Number(s.completed_blocks) || 0, s.mode);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('study/state POST error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// Mevcut state'i oku (sayfa açılışında restore için)
app.get('/pdftest/api/study/state', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const row = db.prepare('SELECT * FROM study_state WHERE uid=?').get(uid);
    if (!row) return res.json({ state: null });
    res.json({
      state: {
        phase: row.phase,
        mode: row.mode,
        phase_started_at: row.phase_started_at,
        accumulated_in_phase: row.accumulated_in_phase,
        completed_blocks: row.completed_blocks,
        today_total_seconds: row.today_total_seconds,
        today_date: row.today_date,
        updated_at: row.updated_at,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Günlük geçmişi oku (grafik için)
app.get('/pdftest/api/study/daily', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const rows = db.prepare(
      'SELECT date, total_seconds, completed_blocks, mode FROM study_daily WHERE uid=? ORDER BY date DESC LIMIT ?'
    ).all(uid, days);
    res.json({ daily: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Günlük hedef + özel ayarlar (server-side saklı)
app.get('/pdftest/api/study/settings', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const row = db.prepare("SELECT data FROM notes WHERE uid=? AND id='__study_settings__'").get(uid);
    if (!row) return res.json({ settings: null });
    try { res.json({ settings: JSON.parse(row.data) }); }
    catch { res.json({ settings: null }); }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/pdftest/api/study/settings', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const data = JSON.stringify(req.body || {});
    const now = Date.now();
    db.prepare(
      "INSERT OR REPLACE INTO notes (id, uid, data, date) VALUES ('__study_settings__', ?, ?, ?)"
    ).run(uid, data, now);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Temizlik: 30 günden eski heartbeat event'leri sil (sadece daily özet kalsın)
app.post('/pdftest/api/study/cleanup', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const cutoff = Date.now() - 30 * 86400000;
    const r = db.prepare("DELETE FROM study_events WHERE uid=? AND type='heartbeat' AND ts < ?").run(uid, cutoff);
    res.json({ ok: true, deleted: r.changes });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// ── Frontend hata kayıt — her client error burada loglanır ────────────
app.post('/pdftest/api/client-error', async (req, res) => {
  try {
    const { message, stack, userAgent, url, mode, component } = req.body || {};
    const ts = new Date().toISOString();
    const logLine = JSON.stringify({
      ts, message, stack, userAgent, url, mode, component,
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
    }) + '\n';
    
    try {
      fs.appendFileSync('/var/log/pdftest/client-errors.log', logLine);
    } catch (e) { console.error('Log write failed:', e); }
    
    // Telegram'a uyarı gönder (opsiyonel)
    const TG_TOKEN = process.env.PDFTEST_TG_TOKEN;
    const TG_CHAT_ID = process.env.PDFTEST_TG_CHAT_ID || '860174169';
    if (TG_TOKEN && message) {
      try {
        const short = String(message).slice(0, 200);
        const text = `🐛 *Frontend Hatası*\n\n\`${short}\`\n\nURL: ${url || '?'}\nMode: ${mode || '?'}`;
        fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown',
            disable_notification: true,
          }),
        }).catch(()=>{});
      } catch {}
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error('client-error endpoint:', e);
    res.status(500).json({ error: String(e) });
  }
});

    
    // Env'den token ve chat_id
    const TG_TOKEN = process.env.PDFTEST_TG_TOKEN;
    const TG_CHAT_ID = process.env.PDFTEST_TG_CHAT_ID || '860174169';
    
    if (!TG_TOKEN) {
      // Token yoksa 200 dön ama içerik boş — frontend sessizce devam etsin
      return res.json({ ok: false, reason: 'no_token' });
    }
    
    const text = body ? `*${title}*\n${body}` : `*${title}*`;
    const tgResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_notification: false,
      }),
    });
    const j = await tgResp.json();
    res.json({ ok: j.ok === true });
  } catch (e) {
    console.error('study notify error:', e);
    res.status(500).json({ error: String(e) });
  }
});

  } catch (e) {
    console.error('storage-usage error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Konu Takibi ──────────────────────────────────────────────────────────────
app.get('/pdftest/api/tracking', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM topic_tracking WHERE uid=? ORDER BY subject, topic').all(req.uid);
  res.json(rows);
});

app.put('/pdftest/api/tracking/:id', requireAuth, (req, res) => {
  const { subject, topic, pdf_id, pdf_name, question_count, correct_count, wrong_count, status } = req.body;
  db.prepare(`
    INSERT INTO topic_tracking (id, uid, subject, topic, pdf_id, pdf_name, question_count, correct_count, wrong_count, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      question_count=excluded.question_count,
      correct_count=excluded.correct_count,
      wrong_count=excluded.wrong_count,
      status=excluded.status,
      pdf_name=excluded.pdf_name,
      updated_at=excluded.updated_at
  `).run(req.params.id, req.uid, subject, topic, pdf_id, pdf_name, question_count || 0, correct_count || 0, wrong_count || 0, status || 'pending', Date.now());
  res.json({ success: true });
});

app.delete('/pdftest/api/tracking/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM topic_tracking WHERE id=? AND uid=?').run(req.params.id, req.uid);
  res.json({ success: true });
});

app.get('/pdftest/api/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 pdftest backend port ${PORT} | data: ${DATA_DIR}`);
});

// ── Önemli Notlar ──────────────────────────────────────────────────────────
app.get('/pdftest/api/notes', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT data FROM notes WHERE uid=? ORDER BY date DESC').all(req.uid);
    res.json(rows.map(r => JSON.parse(r.data)));
  } catch { res.json([]); }
});

app.put('/pdftest/api/notes/:id', requireAuth, (req, res) => {
  db.prepare(`INSERT INTO notes (id,uid,data,date) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, date=excluded.date`)
    .run(req.params.id, req.uid, JSON.stringify(req.body), Date.now());
  res.json({ success: true });
});

app.delete('/pdftest/api/notes/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM notes WHERE id=? AND uid=?').run(req.params.id, req.uid);
  res.json({ success: true });
});

app.post('/pdftest/api/notes/image', requireAuth, async (req, res) => {
  try {
    const { id, image } = req.body;
    if (!id || !image) return res.status(400).json({ error: 'id ve image gerekli' });
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const userDir = path.join(UPLOADS_DIR, req.uid, 'notes');
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const filename = `${id}.jpg`;
    fs.writeFileSync(path.join(userDir, filename), buffer);
    const url = `/pdftest/api/notes/image/${req.uid}/${filename}`;
    res.json({ url, imageFile: `${id}.jpg` });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/pdftest/api/notes/image/:uid/:filename', (req, res) => {
  const fp = path.join(UPLOADS_DIR, req.params.uid, 'notes', req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.sendFile(fp);
});
app.get('/pdftest/api/questions/image/:uid/:filename', (req, res) => {
  const fp = path.join(UPLOADS_DIR, req.params.uid, 'questions', req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.sendFile(fp);
});


// ── Ezber (Memorize Cards) endpoints ─────────────────────────────────────
app.get('/pdftest/api/memorize', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM memorize_cards WHERE uid = ? ORDER BY created_at DESC').all(req.uid);
    const cards = rows.map(r => ({
      id: r.id,
      subject: r.subject,
      topic: r.topic || '',
      front: r.front,
      back: r.back,
      createdAt: r.created_at,
      nextReviewDate: r.next_review_date || undefined,
      reviewCount: r.review_count || 0,
      easeFactor: r.ease_factor || 2.5,
      intervalDays: r.interval_days || 0,
      lapses: r.lapses || 0,
      lastReviewedAt: r.last_reviewed_at || undefined,
    }));
    res.json(cards);
  } catch (e) {
    console.error('memorize GET error:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.put('/pdftest/api/memorize/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const c = req.body || {};
    if (!c.subject || !c.front || !c.back) {
      return res.status(400).json({ error: 'subject, front, back gerekli' });
    }
    db.prepare(`INSERT OR REPLACE INTO memorize_cards
      (id, uid, subject, topic, front, back, created_at, next_review_date, review_count, ease_factor, interval_days, lapses, last_reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, req.uid, c.subject, c.topic || '', c.front, c.back,
        c.createdAt || Date.now(),
        c.nextReviewDate || null,
        c.reviewCount || 0,
        c.easeFactor || 2.5,
        c.intervalDays || 0,
        c.lapses || 0,
        c.lastReviewedAt || null
      );
    res.json({ ok: true, id });
  } catch (e) {
    console.error('memorize PUT error:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/pdftest/api/memorize/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM memorize_cards WHERE id = ? AND uid = ?').run(req.params.id, req.uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

