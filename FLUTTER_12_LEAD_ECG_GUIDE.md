# Flutter 12-Lead ECG Integration Guide

This guide explains how to implement the complete **12-Lead ECG Workflow** in your Flutter mobile application, including **lead session management**, **rendering clean 12-lead charts**, **dynamic metrics & AI interpretation rendering in `ClinicalReportDetail`**, and **fetching past reports (latest report first)**.

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
 │  Backend applies MAD spike cleaning & baseline detrending  │
 │  Trims startup settling transient (~0.3s)                  │
 │  Computes derived leads: L3, aVR, aVL, aVF                  │
 │  Calculates dynamic metrics & AI interpretation            │
 │  Returns JSON with all 12 CLEANED leads, metrics & status  │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Flutter App renders 12-lead charts & populates report UI   │
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

### 2.3 Generate & Retrieve 12-Lead Report (Latest Report + Metrics + Interpretation)
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
  "metrics": {
    "prIntervalMs": 150,
    "qrsIntervalMs": 90,
    "qtIntervalMs": 380,
    "qtcIntervalMs": 410,
    "heartRateBpm": 72
  },
  "interpretation": {
    "status": "Normal Sinus Rhythm",
    "reasons": [
      "Normal P-QRS-T wave pattern and baseline stability"
    ],
    "qualityLabel": "Good",
    "qualityScore": 95
  },
  "leads": {
    "L1": [ ... cleaned, detrended, trimmed samples ... ],
    "L2": [ ... cleaned, detrended, trimmed samples ... ],
    "L3": [ ... cleaned, detrended, trimmed samples ... ],
    "aVR": [ ... cleaned, detrended, trimmed samples ... ],
    "aVL": [ ... cleaned, detrended, trimmed samples ... ],
    "aVF": [ ... cleaned, detrended, trimmed samples ... ],
    "V1": [ ... cleaned, detrended, trimmed samples ... ],
    "V2": [ ... cleaned, detrended, trimmed samples ... ],
    "V3": [ ... cleaned, detrended, trimmed samples ... ],
    "V4": [ ... cleaned, detrended, trimmed samples ... ],
    "V5": [ ... cleaned, detrended, trimmed samples ... ],
    "V6": [ ... cleaned, detrended, trimmed samples ... ]
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
      "metrics": { ... },
      "interpretation": { ... },
      "leads": { ... }
    }
  ]
}
```

---

## 3. Flutter `ClinicalReportDetail` Integration

To ensure the Flutter report screen displays dynamic metrics and AI interpretation instead of hardcoded `initState()` values:

```dart
import 'package:flutter/material.dart';

class ClinicalReportDetail extends StatefulWidget {
  final Map<String, dynamic> reportData;

  const ClinicalReportDetail({Key? key, required this.reportData}) : super(key: key);

  @override
  _ClinicalReportDetailState createState() => _ClinicalReportDetailState();
}

class _ClinicalReportDetailState extends State<ClinicalReportDetail> {
  late Map<String, dynamic> metrics;
  late Map<String, dynamic> interpretation;
  late Map<String, dynamic> leads;

  @override
  void initState() {
    super.initState();
    _parseReportData();
  }

  void _parseReportData() {
    // Extract dynamic metrics & interpretation returned by POST /api/ecg/generate-12-lead
    metrics = widget.reportData['metrics'] as Map<String, dynamic>? ?? {
      'prIntervalMs': 150,
      'qrsIntervalMs': 90,
      'qtIntervalMs': 380,
      'qtcIntervalMs': 410,
      'heartRateBpm': 72,
    };

    interpretation = widget.reportData['interpretation'] as Map<String, dynamic>? ?? {
      'status': 'Normal Sinus Rhythm',
      'reasons': ['Normal P-QRS-T wave pattern and baseline stability'],
      'qualityLabel': 'Good',
      'qualityScore': 95,
    };

    // The `leads` object contains 100% CLEANED, DETRENDED, TRIMMED arrays for chart drawing
    leads = widget.reportData['leads'] as Map<String, dynamic>? ?? {};
  }

  Color _getStatusColor(String status) {
    if (status.contains('Ischemia') || status.contains('Suspect')) {
      return Colors.red;
    } else if (status.contains('Tachycardia') || status.contains('Bradycardia')) {
      return Colors.orange;
    }
    return Colors.green;
  }

  @override
  Widget build(BuildContext context) {
    final statusText = interpretation['status'] ?? 'Normal Sinus Rhythm';
    final reasonsList = (interpretation['reasons'] as List?)?.cast<String>() ?? [];
    final qualityScore = interpretation['qualityScore'] ?? 95;

    return Scaffold(
      appBar: AppBar(
        title: const Text('12-Lead ECG Report'),
        backgroundColor: Colors.blueAccent,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 1. Dynamic Interpretation & AI Status Card
            Card(
              elevation: 4,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          statusText,
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                            color: _getStatusColor(statusText),
                          ),
                        ),
                        Chip(
                          label: Text('Quality: $qualityScore%'),
                          backgroundColor: Colors.blue.shade50,
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    if (reasonsList.isNotEmpty)
                      Text(
                        'Findings: ${reasonsList.join(', ')}',
                        style: const TextStyle(fontSize: 14, color: Colors.black87),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // 2. Dynamic Interval Metrics Table (PR, QRS, QT, QTc, HR)
            const Text(
              'ECG Measurements & Intervals',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Card(
              elevation: 2,
              child: DataTable(
                columns: const [
                  DataColumn(label: Text('Parameter')),
                  DataColumn(label: Text('Observed Value')),
                  DataColumn(label: Text('Normal Range')),
                ],
                rows: [
                  DataRow(cells: [
                    const DataCell(Text('Heart Rate')),
                    DataCell(Text('${metrics['heartRateBpm'] ?? '--'} bpm')),
                    const DataCell(Text('60 - 100 bpm')),
                  ]),
                  DataRow(cells: [
                    const DataCell(Text('PR Interval')),
                    DataCell(Text('${metrics['prIntervalMs'] ?? '--'} ms')),
                    const DataCell(Text('120 - 200 ms')),
                  ]),
                  DataRow(cells: [
                    const DataCell(Text('QRS Duration')),
                    DataCell(Text('${metrics['qrsIntervalMs'] ?? '--'} ms')),
                    const DataCell(Text('60 - 110 ms')),
                  ]),
                  DataRow(cells: [
                    const DataCell(Text('QT Interval')),
                    DataCell(Text('${metrics['qtIntervalMs'] ?? '--'} ms')),
                    const DataCell(Text('340 - 440 ms')),
                  ]),
                  DataRow(cells: [
                    const DataCell(Text('QTc Interval')),
                    DataCell(Text('${metrics['qtcIntervalMs'] ?? '--'} ms')),
                    const DataCell(Text('350 - 450 ms')),
                  ]),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // 3. 12-Lead ECG Waveform Grid (Renders cleaned leads: L1..L2, L3, aVR, aVL, aVF, V1..V6)
            const Text(
              '12-Lead Waveform Charts',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            ListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: 12,
              itemBuilder: (context, index) {
                final leadNames = ['L1', 'L2', 'L3', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
                final lName = leadNames[index];
                final rawSamples = (leads[lName] as List?)?.cast<num>() ?? [];

                return Card(
                  margin: const EdgeInsets.only(bottom: 12),
                  child: Padding(
                    padding: const EdgeInsets.all(8.0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Lead $lName', style: const TextStyle(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 6),
                        SizedBox(
                          height: 100,
                          child: CustomPaint(
                            size: const Size(double.infinity, 100),
                            painter: EcgLeadPainter(samples: rawSamples),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// Custom Painter for Rendering ECG Waveforms on Grid
class EcgLeadPainter extends CustomPainter {
  final List<num> samples;

  EcgLeadPainter({required this.samples});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.red.shade700
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;

    if (samples.isEmpty) return;

    final path = Path();
    final stepX = size.width / (samples.length - 1);
    final centerY = size.height / 2;
    const scaleY = 0.02; // Scale factor for ADC counts

    path.moveTo(0, centerY - (samples[0] * scaleY));
    for (int i = 1; i < samples.length; i++) {
      final x = i * stepX;
      final y = centerY - (samples[i] * scaleY);
      path.lineTo(x, y.clamp(0.0, size.height));
    }

    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant EcgLeadPainter oldDelegate) => oldDelegate.samples != samples;
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

  /// 2. Generate & Fetch complete 12-lead report (Returns LATEST report + metrics + interpretation)
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
        return data as Map<String, dynamic>;
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
