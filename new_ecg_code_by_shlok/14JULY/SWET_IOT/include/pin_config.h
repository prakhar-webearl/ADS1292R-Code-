/**
 * pin_config.h
 * -----------------------------------------------------------
 * SWET_IOT - Hardware Pin Mapping
 * Board   : ESP32 NodeMCU-32S
 * Module  : ProtoCentral ADS1292R Breakout v3.1
 * SPI Bus : VSPI (Hardware SPI)
 * -----------------------------------------------------------
 * NOTE: These pins are locked based on the working diagnostic
 * build. Do not change without re-verifying on hardware.
 */

#pragma once

// ==========================================================
// VSPI (Hardware SPI) - Fixed by ESP32 silicon, do not remap
// ==========================================================
#define ADS1292_SCK_PIN     18
#define ADS1292_MISO_PIN    19
#define ADS1292_MOSI_PIN    23

// ==========================================================
// ADS1292R Control / GPIO Pins
// ==========================================================
#define ADS1292_CS_PIN       5   // Chip Select (active LOW)
#define ADS1292_START_PIN    4   // START (active HIGH -> begins conversions)
#define ADS1292_RESET_PIN   16   // RESET (active LOW pulse to reset device)
#define ADS1292_DRDY_PIN    15   // DRDY  (active LOW -> new data ready, input, use interrupt or poll)
