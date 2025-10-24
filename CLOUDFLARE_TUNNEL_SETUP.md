# Cloudflare Tunnel Setup for Railway WebSocket

## Problem
Railway's Metal Edge proxy does not support WebSocket upgrade headers. All WebSocket connections fail with `404 Not Found`.

## Solution
Route WebSocket traffic through **Cloudflare Tunnel**, which provides full `wss://` proxying support.

---

## Prerequisites
- Railway app running at: `https://verlo-websocket-production.up.railway.app`
- Domain `verlo.yourdomain.com` added to Cloudflare DNS
- Cloudflare account with API access

---

## Step 1: Install Cloudflared

```bash
# macOS (using Homebrew)
brew install cloudflared

# Or download binary directly
# macOS:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/

# Linux:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

Verify installation:
```bash
cloudflared --version
```

---

## Step 2: Authenticate Cloudflared

```bash
# Login to Cloudflare
cloudflared tunnel login

# Follow the browser prompt to authenticate
# This will create a certificate file at: ~/.cloudflared/cert.pem
```

---

## Step 3: Create Tunnel (Ephemeral)

For quick testing, use an ephemeral tunnel:

```bash
# Create ephemeral tunnel
cloudflared tunnel --url https://verlo-websocket-production.up.railway.app

# This will output a temporary URL like:
# https://random-name.cfargotunnel.com
```

**Note:** Ephemeral tunnels are temporary and change on restart. Use a named tunnel for production.

---

## Step 4: Create Named Tunnel (Production)

For production, create a named tunnel:

```bash
# Create a named tunnel
cloudflared tunnel create verlo-websocket

# This will output a tunnel UUID
# Save this UUID for later use
```

Create tunnel configuration file:

```bash
# Create config directory
mkdir -p ~/.cloudflared

# Create config file
cat > ~/.cloudflared/config.yml << EOF
tunnel: <TUNNEL_UUID>
credentials-file: /Users/$(whoami)/.cloudflared/<TUNNEL_UUID>.json

ingress:
  # WebSocket traffic
  - hostname: verlo.yourdomain.com
    service: https://verlo-websocket-production.up.railway.app
  
  # Catch-all rule (must be last)
  - service: http_status:404
EOF

# Replace <TUNNEL_UUID> with your actual tunnel UUID
```

---

## Step 5: Add DNS Record

```bash
# Add DNS record to Cloudflare
cloudflared tunnel route dns verlo-websocket verlo.yourdomain.com

# Or manually add CNAME in Cloudflare dashboard:
# Name: verlo
# Content: <TUNNEL_UUID>.cfargotunnel.com
# Proxy: Proxied (orange cloud)
```

---

## Step 6: Run Tunnel

### Option A: Terminal (for testing)
```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run verlo-websocket
```

### Option B: Systemd Service (Linux)
```bash
# Install tunnel as systemd service
sudo cloudflared service install

# Start tunnel
sudo systemctl start cloudflared
sudo systemctl enable cloudflared

# Check status
sudo systemctl status cloudflared
```

### Option C: LaunchAgent (macOS)
```bash
# Create LaunchAgent plist
cat > ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/cloudflared</string>
        <string>tunnel</string>
        <string>run</string>
        <string>verlo-websocket</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

# Load service
launchctl load ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist

# Start service
launchctl start com.cloudflare.cloudflared

# Check status
launchctl list | grep cloudflared
```

---

## Step 7: Update Frontend Config

Update your frontend to use the Cloudflare tunnel:

```typescript
// lib/config.ts
export const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL || 'wss://verlo.yourdomain.com',
};
```

---

## Step 8: Test WebSocket Connection

### Test 1: Using wscat

```bash
# Install wscat
npm install -g wscat

# Test connection
wscat -c wss://verlo.yourdomain.com

# Send test message
> {"type":"ping"}
# Should receive: {"type":"pong"}
```

### Test 2: Using Browser Console

```javascript
// Open browser console and run:
const ws = new WebSocket('wss://verlo.yourdomain.com');

ws.onopen = () => {
  console.log('✅ WebSocket connected');
  ws.send(JSON.stringify({ type: 'ping' }));
};

ws.onmessage = (event) => {
  console.log('📨 Received:', event.data);
};

ws.onerror = (error) => {
  console.error('❌ WebSocket error:', error);
};

ws.onclose = () => {
  console.log('🔌 WebSocket closed');
};
```

### Test 3: Using React Native

```typescript
// Test in your React Native app
const ws = new WebSocket('wss://verlo.yourdomain.com');

ws.onopen = () => {
  console.log('✅ WebSocket connected');
  ws.send(JSON.stringify({ type: 'ping' }));
};

ws.onmessage = (event) => {
  console.log('📨 Received:', event.data);
};

ws.onerror = (error) => {
  console.error('❌ WebSocket error:', error);
};

ws.onclose = () => {
  console.log('🔌 WebSocket closed');
};
```

---

## Step 9: Verify Checklist

- [ ] `/health` reachable through tunnel (HTTP)
- [ ] WebSocket connects via `wss://verlo.yourdomain.com`
- [ ] Messages exchange normally (ping/pong works)
- [ ] Tunnel runs in background (systemd/LaunchAgent)
- [ ] DNS record points to tunnel
- [ ] Frontend updated to use new WebSocket URL

---

## Troubleshooting

### Issue: Tunnel not connecting
```bash
# Check tunnel logs
cloudflared tunnel info verlo-websocket

# Restart tunnel
cloudflared tunnel restart verlo-websocket
```

### Issue: DNS not resolving
```bash
# Check DNS resolution
dig verlo.yourdomain.com

# Verify CNAME record in Cloudflare dashboard
```

### Issue: WebSocket still returns 404
- Ensure Railway app is running
- Check tunnel is forwarding to correct Railway URL
- Verify `hostname` matches DNS record

### Issue: CORS errors
Add CORS headers to your Railway server:
```javascript
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
```

### Issue: Port mismatch
Railway sets `process.env.PORT` automatically. Ensure your server listens on this port:
```javascript
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
});
```

---

## Security Notes

1. **Tunnel Credentials**: Keep `~/.cloudflared/<TUNNEL_UUID>.json` secure
2. **DNS**: Use Cloudflare proxy (orange cloud) for DDoS protection
3. **HTTPS**: Cloudflare Tunnel automatically handles SSL/TLS
4. **Access Control**: Consider using Cloudflare Access for additional security

---

## Monitoring

```bash
# View tunnel logs
cloudflared tunnel info verlo-websocket

# Monitor tunnel metrics
cloudflared tunnel tail verlo-websocket

# Check tunnel status
cloudflared tunnel status verlo-websocket
```

---

## Next Steps

1. Set up automatic tunnel restart on system boot
2. Configure Cloudflare Access (optional)
3. Add monitoring and alerting
4. Set up backup tunnel (optional)

---

## Additional Resources

- [Cloudflare Tunnel Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [Cloudflare WebSocket Support](https://developers.cloudflare.com/fundamentals/get-started/basic-tasks/)
- [Railway WebSocket Guide](https://docs.railway.app/guides/websockets)

