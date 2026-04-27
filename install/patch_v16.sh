#!/bin/bash
# v16 patch — exam-date endpoint + env restore + login fix
set -e

SERVER="/var/www/pdftest/backend/server.js"
ENV_FILE="/etc/pdftest-api.env"
EXAM_DATE_FILE="/var/www/pdftest-data/exam_date.txt"

# 1) Env dosyası — tek tırnak ile JSON
echo "🔐 /etc/pdftest-api.env güncelleniyor..."
sudo tee "$ENV_FILE" > /dev/null <<'EOF'
PDFTEST_USERS='[{"username":"halil","password":"sifre123","uid":"user1","displayName":"Halil"}]'
JWT_SECRET=Halil.1998
PDFTEST_TG_TOKEN=5747202724:AAHLfOnWPZE0TAyvFO0vEaJUYyVYYOOodC4
PDFTEST_TG_CHAT_ID=860174169
PORT=4001
DB_PATH=/var/www/pdftest-data/pdftest.sqlite
UPLOADS_DIR=/var/www/pdftest-data/uploads
EOF
sudo chmod 600 "$ENV_FILE"
echo "✅ Env dosyası hazır"

# 2) Sınav tarihi dosyası
if [ ! -f "$EXAM_DATE_FILE" ] || [ ! -s "$EXAM_DATE_FILE" ]; then
  echo "📅 Sınav tarihi dosyası oluşturuluyor: 2026-10-04"
  echo "2026-10-04" | sudo tee "$EXAM_DATE_FILE" > /dev/null
fi
echo "Mevcut tarih: $(cat $EXAM_DATE_FILE)"

# 3) server.js'e exam-date endpoint ekle (yoksa)
cp "$SERVER" "${SERVER}.bak.$(date +%s)"
python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

snippets = []

if '/pdftest/api/study/exam-date' not in content:
    snippets.append('''
const EXAM_DATE_FILE = '/var/www/pdftest-data/exam_date.txt';

app.get('/pdftest/api/study/exam-date', requireAuth, (req, res) => {
  try {
    let date = '';
    try { date = fs.readFileSync(EXAM_DATE_FILE, 'utf8').trim(); } catch {}
    res.json({ date });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/pdftest/api/study/exam-date', requireAuth, (req, res) => {
  try {
    const { date } = req.body || {};
    if (!date || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'YYYY-MM-DD formati bekleniyor' });
    }
    fs.writeFileSync(EXAM_DATE_FILE, date);
    res.json({ ok: true, date });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
''')

if '/pdftest/api/study/reset-today' not in content:
    snippets.append('''
app.post('/pdftest/api/study/reset-today', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const { date } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date gerekli' });
    db.prepare('DELETE FROM study_daily WHERE uid=? AND date=?').run(uid, date);
    db.prepare("DELETE FROM study_events WHERE uid=? AND date=?").run(uid, date);
    db.prepare(
      'INSERT OR REPLACE INTO study_state (uid, phase, mode, phase_started_at, accumulated_in_phase, completed_blocks, today_total_seconds, today_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uid, 'idle', 'deepwork', 0, 0, 0, 0, date, Date.now());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
''')

if snippets:
    block = '\n'.join(snippets)
    if 'app.listen(' in content:
        idx = content.find('app.listen(')
        content = content[:idx] + block + '\n' + content[idx:]
        with open(path, 'w') as f:
            f.write(content)
        print(f"Eklendi: {len(snippets)} endpoint blok")
    else:
        print("app.listen bulunamadi")
else:
    print("Tum endpointler zaten var")
PYEOF

# 4) PM2 yeniden başlat (env'leri yükle)
echo "🚀 pm2 restart..."
pm2 delete pdftest-api 2>/dev/null || true
set -a
source /etc/pdftest-api.env
set +a
pm2 start /var/www/pdftest/backend/server.js --name pdftest-api --update-env
pm2 save

sleep 3

# 5) Test
echo ""
echo "── Testler ──"
LOGIN=$(curl -s -X POST http://localhost:4001/pdftest/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"halil","password":"sifre123"}')
echo "Login: ${LOGIN:0:80}"

TOKEN=$(echo "$LOGIN" | grep -oP '"token":"\K[^"]+' | head -1)
if [ -n "$TOKEN" ]; then
  EXAM=$(curl -s http://localhost:4001/pdftest/api/study/exam-date \
    -H "Authorization: Bearer $TOKEN")
  echo "Exam date: $EXAM"
  echo ""
  echo "✅ Login + exam-date çalışıyor"
else
  echo "❌ Login başarısız — logu kontrol et:"
  pm2 logs pdftest-api --lines 5 --nostream
fi
