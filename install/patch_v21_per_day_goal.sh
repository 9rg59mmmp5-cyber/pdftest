#!/bin/bash
# v21 — günlük özel hedef (goal_minutes) desteği
set -e

SERVER="/var/www/pdftest/backend/server.js"
DB="/var/www/pdftest-data/pdftest.sqlite"

# 1) DB'ye goal_minutes kolonu ekle (yoksa)
echo "📊 DB schema güncelleniyor..."
sqlite3 "$DB" "ALTER TABLE study_daily ADD COLUMN goal_minutes INTEGER DEFAULT 0;" 2>&1 | grep -v "duplicate column" || true
echo "✓ goal_minutes kolonu hazır"

# 2) Backend endpoint'leri güncelle
cp "$SERVER" "${SERVER}.bak.$(date +%s)"

python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

# set-daily endpoint'ini güncelle — goal_minutes alabilsin
old = """app.post('/pdftest/api/study/set-daily', requireAuth, (req, res) => {
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
});"""

new = """app.post('/pdftest/api/study/set-daily', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const { date, total_seconds, goal_minutes } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date gerekli' });
    const existing = db.prepare('SELECT 1 FROM study_daily WHERE uid=? AND date=?').get(uid, date);
    if (existing) {
      // Sadece sağlanan alanları güncelle
      if (typeof total_seconds === 'number' && typeof goal_minutes === 'number') {
        db.prepare('UPDATE study_daily SET total_seconds=?, goal_minutes=?, last_ts=? WHERE uid=? AND date=?').run(total_seconds, goal_minutes, Date.now(), uid, date);
      } else if (typeof total_seconds === 'number') {
        db.prepare('UPDATE study_daily SET total_seconds=?, last_ts=? WHERE uid=? AND date=?').run(total_seconds, Date.now(), uid, date);
      } else if (typeof goal_minutes === 'number') {
        db.prepare('UPDATE study_daily SET goal_minutes=?, last_ts=? WHERE uid=? AND date=?').run(goal_minutes, Date.now(), uid, date);
      }
    } else {
      db.prepare('INSERT INTO study_daily (uid, date, total_seconds, completed_blocks, mode, first_ts, last_ts, goal_minutes) VALUES (?, ?, ?, 0, ?, ?, ?, ?)').run(
        uid, date, total_seconds || 0, 'deepwork', Date.now(), Date.now(), goal_minutes || 0
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});"""

if old in content:
    content = content.replace(old, new)
    print("set-daily endpoint guncellendi")
else:
    print("set-daily endpoint bulunamadi (zaten guncel olabilir)")

# /study/daily endpoint'inde goal_minutes da dönsün
old_daily = """app.get('/pdftest/api/study/daily', requireAuth, (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const rows = db.prepare(
      'SELECT date, total_seconds, completed_blocks, mode FROM study_daily WHERE uid=? ORDER BY date DESC LIMIT ?'
    ).all(req.uid, days);
    res.json({ daily: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});"""

new_daily = """app.get('/pdftest/api/study/daily', requireAuth, (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const rows = db.prepare(
      'SELECT date, total_seconds, completed_blocks, mode, goal_minutes FROM study_daily WHERE uid=? ORDER BY date DESC LIMIT ?'
    ).all(req.uid, days);
    res.json({ daily: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});"""

if old_daily in content:
    content = content.replace(old_daily, new_daily)
    print("daily endpoint guncellendi")

with open(path, 'w') as f:
    f.write(content)
PYEOF

pm2 restart pdftest-api
sleep 2

echo ""
echo "── Test ──"
curl -s -o /dev/null -w "set-daily: HTTP %{http_code}\n" -X POST http://localhost:4001/pdftest/api/study/set-daily -H "Content-Type: application/json" -d '{}'
curl -s -o /dev/null -w "daily: HTTP %{http_code}\n" http://localhost:4001/pdftest/api/study/daily
echo "Beklenen: 401 (auth)"
