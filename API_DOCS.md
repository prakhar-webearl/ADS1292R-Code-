# ECG Data API Documentation

This document explains how your client-side applications (such as a hardware device sending data or a frontend React dashboard receiving data) should interact with the ECG API.

---

## 1. Sending Data to the Server (Device / Hardware)

**Endpoint:** `POST /api/ecg`
**Description:** Use this route to send a chunk of ECG data (e.g., 1 second of data containing 360 points) to the database.
**Content-Type:** `application/json`

### Payload Structure

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `deviceId` | String | Yes | Unique identifier for your hardware device. |
| `seq` | Number | Yes | Sequence number to track ordered chunks. |
| `sr` | Number | Yes | Sample rate (e.g., 360). |
| `lo` | Boolean | Yes | Lead-off status (`true` or `false`). |
| `data` | Array[Number] | Yes | Array of recorded numeric data points. |

### Example Request (JavaScript/Fetch)

You should run a timer on your device that gathers the points and shoots them out every 1 second:

```javascript
const sendEcgData = async () => {
  const payload = {
    deviceId: "device_XYZ_123",
    seq: 1205,
    sr: 360,
    lo: false,
    data: [512, 514, 516 /* ... 360 data points here ... */]
  };

  try {
    const response = await fetch('http://localhost:3000/api/ecg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log("Data successfully saved:", result);

  } catch (error) {
    console.error("Error sending ECG data:", error);
  }
};

// Send data exactly every 1 second
setInterval(sendEcgData, 1000);
```

---

## 2. Retrieving Data from the Server (Frontend / Dashboard)

**Endpoint:** `GET /api/ecg/:deviceId`
**Description:** Use this route to fetch the most recent chronological data chunks for a specific device so you can plot them on a graph.
**Query Parameters:**
- `?limit=10` (Optional): The number of seconds (database rows) to fetch. Defaults to 10.

### Example Request (JavaScript/Fetch)

Your frontend dashboard can run a loop to fetch the newest data and render the graph.

```javascript
const fetchEcgData = async () => {
  const deviceId = "device_XYZ_123";
  
  try {
    // Fetch the 10 most recent seconds of data
    const response = await fetch(`http://localhost:3000/api/ecg/${deviceId}?limit=10`);
    const result = await response.json();

    if (result.success) {
      console.log(`Fetched ${result.count} chunks of data!`);
      
      const chronologicalData = result.data;
      
      // Plot "chronologicalData" to your graph...
      chronologicalData.forEach(chunk => {
        console.log("Chunk Sequence:", chunk.seq);
        console.log("ECG Values:", chunk.data);
      });
    }
  } catch (error) {
    console.error("Error retrieving ECG data:", error);
  }
};

// Fetch fresh data every 1 second to keep the graph moving
setInterval(fetchEcgData, 1000);
```

### JSON Response Format

```json
{
  "success": true,
  "count": 10,
  "data": [
    {
      "_id": "69aa639dff2b628424ce010b",
      "deviceId": "device_XYZ_123",
      "seq": 1201,
      "sr": 360,
      "lo": false,
      "data": [512, 514, 516],
      "createdAt": "2026-03-06T05:18:21.699Z",
      "updatedAt": "2026-03-06T05:18:21.699Z",
      "__v": 0
    }
  ]
}
```
