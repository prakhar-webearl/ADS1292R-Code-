# Flutter 12-Lead ECG Integration Guide

This guide explains how to implement the **12-Lead ECG Workflow** in your Flutter mobile application.

> ℹ️ **Important Hardware Note**:  
> The ESP32 device automatically streams continuous raw ECG data directly to `POST /api/ecg`.  
> Your Flutter app **does NOT post raw device data to `POST /api/ecg`**. Instead, Flutter manages the lead session state, SSE live graph rendering, progress timers, and final 12-lead report generation.

---

## 1. Workflow Architecture

```
 ┌─────────────────────────────────────────────────────────────┐
 │                      Flutter Mobile App                     │
 └──────────────────────────────┬──────────────────────────────┘
                                │
   1. User selects Lead I (L1)  │
      Calls POST /api/ecg/lead-session { deviceId, userId, lead: "L1" }
                                │
   2. Listens to SSE Live Stream│ ◄─── ESP32 streams raw data continuously
      GET /api/ecg/live/:deviceId│      to POST /api/ecg in background
      Draws real-time waveform  │
      Runs 8-second countdown   │
                                │
   3. User moves electrodes to  │
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

## 2. API Endpoints for Flutter

### 2.1 Set Active Lead Session
- **Endpoint:** `POST /api/ecg/lead-session`
- **Description:** Notifies the backend which lead electrode position the patient is currently recording.

**Request Body:**
```json
{
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef",
  "lead": "L1"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "deviceId": "ESP32_001",
  "userId": "65b1c900e123456789abcdef",
  "activeLead": "L1",
  "testId": "69ca740bfa123456789abcde",
  "message": "Active lead set to L1. Incoming /api/ecg data will be saved for L1."
}
```

---

### 2.2 Generate & Retrieve 12-Lead Report
- **Endpoint:** `POST /api/ecg/generate-12-lead`
- **Description:** Called after recording all 8 physical leads (`L1`, `L2`, `V1`..`V6`). The backend derives `L3`, `aVR`, `aVL`, `aVF` and returns all 12 leads.

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
    "L1": [2048, 2055, 2060, ...],
    "L2": [2100, 2110, 2115, ...],
    "L3": [52, 55, 55, ...],
    "aVR": [-2074, -2082.5, ...],
    "aVL": [998, 1000, ...],
    "aVF": [1076, 1082.5, ...],
    "V1": [1900, 1905, ...],
    "V2": [1920, 1925, ...],
    "V3": [1940, 1945, ...],
    "V4": [1960, 1965, ...],
    "V5": [1980, 1985, ...],
    "V6": [2000, 2005, ...]
  }
}
```

---

## 3. Flutter Implementation Service (`TwelveLeadEcgService.dart`)

```dart
import 'dart:convert';
import 'http/http.dart' as http;

class TwelveLeadEcgService {
  final String baseUrl;

  TwelveLeadEcgService({required this.baseUrl});

  /// Step 1: Set Active Lead Session before recording
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

  /// Step 2: Generate & Fetch complete 12-lead data after all 8 physical leads are recorded
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

---

## 4. Flutter UI Screen Flow (`TwelveLeadEcgScreen.dart`)

```dart
import 'dart:async';
import 'package:flutter/material.dart';

class TwelveLeadEcgScreen extends StatefulWidget {
  final String deviceId;
  final String userId;
  final String apiBaseUrl;

  const TwelveLeadEcgScreen({
    Key? key,
    required this.deviceId,
    required this.userId,
    required this.apiBaseUrl,
  }) : super(key: key);

  @override
  _TwelveLeadEcgScreenState createState() => _TwelveLeadEcgScreenState();
}

class _TwelveLeadEcgScreenState extends State<TwelveLeadEcgScreen> {
  late TwelveLeadEcgService _service;
  
  // List of physical leads to record in order
  final List<String> physicalLeads = ['L1', 'L2', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
  int currentLeadIndex = 0;
  
  bool isRecording = false;
  int countdownSeconds = 8;
  Timer? _recordingTimer;
  
  Map<String, dynamic>? final12LeadsData;

  @override
  void initState() {
    super.initState();
    _service = TwelveLeadEcgService(baseUrl: widget.apiBaseUrl);
  }

  @override
  void dispose() {
    _recordingTimer?.cancel();
    super.dispose();
  }

  /// Start recording current lead for 8 seconds
  Future<void> _startRecordingCurrentLead() async {
    final currentLead = physicalLeads[currentLeadIndex];

    // 1. Tell backend which lead is being recorded
    final success = await _service.setLeadSession(
      deviceId: widget.deviceId,
      userId: widget.userId,
      lead: currentLead,
    );

    if (!success) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to set lead $currentLead session')),
      );
      return;
    }

    setState(() {
      isRecording = true;
      countdownSeconds = 8;
    });

    // 2. Run 8-second countdown while ESP32 streams raw data to /api/ecg
    _recordingTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (countdownSeconds > 1) {
        setState(() {
          countdownSeconds--;
        });
      } else {
        timer.cancel();
        _onLeadRecordingCompleted();
      }
    });
  }

  /// Handle completion of single lead 8-second recording
  Future<void> _onLeadRecordingCompleted() async {
    setState(() {
      isRecording = false;
    });

    if (currentLeadIndex < physicalLeads.length - 1) {
      // Advance to next physical lead
      setState(() {
        currentLeadIndex++;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '${physicalLeads[currentLeadIndex - 1]} Recorded! Please move electrodes for ${physicalLeads[currentLeadIndex]}',
          ),
        ),
      );
    } else {
      // All 8 physical leads recorded! Generate 12-lead report
      _generateFinal12LeadReport();
    }
  }

  /// Generate all 12 leads (calculates derived L3, aVR, aVL, aVF)
  Future<void> _generateFinal12LeadReport() async {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(child: CircularProgressIndicator()),
    );

    final leadsData = await _service.generate12LeadReport(
      deviceId: widget.deviceId,
      userId: widget.userId,
    );

    Navigator.pop(context); // Close loading dialog

    if (leadsData != null) {
      setState(() {
        final12LeadsData = leadsData;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('12-Lead ECG Report Generated Successfully!')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final currentLead = physicalLeads[currentLeadIndex];

    if (final12LeadsData != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Complete 12-Lead ECG Report')),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            children: [
              Text('Total Leads: ${final12LeadsData!.length}'),
              const SizedBox(height: 16),
              // Draw 12 ECG graphs...
              ...final12LeadsData!.entries.map((entry) => Card(
                child: ListTile(
                  title: Text('Lead: ${entry.key}'),
                  subtitle: Text('Sample Points: ${entry.value.length}'),
                ),
              )),
              ElevatedButton.icon(
                onPressed: () {
                  // Export PDF logic...
                },
                icon: const Icon(Icons.picture_as_pdf),
                label: const Text('Download PDF Report'),
              )
            ],
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('12-Lead ECG Recording')),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'Step ${currentLeadIndex + 1} of 8',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            Text(
              'Place Electrodes for $currentLead',
              style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: Colors.blue,
                  ),
            ),
            const SizedBox(height: 24),
            if (isRecording) ...[
              CircularProgressIndicator(
                value: (8 - countdownSeconds) / 8,
              ),
              const SizedBox(height: 16),
              Text(
                'Recording $currentLead... $countdownSeconds s remaining',
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
            ] else ...[
              ElevatedButton.icon(
                onPressed: _startRecordingCurrentLead,
                icon: const Icon(Icons.fiber_manual_record, color: Colors.red),
                label: Text('Start Recording $currentLead (8s)'),
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
```
