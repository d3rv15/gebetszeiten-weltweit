#!/bin/bash
# FIX: Force a clean redeploy when Dokploy is serving old code
# Run this on the Hetzner server: ssh root@88.214.56.102

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
docker build --no-cache --pull -t $APP:latest . 2>&1 | tail -10
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
echo "API health:"
curl -sm 10 https://salah.chargedesk.de/api/health 2>&1 | python3 -m json.tool 2>&1 | head -20
echo ""
echo "Frontend version (should be v2.4 now):"
curl -sm 10 https://salah.chargedesk.de/ 2>&1 | grep -o 'data-i18n="header.version">v[0-9.]*'
echo ""
echo "API times method (should be IGMG.org Gebetskalender):"
curl -sm 10 'https://salah.chargedesk.de/api/times?city=Offenbach&date=2026-08-21' 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print('Method:', d.get('method'))" 2>&1
echo ""
echo "✅ Done! Reload browser with Ctrl+Shift+R (hard reload)"
