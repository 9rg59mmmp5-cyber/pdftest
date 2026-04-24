#!/bin/bash
# Backend'e frontend hata kayıt endpoint'i + Telegram bildirimi ekler
set -e

SERVER="/var/www/pdftest/backend/server.js"
BACKUP="${SERVER}.bak.$(date +%s)"
cp "$SERVER" "$BACKUP"
echo "✓ Yedek: $BACKUP"

# Hata log dizini
sudo mkdir -p /var/log/pdftest
sudo touch /var/log/pdftest/client-errors.log
sudo chmod 664 /var/log/pdftest/client-errors.log
sudo chown www-data:www-data /var/log/pdftest/client-errors.log 2>/dev/null || true

python3 <<'PYEOF'
path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

if "/pdftest/api/client-error" in content:
    print("⚠️  Endpoint zaten var — atlanıyor")
    exit()

new_endpoint = '''
// ── Frontend hata kayıt — her client error burada loglanır ────────────
app.post('/pdftest/api/client-error', async (req, res) => {
  try {
    const { message, stack, userAgent, url, mode, component } = req.body || {};
    const ts = new Date().toISOString();
    const logLine = JSON.stringify({
      ts, message, stack, userAgent, url, mode, component,
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
    }) + '\\n';
    
    try {
      fs.appendFileSync('/var/log/pdftest/client-errors.log', logLine);
    } catch (e) { console.error('Log write failed:', e); }
    
    // Telegram'a uyarı gönder (opsiyonel)
    const TG_TOKEN = process.env.PDFTEST_TG_TOKEN;
    const TG_CHAT_ID = process.env.PDFTEST_TG_CHAT_ID || '860174169';
    if (TG_TOKEN && message) {
      try {
        const short = String(message).slice(0, 200);
        const text = `🐛 *Frontend Hatası*\\n\\n\`${short}\`\\n\\nURL: ${url || '?'}\\nMode: ${mode || '?'}`;
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
'''

marker = "app.post('/pdftest/api/study/notify'"
idx = content.find(marker)
if idx > 0:
    end = content.find('});', idx)
    if end > 0:
        end += 3
        content = content[:end] + '\n' + new_endpoint + content[end:]
        with open(path, 'w') as f:
            f.write(content)
        print("✅ /client-error endpoint eklendi (study/notify'den sonra)")
else:
    # study/notify yoksa storage-usage'dan sonra
    marker = "app.get('/pdftest/api/storage-usage'"
    idx = content.find(marker)
    if idx > 0:
        end = content.find('});', idx)
        if end > 0:
            end += 3
            content = content[:end] + '\n' + new_endpoint + content[end:]
            with open(path, 'w') as f:
                f.write(content)
            print("✅ /client-error endpoint eklendi (storage-usage'dan sonra)")
PYEOF

pm2 restart pdftest-api
sleep 2

# Test
curl -s -X POST http://localhost:4001/pdftest/api/client-error \
  -H "Content-Type: application/json" \
  -d '{"message":"test hata","url":"/test","mode":"setup"}' | head

echo ""
echo "✓ Hata logu: /var/log/pdftest/client-errors.log"
echo "   tail -f /var/log/pdftest/client-errors.log"
