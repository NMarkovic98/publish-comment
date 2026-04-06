#!/bin/bash
# Auto-updates bot.putnaklik.com A record on Cloudflare when public IP changes.
# Run via cron every 5 minutes:
#   */5 * * * * /home/nmarkovic/Desktop/publish-comment/ddns-update.sh >> /home/nmarkovic/Desktop/publish-comment/ddns.log 2>&1

CF_API_TOKEN="YOUR_CF_API_TOKEN"
CF_ZONE_ID="YOUR_CF_ZONE_ID"
SUBDOMAIN="bot.putnaklik.com"
CACHE_FILE="/tmp/ddns-last-ip.txt"

# Get current public IP
CURRENT_IP=$(curl -s https://ifconfig.me)
if [[ -z "$CURRENT_IP" ]]; then
  echo "[$(date)] ERROR: Could not get public IP"
  exit 1
fi

# Compare with last known IP (fast path — skip API call if unchanged)
LAST_IP=$(cat "$CACHE_FILE" 2>/dev/null)
if [[ "$CURRENT_IP" == "$LAST_IP" ]]; then
  exit 0
fi

echo "[$(date)] IP changed: $LAST_IP -> $CURRENT_IP, updating DNS..."

# Get the DNS record ID
RECORD=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=A&name=${SUBDOMAIN}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json")

RECORD_ID=$(echo "$RECORD" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$RECORD_ID" ]]; then
  echo "[$(date)] ERROR: DNS record not found for $SUBDOMAIN. Create it first in Cloudflare dashboard."
  exit 1
fi

# Update the record
RESULT=$(curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${RECORD_ID}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"type\":\"A\",\"name\":\"${SUBDOMAIN}\",\"content\":\"${CURRENT_IP}\",\"ttl\":60,\"proxied\":false}")

SUCCESS=$(echo "$RESULT" | grep -o '"success":[^,}]*' | cut -d: -f2)
if [[ "$SUCCESS" == "true" ]]; then
  echo "$CURRENT_IP" > "$CACHE_FILE"
  echo "[$(date)] OK: $SUBDOMAIN -> $CURRENT_IP"
else
  echo "[$(date)] ERROR: $RESULT"
  exit 1
fi
