/**
 * network.h
 * -----------------------------------------------------------
 * WiFi AP+STA concurrent manager + HTTP upload queue.
 *
 * WiFi Behaviour (mirrors AD8232 v9.4):
 *  - Loads saved credentials from NVS (Preferences "ecg_cfg" namespace).
 *  - On boot: tries STA first. Falls back to AP "ECG_ADS1292R" if fails.
 *  - Blue LED (GPIO2): ON when STA connected, blinking when AP-only.
 *  - /wifi-config POST endpoint: mobile app sends credentials â†’ ESP
 *    connects to new network, saves creds, stops AP, LED turns ON.
 *  - STA drops: reconnects every 5s. After 3 fails â†’ starts AP.
 *  - STA down > 15s: AP guaranteed active.
 *
 * POST Payload (matches AD8232 v9.4 exactly):
 *   https://ads1292r-code.onrender.com/api/ecg
 *   { userId, deviceId, seq, sr, lo, loPlus, loMinus, data[] }
 * -----------------------------------------------------------
 */

#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "types.h"

// Call once in setup() after ADS1292R is initialised.
// - Configures LED pin
// - Loads NVS credentials, connects STA or starts AP
// - Starts /wifi-config web server on port 80
// - Creates FreeRTOS upload queue + upload task on Core 0
void network_init();

// Call every loop() â€” handles reconnect timers, AP fallback,
// web server client processing, and LED state.
void network_update();

// Enqueue a processed Block for HTTPS POST. Non-blocking.
// Returns false if queue full (block dropped).
bool network_uploadBlock(const Block& blk, bool leadsOff, bool loPlus, bool loMinus, const char* warning = nullptr, const char* severity = nullptr);

// Returns true if STA is currently connected.
bool network_isConnected();

