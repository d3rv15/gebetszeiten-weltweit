#!/bin/bash
# Manual deploy script - run this on the Hetzner server (88.214.56.102)
# Usage: ssh root@88.214.56.102 'bash -s' < deploy-manual.sh

set -e

APP_NAME="apps-gebetszeitenweltweit-2tk6bu"
APP_DIR="/etc/dokploy/applications/${APP_NAME}/code"

echo "=== Deploying ${APP_NAME} ==="
cd "${APP_DIR}"
git pull --ff-only
docker build --no-cache -t "${APP_NAME}:latest" .
# Stop and remove all old containers of this app
for c in $(docker ps --filter "name=${APP_NAME}" --format '{{.Names}}'); do
  echo "Stopping ${c}..."
  docker stop "$c" >/dev/null 2>&1 || true
  docker rm -f "$c" >/dev/null 2>&1 || true
done
# Start new container
docker run -d \
  --name "${APP_NAME}" \
  --restart unless-stopped \
  --network dokploy-network \
  -v gebetszeiten-data:/app/data \
  -e NODE_ENV=production \
  -e PORT=3000 \
  "${APP_NAME}:latest"

sleep 3
echo ""
echo "=== Container status ==="
docker ps --filter "name=${APP_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "=== Health check ==="
curl -s https://salah.chargedesk.de/api/health | head -c 300
echo ""
echo ""
echo "✅ Deploy complete!"
