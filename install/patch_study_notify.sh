#!/bin/bash
# /pdftest/api/study/notify endpoint ekler
set -e

SERVER="/var/www/pdftest/backend/server.js"
BACKUP="${SERVER}.bak.$(date +%s)"
cp "$SERVER" "$BACKUP"
echo "✓ Yedek: $BACKUP"

python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

# Zaten var mı kontrol
if "/pdftest/api/study/notify" in content:
    print("⚠️  Endpoint zaten var — atlanıyor")
    exit()

new_endpoint = '''
// ── Çalışma sayacı bildirimleri — Telegram'a ilet ─────────────────────
app.post('/pdftest/api/study/notify', requireAuth, async (req, res) => {
  try {
    const { title, body } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title gerekli' });
    
    // Env'den token ve chat_id
    const TG_TOKEN = process.env.PDFTEST_TG_TOKEN;
    const TG_CHAT_ID = process.env.PDFTEST_TG_CHAT_ID || '860174169';
    
    if (!TG_TOKEN) {
      // Token yoksa 200 dön ama içerik boş — frontend sessizce devam etsin
      return res.json({ ok: false, reason: 'no_token' });
    }
    
    const text = body ? `*${title}*\\n${body}` : `*${title}*`;
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
'''

# storage-usage endpoint'inden sonra ekle (mantıksal olarak yakın yer)
marker = "app.get('/pdftest/api/storage-usage'"
idx = content.find(marker)
if idx > 0:
    # o endpoint'in kapanışını bul
    end = content.find('});', idx)
    if end > 0:
        end += 3
        content = content[:end] + '\n' + new_endpoint + content[end:]
        with open(path, 'w') as f:
            f.write(content)
        print("✅ /study/notify endpoint eklendi")
    else:
        print("❌ Kapanış bulunamadı")
else:
    print("❌ storage-usage marker bulunamadı")
PYEOF

# PM2 ecosystem'e TG env ekle
echo ""
echo "⚠  pdftest-api pm2 ecosystem'ine Telegram env'leri eklemek lazım."
echo "   Eğer /etc/pdftest-api.env dosyan varsa oraya ekle:"
echo "     PDFTEST_TG_TOKEN=<token>"
echo "     PDFTEST_TG_CHAT_ID=860174169"
echo ""
echo "   VEYA pdftest-tgbot env'ini pdftest-api'ye de eklemek için:"
echo "   pm2 restart pdftest-api --update-env komutuyla restart et."
echo ""
pm2 restart pdftest-api
sleep 2
curl -s -o /dev/null -w "Study notify test: HTTP %{http_code}\n" \
  -X POST http://localhost:4001/pdftest/api/study/notify \
  -H "Content-Type: application/json" \
  -d '{"title":"test"}'
echo "   (401 = endpoint çalışıyor, sadece auth gerekli — doğru)"
