#!/bin/sh
set -e

# Generate runtime config so the same image can point at localhost locally or
# at the deployed control-plane URL on TrueFoundry with no rebuild.
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:8000}"
echo "window.CONTROL_PLANE_URL = \"${CONTROL_PLANE_URL}\";" > /usr/share/nginx/html/config.js

echo "config.js -> CONTROL_PLANE_URL=${CONTROL_PLANE_URL}"

exec nginx -g 'daemon off;'
