# Flutter 12-Lead ECG Integration Guide

This guide explains how to implement the **12-Lead ECG Workflow** in your Flutter mobile application, including **retesting/re-recording single leads**.

> ℹ️ **Important Hardware Note**:  
> The ESP32 device automatically streams continuous raw ECG data directly to `POST /api/ecg`.  
> Your Flutter app **does NOT post raw device data to `POST /api/ecg`**. Instead, Flutter manages the lead session state, SSE live graph rendering, progress timers, retesting, and final 12-lead report generation.

---

## 1. Workflow Architecture

```
 ┌─────────────────────────────────────────────────────────────┐
 │                      Flutter Mobile App                     │
 └──────────────────────────────┬──────────────────────────────┘
                                │
   1. User selects Lead I (L1)  │
      Calls POST /api/ecg/lead-session { deviceId, userId, lead: "L1" }
      (Clears L1 buffer for a fresh recording or retest)
                                │
   2. Listens to SSE Live Stream│ ◄─── ESP32 streams raw data continuously
      GET /api/ecg/live/:deviceId│      to POST /api/ecg in background
      Draws real-time waveform  │
      Runs 8-second countdown   │
                                │
   3. User records or retests   │
      L2, V1, V2, V3, V4, V5, V6│
      Repeats step 1 & 2 for    │
      each lead (8 seconds each)│
                                │
   4. Call Final API            │
      POST /api/ecg/generate-12-lead { deviceId, userId }
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Backend computes derived leads: L3, aVR, aVL, aVF         │
 │  Returns JSON with all 12 lead arrays                       │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Flutter App renders all 12 ECG graphs & exports PDF       │
 └─────────────────────────────────────────────────────────────┘
```

---

## 2. Retesting a Lead (Overwriting Data)

If the user wants to **Retest** a specific lead (e.g. `V1` was noisy or electrodes slipped):
1. The app simply calls `POST /api/ecg/lead-session` again with `{ "deviceId": "...", "userId": "...", "lead": "V1" }`.
2. The backend **automatically clears the old `V1` buffer** and prepares for a fresh 8-second recording.
3. The new 8-second recording updates/overwrites `V1` cleanly without duplicating array entries!

---

## 3. API Endpoints for Flutter

### 3.1 Set Active Lead Session (or Retest Lead)
- **Endpoint:** `POST /api/ecg/lead-session`
- **Description:** Sets active lead position and resets buffer for a fresh 8-second recording/retest.

**Request Body:**
```json
{
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef",
  "lead": "V1"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef",
  "activeLead": "V1",
  "testId": "69ca740bfa123456789abcde",
  "message": "Active lead set to V1. Buffer cleared for fresh recording/retest of V1."
}
```

---

### 3.2 Reset Full 12-Lead Session (Start New Test)
To reset the entire test and start a new 12-lead ECG session from scratch:
```json
{
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef",
  "reset": true
}
```

---

### 3.3 Generate & Retrieve 12-Lead Report
- **Endpoint:** `POST /api/ecg/generate-12-lead`
- **Description:** Called after recording all 8 physical leads. Derives `L3`, `aVR`, `aVL`, `aVF` and returns all 12 leads.

**Request Body:**
```json
{
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef"
}
```

---

## 4. Flutter Implementation Service (`TwelveLeadEcgService.dart`)

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class TwelveLeadEcgService {
  final String baseUrl;

  TwelveLeadEcgService({required this.baseUrl});

  /// Set Active Lead Session before recording or retesting
  Future<bool> setLeadSession({
    required String deviceId,
    required String userId,
    required String lead,
    bool reset = false,
  }) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/ecg/lead-session'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'deviceId': deviceId,
          'userId': userId,
          'lead': lead,
          'reset': reset,
        }),
      );

      final data = jsonDecode(response.body);
      return data['success'] == true;
    } catch (e) {
      print('Error setting lead session: $e');
      return false;
    }
  }

  /// Generate & Fetch complete 12-lead data after recording
  Future<Map<String, dynamic>?> generate12LeadReport({
    required String deviceId,
    required String userId,
  }) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/ecg/generate-12-lead'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'deviceId': deviceId,
          'userId': userId,
        }),
      );

      final data = jsonDecode(response.body);
      if (data['success'] == true) {
        return data['leads'] as Map<String, dynamic>;
      }
    } catch (e) {
      print('Error generating 12-lead report: $e');
    }
    return null;
  }
}
```
