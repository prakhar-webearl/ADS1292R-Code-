# ECG Setup And Runtime Guide

This flow separates WiFi setup from runtime member switching.

## 1. Initial Setup Flow

Use this only when the ESP32 is in AP mode and the phone is connected to `ECG_Setup`.

### Steps
1. Power on ESP32.
2. Connect phone to ESP hotspot `ECG_Setup`.
3. Open WiFi setup screen in the app.
4. Select home WiFi SSID and enter password.
5. App sends local request to ESP:

`POST http://192.168.4.1/wifi-config`

Payload:
```json
{
  "userId": "selected_member_id",
  "deviceId": "ESP_ECG_123",
  "ssid": "HomeWiFiName",
  "password": "HomeWiFiPassword",
  "isActive": true
}
```

### What ESP does
1. Saves `userId` and `deviceId`.
2. Uses `ssid` and `password` to join home WiFi.
3. Stops AP mode after successful connection.
4. Starts sending ECG data to cloud.

### Result
- ESP moves from AP mode to STA mode.
- This is the only step where WiFi credentials are changed.
- If this fails, runtime member switching will not reach the device because the ESP is not online.

## 2. Runtime Member Change Flow

Use this only after setup is complete and ESP is already connected to home WiFi.

### Important rule
- Runtime flow changes only `userId`.
- Runtime flow must not change WiFi SSID/password.
- Runtime flow does not use `192.168.4.1`.

### Steps
1. User selects a different member in the mobile app.
2. App sends member mapping to backend:

`POST https://api-for-ecg.onrender.com/api/wifi-config`

Payload:
```json
{
  "userId": "new_selected_member_id",
  "deviceId": "ESP_ECG_123",
  "isActive": true
}
```

3. Backend stores the latest mapping for that deviceId.
4. ESP polls backend by deviceId:

`GET https://api-for-ecg.onrender.com/api/wifi-config/device/ESP_ECG_123`

5. ESP reads `data.userId` from the response.
6. If the value changed, ESP updates local `userId` and saves it.
7. Next ECG blocks use the new `userId` automatically.

### Result
- Member changes without touching WiFi.
- No reconnect to `ECG_Setup` is needed.
- No `ssid/password` is sent in runtime.

## 3. Why WiFi May Not Connect

If WiFi is not connecting, check this first:

1. The phone must be connected to `ECG_Setup` before sending setup request.
2. Setup request must contain both `ssid` and `password`.
3. ESP must successfully switch from AP mode to STA mode.
4. Runtime member change will not fix a failed WiFi setup.

If setup fails:
- ESP stays in AP mode.
- Retry setup with correct home WiFi credentials.

## 4. What ESP currently does in code

- WiFi setup handler: [esp32_client.ino](esp32_client.ino#L100)
- Runtime user sync: [esp32_client.ino](esp32_client.ino#L211)
- Queue-based ECG sending: [esp32_client.ino](esp32_client.ino#L256)
- Main loop: [esp32_client.ino](esp32_client.ino#L372)

When runtime sync updates userId, serial shows:

`[CFG] Runtime sync: userId updated to <new_id>`

If userId is already correct, serial shows:

`[CFG] Runtime sync: userId already current`

## 5. Backend behavior

Backend must keep the latest device mapping by deviceId.

- Runtime update: [controllers/wifiConfigController.js](controllers/wifiConfigController.js#L12)
- Device lookup: [controllers/wifiConfigController.js](controllers/wifiConfigController.js#L114)

## 6. Quick test order

### Test A: First setup
```bash
curl -X POST http://192.168.4.1/wifi-config \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "selected_member_id",
    "deviceId": "ESP_ECG_123",
    "ssid": "HomeWiFiName",
    "password": "HomeWiFiPassword",
    "isActive": true
  }'
```

### Test B: Runtime member switch
```bash
curl -X POST https://api-for-ecg.onrender.com/api/wifi-config \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "new_selected_member_id",
    "deviceId": "ESP_ECG_123",
    "isActive": true
  }'
```

### Test C: Verify device mapping
```bash
curl https://api-for-ecg.onrender.com/api/wifi-config/device/ESP_ECG_123
```

## 7. Important notes

1. `deviceId` is fixed for the physical ESP32.
2. `userId` changes when user/member changes.
3. Runtime sync is delayed by the polling interval.
4. If you want faster switching, reduce `USER_SYNC_INTERVAL_MS` in [esp32_client.ino](esp32_client.ino#L43).

## 8. Deployment order

1. Restart backend service.
2. Flash ESP32 firmware.
3. Perform initial WiFi setup.
4. Test runtime member switch after ESP is online.
