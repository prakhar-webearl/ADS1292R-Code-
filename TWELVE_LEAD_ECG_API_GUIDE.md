# 12-Lead ECG API Integration Guide

This document explains how your **Hardware / Mobile App** records 8 seconds of data per physical lead (`L1`, `L2`, `V1`..`V6`) and automatically generates the complete 12-Lead ECG report.

---

## 1. Step-by-Step Recording Workflow (8 Seconds Per Lead)

1. **Record Lead I (L1)**:
   - App calls `POST /api/ecg/lead-session` with `{ deviceId, userId, lead: "L1" }`.
   - Device streams sample chunks to `POST /api/ecg`.
   - Backend collects **8 seconds** ($8 \times \text{sr}$ sample points) for `L1` and stops `L1`.

2. **Move Electrodes & Record Lead II (L2)**:
   - App calls `POST /api/ecg/lead-session` with `{ deviceId, userId, lead: "L2" }`.
   - Device streams sample chunks to `POST /api/ecg`.
   - Backend collects **8 seconds** of data for `L2` and stops `L2`.

3. **Repeat for Chest Leads (V1, V2, V3, V4, V5, V6)**:
   - For each lead (`V1` to `V6`), app sets lead session, patient moves electrodes, device streams 8s data.

4. **Automatic Calculation on Final Lead Arrival**:
   - As soon as the 8th physical lead (`V6`) completes its 8 seconds of data, the backend **automatically calculates** the 4 derived limb leads:
     - **Lead III**: $\text{Lead II} - \text{Lead I}$
     - **aVR**: $-\frac{\text{Lead I} + \text{Lead II}}{2}$
     - **aVL**: $\text{Lead I} - \frac{\text{Lead II}}{2}$
     - **aVF**: $\text{Lead II} - \frac{\text{Lead I}}{2}$
   - Stores all 12 leads into the database and marks `status: "completed"`.

---

## 2. API Endpoints

### 2.1 Set Active Lead Session
- **Endpoint:** `POST /api/ecg/lead-session`
- **Request Body:**
```json
{
  "deviceId": "ESP32_001",
  "userId": "user123",
  "lead": "L1"
}
```

---

### 2.2 Post Raw Lead Chunk Data (Device)
- **Endpoint:** `POST /api/ecg`
- **Request Body:**
```json
{
  "deviceId": "ESP32_001",
  "userId": "user123",
  "seq": 101,
  "sr": 250,
  "lo": false,
  "data": [2048, 2055, 2060, 2050]
}
```

---

### 2.3 Fetch / Generate Latest 12-Lead Report
- **Endpoint:** `POST /api/ecg/generate-12-lead` or `GET /api/ecg/generate-12-lead` or `GET /api/ecg/12-lead/latest`
- **GET Request:** `GET /api/ecg/generate-12-lead?deviceId=ESP32_001&userId=user123`
- **Description:** Returns the **absolute latest** 12-lead report for the given `deviceId` and `userId` (sorted by `{ _id: -1, updatedAt: -1 }`).

#### Response Payload (All 12 Leads - Guaranteed Latest Document)
```json
{
  "success": true,
  "completed": true,
  "totalLeads": 12,
  "testId": "69ca740bfa123456789abcde",
  "leads": {
    "L1": [ ... 8s data ... ],
    "L2": [ ... 8s data ... ],
    "L3": [ ... 8s derived ... ],
    "aVR": [ ... 8s derived ... ],
    "aVL": [ ... 8s derived ... ],
    "aVF": [ ... 8s derived ... ],
    "V1": [ ... 8s data ... ],
    "V2": [ ... 8s data ... ],
    "V3": [ ... 8s data/interpolated ... ],
    "V4": [ ... 8s data ... ],
    "V5": [ ... 8s data ... ],
    "V6": [ ... 8s data ... ]
  }
}
```
