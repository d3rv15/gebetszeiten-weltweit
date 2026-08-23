#!/bin/bash
# FIX: Force a clean redeploy when Dokploy is serving old code
# Run on the Hetzner server: ssh root@88.214.56.102

set -e

APP=apps-gebetszeitenweltweit-2tk6bu
DIR=/etc/dokploy/applications/$APP/code

echo "=== Step 1: Check what's running ==="
docker ps --filter "name=$APP" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}"
echo ""
echo "=== Step 2: Stop ALL containers of this app ==="
for c in $(docker ps -q --filter "name=$APP"); do
  echo "Stopping $c..."
  docker stop $c
  docker rm -f $c
done
echo ""
echo "=== Step 3: Remove old images (force rebuild) ==="
for img in $(docker images --format "{{.Repository}}:{{.Tag}}" | grep "$APP"); do
  echo "Removing $img..."
  docker rmi -f "$img" || true
done
echo ""
echo "=== Step 4: Fresh clone + build + run ==="
cd $DIR
git fetch origin
git reset --hard origin/main
git log --oneline -3
echo ""
docker build --no-cache --pull -t $APP:latest . 2>&1 | tail -8
echo ""
docker run -d \
  --name $APP \
  --restart unless-stopped \
  --network dokploy-network \
  -v gebetszeiten-data:/app/data \
  -e NODE_ENV=production \
  -e PORT=3000 \
  $APP:latest

sleep 5
echo ""
echo "=== Step 5: Verify ==="
docker ps --filter "name=$APP" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
echo ""
echo "=== i18n community check ==="
curl -sm 10 https://salah.chargedesk.de/api/i18n 2>&1 | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if 'community' in d:
        print('✓ community OK')
        print('  Options:', list(d['community'].get('options', {}).keys()))
    else:
        print('✗ community MISSING')
except: print('  Error parsing i18n')
"
echo ""
echo "=== Times check (Offenbach) ==="
curl -sm 10 'https://salah.chargedesk.de/api/times?city=Offenbach&date=2026-08-23' 2>&1 | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('  Method:', d.get('method'))
    print('  Source:', d.get('source'))
    print('  Times:', d.get('imsak'), d.get('sunrise'), d.get('dhuhr'), d.get('asr'), d.get('maghrib'), d.get('isha'))
except: print('  Error')
"
echo ""
echo "=== VIKZ check (Offenbach with source=vikz_local) ==="
curl -sm 10 'https://salah.chargedesk.de/api/times?city=Offenbach&date=2026-08-23&source=vikz_local' 2>&1 | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('  Method:', d.get('method'))
    print('  Times:', d.get('imsak'), d.get('sunrise'), d.get('dhuhr'), d.get('asr'), d.get('maghrib'), d.get('isha'))
except: print('  Error')
"
echo ""
echo "✅ Done! Reload browser with Ctrl+Shift+R (hard reload)"
