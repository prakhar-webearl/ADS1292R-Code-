# Flutter 12-Lead ECG Integration Guide

This guide explains how to implement the **12-Lead ECG Workflow** in your Flutter mobile application, including **how to retrieve the latest report** and **how to list past reports (newest first)**.

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
 │  Interpolates any missing chest lead (e.g. V3)             │
 │  Returns JSON with all 12 lead arrays (Latest Report)       │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Flutter App renders all 12 ECG graphs & exports PDF       │
 └─────────────────────────────────────────────────────────────┘
```

---

## 2. API Endpoints for Flutter

### 2.1 Set Active Lead Session (or Retest Lead)
- **Endpoint:** `POST /api/ecg/lead-session`
- **Description:** Sets active lead position and resets buffer for a fresh 8-second recording/retest.

**Request Body:**
```json
{
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef",
  "lead": "L1"
}
```

---

### 2.2 Reset Full 12-Lead Session (Start New Test)
To reset the entire test and start a new 12-lead ECG session from scratch:
```json
{
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef",
  "reset": true
}
```

---

### 2.3 Generate & Retrieve 12-Lead Report (Latest Report)
- **Endpoint:** `POST /api/ecg/generate-12-lead`
- **Description:** Returns the **absolute latest** 12-lead report for the given `deviceId` and `userId` (sorted by `{ _id: -1 }`). Derives `L3`, `aVR`, `aVL`, `aVF` and interpolates any missing chest lead.

**Request Body:**
```json
{
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "completed": true,
  "totalLeads": 12,
  "testId": "69ca740bfa123456789abcde",
  "leads": {
    "L1": [ ... ],
    "L2": [ ... ],
    "L3": [ ... ],
    "aVR": [ ... ],
    "aVL": [ ... ],
    "aVF": [ ... ],
    "V1": [ ... ],
    "V2": [ ... ],
    "V3": [ ... ],
    "V4": [ ... ],
    "V5": [ ... ],
    "V6": [ ... ]
  }
}
```

---

### 2.4 List All 12-Lead ECG Reports (Latest First)
- **Endpoint:** `GET /api/ecg/12-lead/list/:userId?deviceId=ESP32_001`
- **Description:** Returns all 12-lead ECG reports for the user, with the **latest report appearing first** (`reports[0]`).

**Response (200 OK):**
```json
{
  "success": true,
  "count": 2,
  "totalCount": 2,
  "page": 1,
  "reports": [
    {
      "_id": "6a60d1649eb674bc3a04af6b",
      "createdAt": "2026-07-22T19:45:00.000Z",
      "status": "completed",
      "totalLeads": 12,
      "leads": { ... }
    },
    {
      "_id": "6a60ccc65f1cc43c6269a84d",
      "createdAt": "2026-07-22T18:15:00.000Z",
      "status": "completed",
      "totalLeads": 12,
      "leads": { ... }
    }
  ]
}
```

---

## 3. Flutter Implementation Service (`TwelveLeadEcgService.dart`)

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class TwelveLeadEcgService {
  final String baseUrl;

  TwelveLeadEcgService({required this.baseUrl});

  /// 1. Set Active Lead Session before recording or retesting
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

  /// 2. Generate & Fetch complete 12-lead data (ALWAYS returns the LATEST report)
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

  /// 3. Fetch List of All 12-Lead Reports for User (LATEST REPORT FIRST)
  Future<List<dynamic>> fetchUser12LeadReports({
    required String userId,
    String? deviceId,
  }) async {
    try {
      var url = '$baseUrl/api/ecg/12-lead/list/$userId';
      if (deviceId != null) {
        url += '?deviceId=$deviceId';
      }

      final response = await http.get(Uri.parse(url));
      final data = jsonDecode(response.body);

      if (data['success'] == true && data['reports'] != null) {
        // data['reports'][0] is the LATEST report!
        return data['reports'] as List<dynamic>;
      }
    } catch (e) {
      print('Error fetching 12-lead reports list: $e');
    }
    return [];
  }
}
```
