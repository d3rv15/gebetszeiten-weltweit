#!/bin/bash
# FIX: Force a clean redeploy when Dokploy is serving old code
# Run on the Hetzner server: ssh root@88.214.56.102
#
# WICHTIG: Secrets kommen aus ENV, nicht aus dem Repo.
# Vor dem ersten Lauf einmalig setzen (oder in /root/.gebetszeiten.env speichern):
#   export APPWRITE_KEY=standard_<neuer-key>
#   export IGMG_API_KEY=9a5f2fc3a030490ebebcd811e9d5c761

set -e

APP=apps-gebetszeitenweltweit-2tk6bu
DIR=/etc/dokploy/applications/$APP/code
ENVFILE=/root/.gebetszeiten.env

# Env-Datei laden falls vorhanden
if [ -f "$ENVFILE" ]; then
  echo "Loading $ENVFILE"
  set -a
  . "$ENVFILE"
  set +a
fi

echo "=== Step 0: Secret-Check ==="
if [ -z "${APPWRITE_KEY:-}" ]; then
  echo "⚠️  APPWRITE_KEY ist NICHT gesetzt."
  echo "   → App läuft, aber ohne Appwrite-Cache & eigene Städte."
  echo "   → Key in Appwrite-Console anlegen und in $ENVFILE eintragen."
fi
[ -n "${APPWRITE_KEY:-}" ] && echo "✓ APPWRITE_KEY gesetzt"
[ -n "${IGMG_API_KEY:-}" ] && echo "✓ IGMG_API_KEY gesetzt" || echo "ℹ️  IGMG_API_KEY nicht gesetzt (AJAX-Quelle nutzt die offizielle IGMG-Webseite)"

echo ""
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
  -e APPWRITE_ENDPOINT="${APPWRITE_ENDPOINT:-https://appwrite.chargedesk.de/v1}" \
  -e APPWRITE_PROJECT="${APPWRITE_PROJECT:-6a20bfcd000e9e4ca544}" \
  -e APPWRITE_KEY="${APPWRITE_KEY:-}" \
  -e APPWRITE_DB_ID="${APPWRITE_DB_ID:-igmg}" \
  -e APPWRITE_PRAYERS_COLL="${APPWRITE_PRAYERS_COLL:-prayer_times_data}" \
  -e APPWRITE_CITIES_COLL="${APPWRITE_CITIES_COLL:-custom_cities}" \
  -e IGMG_APP_BASE_URL="${IGMG_APP_BASE_URL:-https://igmgapp.org:8081}" \
  -e IGMG_API_KEY="${IGMG_API_KEY:-}" \
  $APP:latest

sleep 5
echo ""
echo "=== Step 5: Verify ==="
docker ps --filter "name=$APP" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
echo ""
echo "=== Health ==="
curl -sm 15 https://salah.chargedesk.de/health 2>&1 | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('  version:', d.get('version'))
    print('  cache:  ', d.get('cities', {}).get('cache'))
    print('  primary:', d.get('primary_source'))
except Exception as e:
    print('  Error:', e)
"
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
TODAY=$(date +%F)
echo "=== Times check (Offenbach $TODAY) ==="
curl -sm 20 "https://salah.chargedesk.de/api/times?city=Offenbach&date=$TODAY" 2>&1 | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('  Method:', d.get('method'))
    print('  Source:', d.get('source'))
    print('  Times: ', d.get('imsak'), d.get('sunrise'), d.get('dhuhr'), d.get('asr'), d.get('maghrib'), d.get('isha'))
except: print('  Error (Quelle evtl. nicht erreichbar)')
"
echo ""
echo "=== VIKZ check (source=vikz_local) ==="
curl -sm 20 "https://salah.chargedesk.de/api/times?city=Offenbach&date=$TODAY&source=vikz_local" 2>&1 | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('  Method:', d.get('method'))
    print('  Times: ', d.get('imsak'), d.get('sunrise'), d.get('dhuhr'), d.get('asr'), d.get('maghrib'), d.get('isha'))
except: print('  Error')
"
echo ""
echo "✅ Done! Reload browser with Ctrl+Shift+R (hard reload)"
