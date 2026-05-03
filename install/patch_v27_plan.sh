#!/bin/bash
# v27 — Günlük Plan sistemi (plan_tasks tablosu + CRUD endpoints)
set -e

SERVER="/var/www/pdftest/backend/server.js"
DB="/var/www/pdftest-data/pdftest.sqlite"

# Backup
cp "$SERVER" "${SERVER}.bak.$(date +%s)"
echo "✓ Backup alındı"

# 1) DB tablosu
sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  start_time TEXT,
  duration_min INTEGER NOT NULL DEFAULT 30,
  subject TEXT,
  video_url TEXT,
  video_title TEXT,
  question_count INTEGER,
  question_source TEXT,
  exam_name TEXT,
  book_name TEXT,
  page_range TEXT,
  pdf_id TEXT,
  notes TEXT,
  completed INTEGER DEFAULT 0,
  completed_at INTEGER,
  actual_duration_sec INTEGER,
  correct_count INTEGER,
  order_idx INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_uid_date ON plan_tasks(uid, date);
SQL

echo "✓ plan_tasks tablosu hazır"

# 2) Endpoint'leri ekle
python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

endpoints = """
// ═════════════════════════════════════════════════════════════════════════
// 📅 GÜNLÜK PLAN (plan_tasks)
// ═════════════════════════════════════════════════════════════════════════

// Belirli bir günün görevlerini listele
app.get('/pdftest/api/plan/tasks', requireAuth, (req, res) => {
  try {
    const date = req.query.date;
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    
    let rows;
    if (date) {
      rows = db.prepare('SELECT * FROM plan_tasks WHERE uid=? AND date=? ORDER BY order_idx ASC, start_time ASC').all(req.uid, date);
    } else if (startDate && endDate) {
      rows = db.prepare('SELECT * FROM plan_tasks WHERE uid=? AND date>=? AND date<=? ORDER BY date ASC, order_idx ASC').all(req.uid, startDate, endDate);
    } else {
      // Default: son 30 gün
      rows = db.prepare("SELECT * FROM plan_tasks WHERE uid=? AND date >= date('now', '-30 days') ORDER BY date DESC, order_idx ASC").all(req.uid);
    }
    res.json({ tasks: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Yeni görev oluştur veya güncelle (upsert)
app.post('/pdftest/api/plan/tasks', requireAuth, (req, res) => {
  try {
    const t = req.body || {};
    if (!t.id || !t.date || !t.type || !t.title) {
      return res.status(400).json({ error: 'id, date, type, title gerekli' });
    }
    const existing = db.prepare('SELECT 1 FROM plan_tasks WHERE id=? AND uid=?').get(t.id, req.uid);
    if (existing) {
      db.prepare(`UPDATE plan_tasks SET
        date=?, type=?, title=?, start_time=?, duration_min=?, subject=?,
        video_url=?, video_title=?, question_count=?, question_source=?, exam_name=?,
        book_name=?, page_range=?, pdf_id=?, notes=?,
        completed=?, completed_at=?, actual_duration_sec=?, correct_count=?, order_idx=?
        WHERE id=? AND uid=?`).run(
        t.date, t.type, t.title, t.start_time || null, t.duration_min || 30, t.subject || null,
        t.video_url || null, t.video_title || null, t.question_count || null, t.question_source || null, t.exam_name || null,
        t.book_name || null, t.page_range || null, t.pdf_id || null, t.notes || null,
        t.completed ? 1 : 0, t.completed_at || null, t.actual_duration_sec || null, t.correct_count || null, t.order_idx || 0,
        t.id, req.uid
      );
    } else {
      db.prepare(`INSERT INTO plan_tasks (
        id, uid, date, type, title, start_time, duration_min, subject,
        video_url, video_title, question_count, question_source, exam_name,
        book_name, page_range, pdf_id, notes,
        completed, completed_at, actual_duration_sec, correct_count, order_idx, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        t.id, req.uid, t.date, t.type, t.title, t.start_time || null, t.duration_min || 30, t.subject || null,
        t.video_url || null, t.video_title || null, t.question_count || null, t.question_source || null, t.exam_name || null,
        t.book_name || null, t.page_range || null, t.pdf_id || null, t.notes || null,
        t.completed ? 1 : 0, t.completed_at || null, t.actual_duration_sec || null, t.correct_count || null, t.order_idx || 0,
        t.created_at || Date.now()
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Görev sil
app.delete('/pdftest/api/plan/tasks/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM plan_tasks WHERE id=? AND uid=?').run(req.params.id, req.uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Bir günü başka güne kopyala (template)
app.post('/pdftest/api/plan/copy', requireAuth, (req, res) => {
  try {
    const { from_date, to_date } = req.body;
    if (!from_date || !to_date) return res.status(400).json({ error: 'from_date ve to_date gerekli' });
    const tasks = db.prepare('SELECT * FROM plan_tasks WHERE uid=? AND date=?').all(req.uid, from_date);
    let count = 0;
    for (const t of tasks) {
      const newId = require('crypto').randomBytes(8).toString('hex');
      db.prepare(`INSERT INTO plan_tasks (
        id, uid, date, type, title, start_time, duration_min, subject,
        video_url, video_title, question_count, question_source, exam_name,
        book_name, page_range, pdf_id, notes,
        completed, completed_at, actual_duration_sec, correct_count, order_idx, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)`).run(
        newId, req.uid, to_date, t.type, t.title, t.start_time, t.duration_min, t.subject,
        t.video_url, t.video_title, t.question_count, t.question_source, t.exam_name,
        t.book_name, t.page_range, t.pdf_id, t.notes,
        t.order_idx, Date.now()
      );
      count++;
    }
    res.json({ ok: true, copied: count });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

"""

if "/plan/tasks" not in content:
    # En sona ekle (server listen'den önce)
    if 'app.listen' in content:
        content = content.replace('app.listen', endpoints + '\napp.listen', 1)
    else:
        content += '\n' + endpoints
    with open(path, 'w') as f:
        f.write(content)
    print("✓ Plan endpoint'leri eklendi")
else:
    print("✓ Plan endpoint'leri zaten var")

PYEOF

# Restart
pm2 restart pdftest-api
sleep 2

echo ""
echo "── Test ──"
curl -s -o /dev/null -w "GET tasks: HTTP %{http_code}\n" "http://localhost:4001/pdftest/api/plan/tasks?date=2026-04-30"
curl -s -o /dev/null -w "POST tasks: HTTP %{http_code}\n" -X POST "http://localhost:4001/pdftest/api/plan/tasks" -H "Content-Type: application/json" -d '{}'
echo "Beklenen: 401"

echo ""
echo "✅ v27 backend deploy edildi"
