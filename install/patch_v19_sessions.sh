#!/bin/bash
# v19 — sessions list/delete endpoints
set -e

SERVER="/var/www/pdftest/backend/server.js"
cp "$SERVER" "${SERVER}.bak.$(date +%s)"

python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

if '/pdftest/api/study/sessions' in content:
    print("Sessions endpointleri zaten var")
    exit()

new_endpoints = '''

// ── Çalışma oturumları — gün bazında event listesi ────────────────────
app.get('/pdftest/api/study/sessions', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const date = req.query.date || '';
    if (!date) return res.status(400).json({ error: 'date gerekli' });
    const rows = db.prepare(
      "SELECT id, event_id, type, ts, mode, phase, elapsed_in_phase, today_total_seconds, completed_blocks FROM study_events WHERE uid=? AND date=? AND type != 'heartbeat' ORDER BY ts ASC"
    ).all(uid, date);
    res.json({ events: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Bir gunun tum verilerini sil
app.post('/pdftest/api/study/delete-day', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const { date } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date gerekli' });
    db.prepare('DELETE FROM study_events WHERE uid=? AND date=?').run(uid, date);
    db.prepare('DELETE FROM study_daily WHERE uid=? AND date=?').run(uid, date);
    // Eger bugun siliniyorsa state'i de resetle
    const today = new Date().toISOString().slice(0,10);
    if (date === today) {
      db.prepare(
        "UPDATE study_state SET phase='idle', phase_started_at=0, accumulated_in_phase=0, completed_blocks=0, today_total_seconds=0, updated_at=? WHERE uid=?"
      ).run(Date.now(), uid);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Tek event sil
app.post('/pdftest/api/study/delete-event', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const { event_id } = req.body || {};
    if (!event_id) return res.status(400).json({ error: 'event_id gerekli' });
    const r = db.prepare('DELETE FROM study_events WHERE uid=? AND event_id=?').run(uid, event_id);
    res.json({ ok: true, deleted: r.changes });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Manuel daily total override (yanlis kayitlari duzeltmek icin)
app.post('/pdftest/api/study/set-daily', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const { date, total_seconds } = req.body || {};
    if (!date || typeof total_seconds !== 'number') {
      return res.status(400).json({ error: 'date ve total_seconds gerekli' });
    }
    const existing = db.prepare('SELECT 1 FROM study_daily WHERE uid=? AND date=?').get(uid, date);
    if (existing) {
      db.prepare('UPDATE study_daily SET total_seconds=?, last_ts=? WHERE uid=? AND date=?').run(total_seconds, Date.now(), uid, date);
    } else {
      db.prepare('INSERT INTO study_daily (uid, date, total_seconds, completed_blocks, mode, first_ts, last_ts) VALUES (?, ?, ?, 0, ?, ?, ?)').run(uid, date, total_seconds, 'deepwork', Date.now(), Date.now());
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
'''

if 'app.listen(' in content:
    idx = content.find('app.listen(')
    content = content[:idx] + new_endpoints + '\n' + content[idx:]
    with open(path, 'w') as f:
        f.write(content)
    print("OK Sessions endpointleri eklendi")
PYEOF

pm2 restart pdftest-api
sleep 2

# Test
curl -s -o /dev/null -w "sessions: HTTP %{http_code}\n" http://localhost:4001/pdftest/api/study/sessions?date=2026-04-28
curl -s -o /dev/null -w "delete-day: HTTP %{http_code}\n" -X POST http://localhost:4001/pdftest/api/study/delete-day -H "Content-Type: application/json" -d '{"date":"x"}'
echo "Beklenen: 401 (auth gerekli)"
