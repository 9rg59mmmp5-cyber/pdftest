#!/bin/bash
# pdftest-api'ye study tracking endpoints ekler + DB schema oluşturur
set -e

SERVER="/var/www/pdftest/backend/server.js"
BACKUP="${SERVER}.bak.$(date +%s)"
cp "$SERVER" "$BACKUP"
echo "✓ Yedek: $BACKUP"

# DB'de tablo oluştur
echo "📊 Study tablolarını oluşturuyorum..."
sqlite3 /var/www/pdftest-data/pdftest.sqlite <<'SQL'
-- Her çalışma event'i (start/pause/resume/break/stop/heartbeat)
CREATE TABLE IF NOT EXISTS study_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  date TEXT NOT NULL,
  mode TEXT,
  phase TEXT,
  elapsed_in_phase INTEGER DEFAULT 0,
  today_total_seconds INTEGER DEFAULT 0,
  completed_blocks INTEGER DEFAULT 0,
  meta TEXT,
  UNIQUE(uid, event_id)
);
CREATE INDEX IF NOT EXISTS idx_study_events_uid_date ON study_events(uid, date);
CREATE INDEX IF NOT EXISTS idx_study_events_ts ON study_events(ts);

-- Günlük özet
CREATE TABLE IF NOT EXISTS study_daily (
  uid TEXT NOT NULL,
  date TEXT NOT NULL,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  completed_blocks INTEGER NOT NULL DEFAULT 0,
  mode TEXT,
  goal_minutes INTEGER,
  first_ts INTEGER,
  last_ts INTEGER,
  PRIMARY KEY (uid, date)
);

-- Son bilinen state (crash recovery için)
CREATE TABLE IF NOT EXISTS study_state (
  uid TEXT PRIMARY KEY,
  phase TEXT,
  mode TEXT,
  phase_started_at INTEGER,
  accumulated_in_phase INTEGER,
  completed_blocks INTEGER,
  today_total_seconds INTEGER,
  today_date TEXT,
  updated_at INTEGER
);
SQL
echo "✅ Tablolar hazır"

python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

if "/pdftest/api/study/event" in content:
    print("⚠️  Study endpoints zaten var — atlanıyor")
    exit()

new_endpoints = '''
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
'''

marker = "app.post('/pdftest/api/study/notify'"
idx = content.find(marker)
if idx > 0:
    # Bu endpointin sonuna ekle
    end = content.find('});', idx)
    if end > 0:
        end += 3
        content = content[:end] + '\n' + new_endpoints + content[end:]
        with open(path, 'w') as f:
            f.write(content)
        print("✅ Study tracking endpoints eklendi")
else:
    marker = "app.get('/pdftest/api/storage-usage'"
    idx = content.find(marker)
    if idx > 0:
        end = content.find('});', idx)
        if end > 0:
            end += 3
            content = content[:end] + '\n' + new_endpoints + content[end:]
            with open(path, 'w') as f:
                f.write(content)
            print("✅ Study tracking endpoints eklendi (storage-usage'dan sonra)")
        else:
            print("❌ Yerleştirme noktası bulunamadı")
    else:
        print("❌ Marker bulunamadı")
PYEOF

pm2 restart pdftest-api
sleep 2
pm2 logs pdftest-api --lines 5 --nostream | tail -10

# Test
curl -s http://localhost:4001/pdftest/api/study/event -X POST -H "Content-Type: application/json" -d '{}' | head -c 150
echo ""
echo ""
echo "✓ Beklenen: {\"error\":\"Token gerekli\"} = endpoint çalışıyor"
