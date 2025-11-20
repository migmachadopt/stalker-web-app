#!/bin/bash

MAC="00:1A:79:A9:D9:99"
PORTAL="http://ripana.top/"

# Handshake
TOKEN=$(curl -s \
  -H "User-Agent: Mozilla/5.0 MAG254" \
  -H "Cookie: mac=$MAC" \
  "$PORTAL/portal.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml" \
  | jq -r '.js.token')

echo "Token: $TOKEN"

# Get Profile (IMPORTANTE!)
echo ""
echo "🔄 Get Profile..."
curl -s \
  -H "User-Agent: Mozilla/5.0 MAG254" \
  -H "Cookie: mac=$MAC" \
  -H "Authorization: Bearer $TOKEN" \
  "$PORTAL/portal.php?type=stb&action=get_profile&JsHttpRequest=1-xml" \
  | jq '.js.id'

# Agora Get Ordered List
echo ""
echo "🔄 Get Ordered List..."
curl -s \
  -H "User-Agent: Mozilla/5.0 MAG254" \
  -H "Cookie: mac=$MAC" \
  -H "Authorization: Bearer $TOKEN" \
  "$PORTAL/portal.php?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&sortby=number&hd=0&JsHttpRequest=1-xml" \
  | jq '{total: .js.total_items, first_channel: .js.data[0].name}'