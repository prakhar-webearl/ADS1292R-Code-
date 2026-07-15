/**
 * ecg_classifier.h — ECG Diagnostic Classification
 * -----------------------------------------------------------
 * Migrated from ecg_esp32_ads1292r_v10_working_1.ino.
 * Analyses a 5-second (625-sample) window and returns a
 * diagnostic condition name with severity and detail strings.
 * -----------------------------------------------------------
 */

#pragma once
#include <Arduino.h>
#include "types.h"

// Primary entry point: classify a 5-second ECG window.
// Returns the condition name (e.g. "Normal Sinus Rhythm").
// severity is set to "NORMAL", "INFO", "WARNING", or "CRITICAL".
// detail contains human-readable supporting metrics.
String classifyWindow(const int32_t* samples, int sampleCount, String& severity, String& detail);

// Helper: map a validation failure reason string to a user-friendly condition name.
String validationConditionName(const String& reason);

// Helper: map a validation failure reason string to a user-friendly detail string.
String validationDetailText(const String& reason);
