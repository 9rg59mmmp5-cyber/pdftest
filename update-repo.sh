#!/bin/bash
# pdftest repo otomatik güncelleme scripti
set -e
cd /root/pdftest-repo

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔄 pdftest repo güncelleniyor...${NC}"

copy_if_exists() {
    local src=$1
    local dst=$2
    if [ -f "$src" ]; then
        if ! cmp -s "$src" "$dst" 2>/dev/null; then
            mkdir -p "$(dirname "$dst")"
            cp "$src" "$dst"
            echo -e "  ${GREEN}✓${NC} $(basename $dst)"
        fi
    fi
}

echo -e "${BLUE}📂 Kaynak dosyalar kopyalanıyor...${NC}"
copy_if_exists "/tmp/pdftest/src/App.tsx"          "frontend/src/App.tsx"
copy_if_exists "/tmp/pdftest/src/main.tsx"         "frontend/src/main.tsx"
copy_if_exists "/tmp/pdftest/src/index.css"        "frontend/src/index.css"
copy_if_exists "/tmp/pdftest/index.html"           "frontend/index.html"
copy_if_exists "/tmp/pdftest/vite.config.ts"       "frontend/vite.config.ts"
copy_if_exists "/tmp/pdftest/tsconfig.json"        "frontend/tsconfig.json"
copy_if_exists "/tmp/pdftest/package.json"         "frontend/package.json"
copy_if_exists "/var/www/pdftest/backend/server.js"        "backend/server.js"
copy_if_exists "/var/www/pdftest/backend/package.json"     "backend/package.json"
copy_if_exists "/var/www/pdftest-ytgen/ytgen_server.py"    "ytgen/ytgen_server.py"
copy_if_exists "/var/www/pdftest-tgbot/tgbot_server.py"    "tgbot/tgbot_server.py"
copy_if_exists "/var/www/pdftest-tgbot/daily_reminder.py"  "tgbot/daily_reminder.py"

# Install scriptleri
for f in /tmp/ytgen-build/install/*.sh; do
    [ -f "$f" ] && copy_if_exists "$f" "install/$(basename $f)"
done

if [ -z "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}ℹ  Değişiklik yok${NC}"
    exit 0
fi

echo ""
echo -e "${BLUE}📝 Değişiklikler:${NC}"
git status --short
echo ""

if [ -n "$1" ]; then MSG="$1"; else MSG="update $(date '+%Y-%m-%d %H:%M')"; fi

git add -A
git commit -m "$MSG"

echo -e "${BLUE}🚀 Push...${NC}"
if git push; then
    echo -e "${GREEN}✅ Başarılı: https://github.com/9rg59mmmp5-cyber/pdftest${NC}"
else
    echo -e "${RED}❌ Push başarısız${NC}"; exit 1
fi
