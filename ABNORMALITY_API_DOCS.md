# Abnormality Tracking System - API Documentation

## Overview

This system tracks and stores abnormalities detected in ECG data on a **per-user, per-day basis**. Each user has one MongoDB document per day containing all abnormalities detected that day in an array format.

---

## Schema Structure

### Database Schema: `Abnormality` Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId (ref to User),
  deviceId: String,
  date: String, // Format: "YYYY-MM-DD"
  abnormalities: [
    {
      timestamp: Date,
      abnormalityName: String,
      severity: "CRITICAL" | "WARNING" | "INFO",
      confidence: Number (0-1),
      bpm: Number,
      data: [Number],
      additionalData: Mixed
    }
  ],
  totalAbnormalities: Number,
  lastUpdated: Date,
  createdAt: Date
}
```

### Key Features:
- **Unique Index**: `{userId, date}` - ensures one document per user per day
- **Abnormalities Array**: grows throughout the day as events are detected
- **Severity Levels**: CRITICAL, WARNING, INFO
- **Automatic Date Tracking**: uses IST timezone

---

## API Endpoints

### 1. Store New Abnormality
**Endpoint:** `POST /api/abnormality`

**Description:** Store a detected abnormality for a user.

**Request Body:**
```json
{
  "userId": "USER_MONGO_ID",
  "deviceId": "ESP_ECG_123",
  "abnormalityName": "Atrial Fibrillation",
  "severity": "WARNING",
  "confidence": 0.87,
  "bpm": 125,
  "data": [512, 513, 510, 502],
  "additionalData": {
    "note": "CV=0.423, RMSSD=142ms",
    "qrs_width": 95
  }
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Abnormality stored successfully",
  "data": {
    "_id": "DOCUMENT_ID",
    "userId": "USER_ID",
    "deviceId": "ESP_ECG_123",
    "date": "2026-04-06",
    "abnormalities": [
      {
        "timestamp": "2026-04-06T14:32:15.000Z",
        "abnormalityName": "Atrial Fibrillation",
        "severity": "WARNING",
        "confidence": 0.87,
        "bpm": 125,
        "data": [512, 513, 510, 502],
        "additionalData": { "note": "..." }
      }
    ],
    "totalAbnormalities": 1
  }
}
```

---

### 2. Get Today's Abnormalities
**Endpoint:** `GET /api/abnormality/user/:userId`

**Description:** Retrieve all abnormalities detected for a user today (IST timezone).

**Example Request:**
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde"
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Abnormalities retrieved successfully",
  "count": 3,
  "data": {
    "_id": "DOCUMENT_ID",
    "userId": "60d5ec49c1234567890abcde",
    "deviceId": "ESP_ECG_123",
    "date": "2026-04-06",
    "abnormalities": [
      {
        "timestamp": "2026-04-06T09:15:22.000Z",
        "abnormalityName": "Sinus Tachycardia",
        "severity": "WARNING",
        "confidence": 0.90,
        "bpm": 115
      },
      {
        "timestamp": "2026-04-06T14:32:15.000Z",
        "abnormalityName": "Atrial Fibrillation",
        "severity": "WARNING",
        "confidence": 0.87,
        "bpm": 125
      },
      {
        "timestamp": "2026-04-06T18:45:33.000Z",
        "abnormalityName": "Ventricular Tachycardia",
        "severity": "CRITICAL",
        "confidence": 0.92,
        "bpm": 155
      }
    ],
    "totalAbnormalities": 3
  }
}
```

**Response (No data - 200):**
```json
{
  "success": true,
  "message": "No abnormalities recorded today",
  "data": null,
  "count": 0
}
```

---

### 3. Get Abnormalities by Specific Date
**Endpoint:** `GET /api/abnormality/user/:userId/date/:date`

**Description:** Retrieve abnormalities for a user on a specific date (format: YYYY-MM-DD).

**Example Request:**
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/date/2026-04-05"
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Abnormalities retrieved successfully",
  "count": 2,
  "data": { /* abnormality document */ }
}
```

---

### 4. Get Abnormalities in Date Range
**Endpoint:** `GET /api/abnormality/user/:userId/range?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

**Description:** Retrieve abnormalities within a date range (useful for dashboard/reports).

**Example Request:**
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/range?startDate=2026-04-01&endDate=2026-04-06"
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Abnormalities retrieved successfully",
  "count": 6,
  "totalRecords": 18,
  "data": [
    {
      "date": "2026-04-06",
      "deviceId": "ESP_ECG_123",
      "abnormalities": [/* array of 3 abnormalities */],
      "totalAbnormalities": 3
    },
    {
      "date": "2026-04-05",
      "deviceId": "ESP_ECG_123",
      "abnormalities": [/* array of 2 abnormalities */],
      "totalAbnormalities": 2
    }
  ]
}
```

---

### 5. Get Critical Abnormalities Only
**Endpoint:** `GET /api/abnormality/user/:userId/critical`

**Description:** Retrieve only CRITICAL abnormalities (filtered and sorted).

**Example Request:**
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/critical"
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Critical abnormalities retrieved successfully",
  "count": 2,
  "data": [
    {
      "date": "2026-04-06",
      "deviceId": "ESP_ECG_123",
      "critical_abnormalities": [
        {
          "timestamp": "2026-04-06T18:45:33.000Z",
          "abnormalityName": "Ventricular Tachycardia",
          "severity": "CRITICAL",
          "confidence": 0.92
        }
      ],
      "totalCritical": 1
    }
  ]
}
```

---

### 6. Delete Abnormalities by Date
**Endpoint:** `DELETE /api/abnormality/user/:userId/date/:date`

**Description:** Delete all abnormalities for a user on a specific date.

**Example Request:**
```bash
curl -X DELETE "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/date/2026-04-05"
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Abnormality record deleted successfully",
  "deletedCount": 1
}
```

---

## Python Frontend Integration

### Configuration

In `live_monitor_v5.5.py`, set the following:

```python
API_ABNORMALITY_URL = 'https://api-for-ecg.onrender.com/api/abnormality'
USER_ID = "YOUR_USER_MONGO_ID"  # Get this from your user database
DEVICE_ID = "ESP_ECG_123"  # Your device identifier
ABNORMALITY_DUPLICATE_PREVENTION_SEC = 60  # Prevent duplicate submissions
```

### How It Works

1. **Detection**: When an abnormality is detected in the ECG signal, the classification engine returns the condition name
2. **Deduplication**: The system checks if the same abnormality was sent within the last 60 seconds
3. **Submission**: If not a duplicate, the abnormality is posted to the backend API in a background thread
4. **Storage**: Backend automatically uses `findOneAndUpdate` to append to the day's array
5. **ECG Segment**: Optional raw ECG segment can be sent in data array for that abnormality event

### Example Code Flow

```python
# When abnormality is detected in _run() method:
post_abnormality_to_api(
    abnormality_name="Atrial Fibrillation",
    severity="WARNING",
    confidence=0.87,
    bpm=125,
  data=[512, 513, 510, 502],
    additional_data={"note": "CV=0.423, RMSSD=142ms"}
)
```

---

## Severity Levels

```python
SEVERITY = {
    'CRITICAL': [
        'Ventricular Fibrillation',
        'Ventricular Tachycardia',
        'Sinus Arrest',
        'Asystole'
    ],
    'WARNING': [
        'Atrial Fibrillation',
        'Sinus Tachycardia',
        'Sinus Bradycardia',
        'SVT'
    ],
    'INFO': [
        'Sinus Arrhythmia'
    ]
}
```

---

## Example Usage Scenarios

### Scenario 1: Get All Abnormalities for Today
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde"
```

### Scenario 2: Send New Abnormality Detection
```bash
curl -X POST "https://api-for-ecg.onrender.com/api/abnormality" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "60d5ec49c1234567890abcde",
    "deviceId": "ESP_ECG_123",
    "abnormalityName": "Ventricular Tachycardia",
    "severity": "CRITICAL",
    "confidence": 0.92,
    "bpm": 155,
    "data": [520, 515, 508, 500],
    "additionalData": {"qrs_width": 130, "pct_wide": 0.75}
  }'
```

### Scenario 3: Generate Weekly Report (Last 7 Days)
```javascript
const today = new Date();
const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
const startDate = sevenDaysAgo.toISOString().split('T')[0];
const endDate = today.toISOString().split('T')[0];

fetch(`/api/abnormality/user/${userId}/range?startDate=${startDate}&endDate=${endDate}`)
  .then(res => res.json())
  .then(data => {
    console.log(`Total abnormality events: ${data.totalRecords}`);
    console.log(`Days with abnormalities: ${data.count}`);
  });
```

### Scenario 4: Alert System - Get Only Critical Events
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/critical"
```

---

## Database Indexes

Indexes are automatically created:

1. **Unique Index**: `{userId: 1, date: 1}` - One document per user per day
2. **Query Index**: `{userId: 1, createdAt: -1}` - Efficient user-based queries
3. **Device Index**: `{deviceId: 1}` - Device tracking

---

## Error Handling

All endpoints return standardized error responses:

```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error message"
}
```

**Common Errors:**

- 400: Missing required fields (userId, deviceId, abnormalityName, severity)
- 400: Invalid date format for date endpoints
- 404: No abnormality record found for the specified criteria
- 500: Server error (database, connection issues)

---

## Notes for Implementation

1. **User ID**: Must be a valid MongoDB ObjectId from your `User` collection
2. **Date Format**: Always use `YYYY-MM-DD` format for date queries
3. **Timezone**: All dates use IST (UTC+5:30)
4. **Deduplication**: Frontend prevents sending same abnormality within 60 seconds
5. **ECG Data Array**: Optional data field supports raw ECG points for that abnormality event
6. **Array Growth**: Abnormalities array grows throughout the day, no limit set (adjust if needed)
7. **Time Sync**: Ensure server and client have synchronized clocks for accurate timestamps

---

## WiFi Credential API

If you also need to store WiFi credentials for a user/device pair, use:

- `POST /api/wifi-config`
- `GET /api/wifi-config/user/:userId`
- `GET /api/wifi-config/device/:deviceId`
- `DELETE /api/wifi-config/user/:userId/device/:deviceId`

### Save WiFi Credentials

```json
{
  "userId": "60d5ec49c1234567890abcde",
  "deviceId": "ESP_ECG_123",
  "ssid": "MyWiFi",
  "password": "MyPassword123",
  "isActive": true
}
```

### Example Fetch

```javascript
await fetch("https://api-for-ecg.onrender.com/api/wifi-config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId: "60d5ec49c1234567890abcde",
    deviceId: "ESP_ECG_123",
    ssid: "MyWiFi",
    password: "MyPassword123",
    isActive: true
  })
});
```
