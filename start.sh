#!/bin/sh
set -e

echo "Setting up Cloudflare WARP proxy..."

cd /tmp
mkdir -p /app/warp-config

# Generate WARP account if not exists
if [ ! -f /app/warp-config/wgcf-account.toml ]; then
  echo "Registering new WARP account..."
  wgcf register --accept-tos || { echo "WARP registration failed, skipping"; exec node /app/server.js; }
  wgcf generate || { echo "WARP config generation failed, skipping"; exec node /app/server.js; }
  cp wgcf-account.toml wgcf-profile.conf /app/warp-config/ 2>/dev/null || true
fi

# Extract config values
PRIVATE_KEY=$(grep "PrivateKey" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')
ADDRESS=$(grep "Address" /app/warp-config/wgcf-profile.conf | head -1 | cut -d'=' -f2- | tr -d ' ')
DNS=$(grep "DNS" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')
PUBLIC_KEY=$(grep "PublicKey" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')
ENDPOINT=$(grep "Endpoint" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')

# Create wireproxy config
cat > /tmp/wireproxy.conf << CONF
[Interface]
PrivateKey = ${PRIVATE_KEY}
Address = ${ADDRESS}
DNS = ${DNS}

[Peer]
PublicKey = ${PUBLIC_KEY}
Endpoint = ${ENDPOINT}
AllowedIPs = 0.0.0.0/0, ::/0

[Socks5]
BindAddress = 127.0.0.1:1080
CONF

# Start wireproxy in background
wireproxy -c /tmp/wireproxy.conf &
sleep 3

# Check if proxy is running
if nc -z 127.0.0.1 1080 2>/dev/null; then
  echo "Cloudflare WARP proxy running on socks5://127.0.0.1:1080"
else
  echo "WARP proxy failed, will use Piped API fallback"
fi

# Start Node.js server
cd /app
exec node server.js
