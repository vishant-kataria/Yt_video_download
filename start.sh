#!/bin/sh
set -e

echo "🔧 Setting up Cloudflare WARP proxy..."

# Generate WARP account if not exists
cd /tmp
if [ ! -f /app/warp-config/wgcf-account.toml ]; then
  mkdir -p /app/warp-config
  wgcf register --accept-tos
  wgcf generate
  cp wgcf-account.toml wgcf-profile.conf /app/warp-config/
fi

# Create wireproxy config for SOCKS5 proxy on port 1080
cat > /tmp/wireproxy.conf << 'CONF'
[Interface]
CONF

# Extract private key, address, DNS from wgcf profile
PRIVATE_KEY=$(grep "PrivateKey" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')
ADDRESS=$(grep "Address" /app/warp-config/wgcf-profile.conf | head -1 | cut -d'=' -f2- | tr -d ' ')
DNS=$(grep "DNS" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')
PUBLIC_KEY=$(grep "PublicKey" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')
ENDPOINT=$(grep "Endpoint" /app/warp-config/wgcf-profile.conf | cut -d'=' -f2- | tr -d ' ')

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
PROXY_PID=$!
sleep 3

# Verify WARP is working
if kill -0 $PROXY_PID 2>/dev/null; then
  echo "✅ Cloudflare WARP proxy running on socks5://127.0.0.1:1080"
else
  echo "⚠️  WARP proxy failed to start, will use Piped API fallback"
fi

# Start Node.js server
cd /app
exec node server.js
