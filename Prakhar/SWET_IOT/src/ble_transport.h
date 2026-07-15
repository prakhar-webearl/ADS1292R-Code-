/**
 * ble_transport.h
 * -----------------------------------------------------------
 * BLE Transport — Raw Binary ECG + JSON Status Push
 *
 * TWO characteristics on the same service:
 *
 *  ① ECG Data Characteristic  (NOTIFY + READ)
 *    UUID: 12345678-1234-5678-1234-56789abcdef1
 *    Sends raw binary ECG packets (508 bytes each, 1 notification/block).
 *    Packet layout (little-endian, packed):
 *      [0..3]   uint32_t  seq
 *      [4]      uint8_t   sampleRate  (125)
 *      [5]      uint8_t   flags       bit0=lo, bit1=loPlus, bit2=loMinus
 *      [6]      uint8_t   severity    0=INFO, 1=WARNING, 2=CRITICAL
 *      [7]      uint8_t   numSamples  (125)
 *      [8..507] int32_t   samples[125]
 *
 *  ② Status Characteristic  (NOTIFY + READ)
 *    UUID: 12345678-1234-5678-1234-56789abcdef2
 *    Sends plain JSON status strings, e.g.:
 *      {"status":"wifi_connected","ip":"192.168.1.10","deviceId":"ESP_ECG_123"}
 *      {"status":"wifi_failed"}
 *      {"status":"wifi_connecting"}
 *      {"status":"ble_connected"}
 *      {"status":"wifi_disconnected"}
 *    Mobile subscribes to this to know when WiFi config succeeds.
 *
 * AUTO-CONNECT:
 *    After a BLE client disconnects, advertising restarts automatically.
 *    If the same phone has bonded, iOS/Android reconnect automatically
 *    when the phone comes back in range.
 * -----------------------------------------------------------
 */
#pragma once
#include <Arduino.h>   // String type
#include <stdint.h>
#include "types.h"


// Initialize BLE stack, server, service, and both characteristics.
// Starts advertising. Call once in setup() BEFORE network_init().
void ble_init();

// Pack the ECG block into a raw binary packet and notify via ECG characteristic.
void ble_uploadBlock(const Block& blk, bool leadsOff, bool loPlus, bool loMinus,
                     const char* warning, const char* severity);

// Push a plain JSON status string to the Status characteristic.
// Called by network.cpp after WiFi config events.
// Example: ble_sendStatus("{\"status\":\"wifi_connected\",\"ip\":\"192.168.1.10\"}")
void ble_sendStatus(const String& json);

// Advertising controls (called by network.cpp exclusive transport logic)
void ble_startAdvertising();
void ble_stopAdvertising();

// MUST be called every loop() — handles deferred advertising restart after disconnect.
// Calling startAdvertising() from inside onDisconnect() is unreliable on NimBLE;
// this deferred pattern runs safely in the Arduino main task context.
void ble_update();

// State queries
bool     ble_isConnected();
uint16_t ble_getMtu();
