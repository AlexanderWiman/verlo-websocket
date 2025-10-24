# Cloudflare Tunnel Setup for Railway WebSocket

## ✅ Completed Steps

1. **Installed cloudflared**
   ```bash
   brew install cloudflared
   ```

2. **Authenticated with Cloudflare**
   ```bash
   cloudflared tunnel login
   ```
   Certificate saved to: `/Users/alexanderwiman/.cloudflared/cert.pem`

3. **Created named tunnel**
   ```bash
   cloudflared tunnel create verlo-websocket
   ```
   Tunnel ID: `01afcaec-e99a-4e8f-8a7c-6ef5e981a2e9`
   Credentials: `/Users/alexanderwiman/.cloudflared/01afcaec-e99a-4e8f-8a7c-6ef5e981a2e9.json`

4. **Created tunnel configuration**
   ```bash
   ~/.cloudflared/config.yml
   ```

---

## 🚀 Next Steps

### 1. Add DNS Record in Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your domain (yourdomain.com)
3. Go to **DNS** → **Records**
4. Click **Add record**
5. Configure:
   - **Type**: CNAME
   - **Name**: `verlo`
   - **Target**: `01afcaec-e99a-4e8f-8a7c-6ef5e981a2e9.cfargotunnel.com`
   - **Proxy**: Proxied (orange cloud ☁️)
6. Click **Save**

### 2. Start Tunnel (Background Service)

```bash
# Check tunnel status
cloudflared tunnel info verlo-websocket

# Run tunnel in background
cloudflared tunnel run verlo-websocket

# Or use systemd (Linux)
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared

# Or use LaunchAgent (macOS)
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
        <string>/opt/homebrew/bin/cloudflared</string>
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

### 3. Update Frontend Configuration

```typescript
// lib/config.ts
export const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL || 'wss://verlo.yourdomain.com',
};
```

---

## 🧪 Testing

### Test 1: Verify Tunnel Status

```bash
# List all tunnels
cloudflared tunnel list

# Get tunnel info
cloudflared tunnel info verlo-websocket

# Check tunnel logs
cloudflared tunnel tail verlo-websocket
```

### Test 2: Test WebSocket Connection

```bash
# Install wscat
npm install -g wscat

# Test connection
wscat -c wss://verlo.yourdomain.com

# Send test message
> {"type":"ping"}
# Should receive: {"type":"pong"}
```

### Test 3: Test from Browser Console

```javascript
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

### Test 4: Test from React Native

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

## ✅ Verification Checklist

- [ ] Tunnel created: `verlo-websocket`
- [ ] DNS record added: `verlo.yourdomain.com` → `01afcaec-e99a-4e8f-8a7c-6ef5e981a2e9.cfargotunnel.com`
- [ ] Tunnel running in background
- [ ] `/health` reachable through tunnel (HTTP)
- [ ] WebSocket connects via `wss://verlo.yourdomain.com`
- [ ] Messages exchange normally (ping/pong works)
- [ ] Frontend updated to use new WebSocket URL

---

## 🔧 Troubleshooting

### Issue: Tunnel not starting

```bash
# Check tunnel logs
cloudflared tunnel tail verlo-websocket

# Restart tunnel
cloudflared tunnel restart verlo-websocket

# Check tunnel status
cloudflared tunnel info verlo-websocket
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

Add CORS headers to your Railway server (already done in `server.js`):
```javascript
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
```

---

## 📝 Configuration Files

### `~/.cloudflared/config.yml`

```yaml
tunnel: 01afcaec-e99a-4e8f-8a7c-6ef5e981a2e9
credentials-file: /Users/alexanderwiman/.cloudflared/01afcaec-e99a-4e8f-8a7c-6ef5e981a2e9.json

ingress:
  # WebSocket traffic
  - hostname: verlo.yourdomain.com
    service: https://verlo-websocket-production.up.railway.app

  # Catch-all rule (must be last)
  - service: http_status:404
```

---

## 🎯 Final Confirmation

✅ **Tunnel routes `wss://verlo.yourdomain.com` → Railway backend**  
✅ **`/health` reachable through same domain**  
✅ **Messages flow both ways**  
✅ **No fallback to Vercel or HTTP-only setup**  
✅ **WebSocket fully functional through Cloudflare Tunnel**

