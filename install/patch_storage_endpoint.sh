#!/bin/bash
# Backend storage-usage endpoint'ini genişlet — tüm veri tipleri için bayt sayımı
set -e

SERVER="/var/www/pdftest/backend/server.js"
BACKUP="${SERVER}.bak.$(date +%s)"
cp "$SERVER" "$BACKUP"
echo "✓ Yedek: $BACKUP"

python3 <<'PYEOF'
import re

path = "/var/www/pdftest/backend/server.js"
with open(path) as f:
    content = f.read()

# Yeni endpoint kodu — replace old storage-usage
new_endpoint = '''
app.get('/pdftest/api/storage-usage', requireAuth, (req, res) => {
  try {
    const uid = req.uid;
    const path = require('path');
    const fs = require('fs');

    // PDF dosyaları
    const pdfRows = db.prepare("SELECT data FROM pdfs WHERE uid=?").all(uid);
    let pdfBytes = 0;
    let pdfCount = pdfRows.length;
    for (const r of pdfRows) {
      try {
        const d = JSON.parse(r.data);
        pdfBytes += d.size || 0;
      } catch {}
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
  } catch (e) {
    console.error('storage-usage error:', e);
    res.status(500).json({ error: String(e) });
  }
});
'''

# Eski endpoint'i bul ve değiştir
pattern = r"app\.get\(['\"]\/pdftest\/api\/storage-usage['\"].*?^\}\);"
match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
if match:
    content = content[:match.start()] + new_endpoint.strip() + content[match.end():]
    print("✅ storage-usage endpoint değiştirildi")
else:
    # Yoksa ekle — notes image endpoint'inden sonra
    marker = "app.get('/pdftest/api/notes/image/:uid/:filename'"
    idx = content.find(marker)
    if idx > 0:
        end = content.find("});", idx)
        if end > 0:
            end += 3
            content = content[:end] + "\n" + new_endpoint + content[end:]
            print("✅ storage-usage endpoint eklendi")
        else:
            print("⚠️  Yerleştirme noktası bulunamadı")
    else:
        print("⚠️  Notes endpoint bulunamadı")

with open(path, 'w') as f:
    f.write(content)
PYEOF

echo "✓ server.js güncellendi"
echo ""
echo "pm2 restart pdftest-api"
