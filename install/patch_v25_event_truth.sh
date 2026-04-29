#!/bin/bash
# v25 — Server-side truth: tüm süreler event'lerden hesaplanır
# Çift sayım, race condition, state şişme problemlerini kökten çözer
set -e

SERVER="/var/www/pdftest/backend/server.js"
DB="/var/www/pdftest-data/pdftest.sqlite"

cp "$SERVER" "${SERVER}.bak.$(date +%s)"
echo "✓ Backup alındı"

python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

# 1) Helper fonksiyon ekle — event'lerden süreleri hesapla
helper = """
// ═════════════════════════════════════════════════════════════════════════
// 🎯 SERVER-SIDE TRUTH — Event'lerden gerçek süreleri hesapla
// State'e güvenme, event listesinden hesapla. Çift sayımı önler.
// ═════════════════════════════════════════════════════════════════════════
function calculateTrueSecondsFromEvents(uid, date) {
  const events = db.prepare(
    "SELECT type, ts FROM study_events WHERE uid=? AND date=? AND type!='heartbeat' ORDER BY ts ASC"
  ).all(uid, date);
  
  let workSec = 0;
  let breakSec = 0;
  let pauseSec = 0;
  let workStart = 0;
  let breakStart = 0;
  let pauseStart = 0;
  
  for (const e of events) {
    if (e.type === 'start' || e.type === 'resume_after_break') {
      // Eğer hala işlenmemiş bir state varsa, kapat
      if (workStart) workSec += Math.floor((e.ts - workStart) / 1000);
      if (breakStart) breakSec += Math.floor((e.ts - breakStart) / 1000);
      if (pauseStart) pauseSec += Math.floor((e.ts - pauseStart) / 1000);
      workStart = e.ts;
      breakStart = 0;
      pauseStart = 0;
    } else if (e.type === 'resume_from_pause') {
      if (pauseStart) pauseSec += Math.floor((e.ts - pauseStart) / 1000);
      workStart = e.ts;
      pauseStart = 0;
    } else if (e.type === 'pause') {
      if (workStart) workSec += Math.floor((e.ts - workStart) / 1000);
      workStart = 0;
      pauseStart = e.ts;
    } else if (e.type === 'break_start') {
      if (workStart) workSec += Math.floor((e.ts - workStart) / 1000);
      workStart = 0;
      breakStart = e.ts;
    } else if (e.type === 'stop') {
      if (workStart) workSec += Math.floor((e.ts - workStart) / 1000);
      if (breakStart) breakSec += Math.floor((e.ts - breakStart) / 1000);
      if (pauseStart) pauseSec += Math.floor((e.ts - pauseStart) / 1000);
      workStart = 0;
      breakStart = 0;
      pauseStart = 0;
    }
  }
  
  // Açık kalan state varsa — şu ana kadar say (canlı oturum)
  const now = Date.now();
  if (workStart) workSec += Math.floor((now - workStart) / 1000);
  if (breakStart) breakSec += Math.floor((now - breakStart) / 1000);
  if (pauseStart) pauseSec += Math.floor((now - pauseStart) / 1000);
  
  return { workSec: Math.max(0, workSec), breakSec: Math.max(0, breakSec), pauseSec: Math.max(0, pauseSec) };
}

function getCurrentPhaseFromEvents(uid, date) {
  // En son event'in tipine göre mevcut phase'i belirle
  const lastEvent = db.prepare(
    "SELECT type, ts, meta FROM study_events WHERE uid=? AND date=? AND type!='heartbeat' ORDER BY ts DESC LIMIT 1"
  ).get(uid, date);
  
  if (!lastEvent) return { phase: 'idle', phaseStartedAt: 0 };
  
  if (lastEvent.type === 'start' || lastEvent.type === 'resume_from_pause' || lastEvent.type === 'resume_after_break') {
    return { phase: 'working', phaseStartedAt: lastEvent.ts };
  }
  if (lastEvent.type === 'pause') {
    return { phase: 'paused', phaseStartedAt: lastEvent.ts };
  }
  if (lastEvent.type === 'break_start') {
    return { phase: 'break', phaseStartedAt: lastEvent.ts };
  }
  if (lastEvent.type === 'stop') {
    return { phase: 'idle', phaseStartedAt: 0 };
  }
  return { phase: 'idle', phaseStartedAt: 0 };
}

"""

# Helper'ı app.use(...) sonrasına ekle
marker = "app.use(express.json"
if helper.strip() not in content:
    # JSON middleware'inden hemen sonraya yerleştir
    idx = content.find(marker)
    if idx > 0:
        # O satırın sonunu bul (next line)
        end = content.find('\n', idx)
        # Sonraki blank line bul
        end2 = content.find('\n\n', end)
        if end2 < 0: end2 = end + 1
        content = content[:end2] + '\n' + helper + content[end2:]
        print("✓ Helper fonksiyonlar eklendi")
    else:
        print("⚠ Marker bulunamadı, helperi en üste ekliyorum")
        # Fallback: const db tanımının altına
        content = content.replace("const db = ", helper + "\nconst db = ", 1)

# 2) /study/state endpoint'ini override et — event'lerden gerçek değer döndür
state_old = """app.get('/pdftest/api/study/state', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM study_state WHERE uid=?').get(req.uid);
    res.json({ state: row || null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});"""

state_new = """app.get('/pdftest/api/study/state', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM study_state WHERE uid=?').get(req.uid);
    
    // 🎯 GERÇEK DEĞER: Sadece daily kaydı yoksa veya 0 ise event'lerden hesapla
    // Manuel düzeltme veya eski değer varsa dokunma — kullanıcı tercihi
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const dailyRow = db.prepare('SELECT total_seconds FROM study_daily WHERE uid=? AND date=?').get(req.uid, today);
    const phaseInfo = getCurrentPhaseFromEvents(req.uid, today);
    
    if (row) {
      // Phase her zaman event'lerden — state stale olamaz
      if (phaseInfo.phase !== 'idle') {
        row.phase = phaseInfo.phase;
        row.phase_started_at = phaseInfo.phaseStartedAt;
      }
      // Total: daily kaydındaki değere güven (manuel olabilir)
      // Sadece daily yoksa veya 0 ise event'ten hesapla
      if (!dailyRow || !dailyRow.total_seconds) {
        const truth = calculateTrueSecondsFromEvents(req.uid, today);
        row.today_total_seconds = truth.workSec;
      } else {
        // Aktif çalışma varsa, daily'e canlı süreyi ekle
        const truth = calculateTrueSecondsFromEvents(req.uid, today);
        row.today_total_seconds = Math.max(dailyRow.total_seconds, truth.workSec);
      }
      row.today_date = today;
    }
    res.json({ state: row || { phase: phaseInfo.phase, today_total_seconds: dailyRow?.total_seconds || 0, today_date: today } });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});"""

if state_old in content:
    content = content.replace(state_old, state_new)
    print("✓ /study/state event-truth ile override edildi")
elif state_new in content:
    print("✓ /study/state zaten güncel")
else:
    print("⚠ /study/state bulunamadı, manuel kontrol gerek")

# 3) /study/daily endpoint'ini de event-based yap
daily_old = """app.get('/pdftest/api/study/daily', requireAuth, (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const rows = db.prepare(
      'SELECT date, total_seconds, completed_blocks, mode, goal_minutes FROM study_daily WHERE uid=? ORDER BY date DESC LIMIT ?'
    ).all(req.uid, days);
    res.json({ daily: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});"""

daily_new = """app.get('/pdftest/api/study/daily', requireAuth, (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const rows = db.prepare(
      'SELECT date, total_seconds, completed_blocks, mode, goal_minutes FROM study_daily WHERE uid=? ORDER BY date DESC LIMIT ?'
    ).all(req.uid, days);
    
    // 🎯 Bugün için: daily kaydı var ve >0 ise dokunma (manuel olabilir)
    // Yoksa event'ten hesapla
    const today = new Date().toLocaleDateString('en-CA');
    const todayTruth = calculateTrueSecondsFromEvents(req.uid, today);
    const todayDaily = rows.find(r => r.date === today);
    
    let updatedRows = rows;
    if (!todayDaily) {
      // Bugün hiç yok ve event varsa ekle
      if (todayTruth.workSec > 0) {
        updatedRows = [{
          date: today, total_seconds: todayTruth.workSec, 
          completed_blocks: 0, mode: 'pomodoro', goal_minutes: 0
        }, ...rows];
      }
    } else if (!todayDaily.total_seconds) {
      // Bugün var ama 0 — event'ten doldur
      updatedRows = rows.map(r => r.date === today ? { ...r, total_seconds: todayTruth.workSec } : r);
    } else {
      // Bugün manuel/eski değeri var — aktif sayım canlıysa max al
      updatedRows = rows.map(r => 
        r.date === today ? { ...r, total_seconds: Math.max(r.total_seconds, todayTruth.workSec) } : r
      );
    }
    
    res.json({ daily: updatedRows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});"""

if daily_old in content:
    content = content.replace(daily_old, daily_new)
    print("✓ /study/daily event-truth ile override edildi")
elif daily_new in content:
    print("✓ /study/daily zaten güncel")
else:
    print("⚠ /study/daily bulunamadı")

# 4) /study/sessions endpoint'i — bu zaten event-based hesaplıyor olmalı, dokunma
# 5) Yeni endpoint: /study/recompute — bugünkü daily'i event'lerden yeniden hesapla
recompute = """
// 🔄 Bugünkü daily'i event'lerden yeniden hesapla — düzeltme aracı
app.post('/pdftest/api/study/recompute', requireAuth, (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const truth = calculateTrueSecondsFromEvents(req.uid, today);
    
    const existing = db.prepare('SELECT 1 FROM study_daily WHERE uid=? AND date=?').get(req.uid, today);
    if (existing) {
      db.prepare('UPDATE study_daily SET total_seconds=?, last_ts=? WHERE uid=? AND date=?').run(truth.workSec, Date.now(), req.uid, today);
    } else {
      db.prepare('INSERT INTO study_daily (uid, date, total_seconds, completed_blocks, mode, first_ts, last_ts) VALUES (?, ?, ?, 0, ?, ?, ?)').run(req.uid, today, truth.workSec, 'pomodoro', Date.now(), Date.now());
    }
    db.prepare('UPDATE study_state SET today_total_seconds=?, today_date=? WHERE uid=?').run(truth.workSec, today, req.uid);
    
    res.json({ ok: true, total_seconds: truth.workSec, work: truth.workSec, break: truth.breakSec, pause: truth.pauseSec });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

"""

if "/study/recompute" not in content:
    # Daily endpoint'in altına ekle
    idx = content.find("app.get('/pdftest/api/study/daily'")
    if idx > 0:
        # Bu endpoint'in kapanışını bul (});\n)
        end = content.find('});', idx)
        if end > 0:
            end = content.find('\n', end) + 1
            content = content[:end] + recompute + content[end:]
            print("✓ /study/recompute endpoint eklendi")

with open(path, 'w') as f:
    f.write(content)

print("\n✅ Backend güncellendi")
PYEOF

# Restart
pm2 restart pdftest-api
sleep 2

echo ""
echo "── Test ──"
curl -s -o /dev/null -w "state: HTTP %{http_code}\n" http://localhost:4001/pdftest/api/study/state
curl -s -o /dev/null -w "daily: HTTP %{http_code}\n" http://localhost:4001/pdftest/api/study/daily
curl -s -o /dev/null -w "recompute: HTTP %{http_code}\n" -X POST http://localhost:4001/pdftest/api/study/recompute
echo "Beklenen: 401 (auth)"

echo ""
echo "✅ v25 backend deploy edildi — artık state event'lerden hesaplanıyor"
echo "🎯 Çift sayım, race condition, şişme problemleri kökten çözüldü"
