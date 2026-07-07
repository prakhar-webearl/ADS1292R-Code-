# Abnormality Tracking - Implementation Guide

## What Was Created

### 1. **MongoDB Schema** (`models/abnormalityModel.js`)
   - Stores abnormalities per user, per day
   - One document per day per user (unique index on `{userId, date}`)
   - Abnormalities stored in an array that grows throughout the day
   - Includes severity levels: CRITICAL, WARNING, INFO
   - Automatic IST timezone handling

### 2. **Backend Controller** (`controllers/abnormalityController.js`)
   - `storeAbnormality()` - POST new abnormality
   - `getAbnormalitiesForToday()` - GET today's abnormalities
   - `getAbnormalitiesByDate()` - GET abnormalities for specific date
   - `getAbnormalitiesDateRange()` - GET abnormalities between dates
   - `getCriticalAbnormalities()` - GET only CRITICAL events
   - `deleteAbnormalitiesByDate()` - DELETE by date

### 3. **Routes** (`routes/abnormality.routes.js`)
   - All endpoints properly mounted and ready to use

### 4. **Frontend Script** (`live_monitor_v5.5.py`)
   - Enhanced Python script with abnormality submission
   - Automatic duplicate prevention (60-second window)
   - Sends abnormality data to backend API in background thread
   - Maintains all existing ECG visualization features

### 5. **API Documentation** (`ABNORMALITY_API_DOCS.md`)
   - Complete reference for all endpoints
   - Example curl requests and responses
   - Database schema details

---

## Quick Start

### Step 1: Update Your index.js
The abnormality routes have already been added to `index.js`. Verify it includes:

```javascript
import abnormalityRoutes from './routes/abnormality.routes.js'
// ...
app.use('/api/abnormality', abnormalityRoutes)
```

### Step 2: Configure the Frontend

Edit `live_monitor_v5.5.py` and set:

```python
USER_ID = "YOUR_ACTUAL_USER_MONGO_ID"  # Get from your user database
DEVICE_ID = "ESP_ECG_123"  # Your device ID
ABNORMALITY_DUPLICATE_PREVENTION_SEC = 60
```

### Step 3: Run the Enhanced Monitor

```bash
python live_monitor_v5.5.py
```

When abnormalities are detected, they'll be:
1. Displayed in the GUI (as before)
2. **Automatically sent to backend API**
3. **Stored in MongoDB** under the user's daily document
4. **Deduplicated** to prevent spam

---

## API Usage Examples

### Store Abnormality
```bash
curl -X POST "https://api-for-ecg.onrender.com/api/abnormality" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "60d5ec49c1234567890abcde",
    "deviceId": "ESP_ECG_123",
    "abnormalityName": "Atrial Fibrillation",
    "severity": "WARNING",
    "confidence": 0.87,
    "bpm": 125
  }'
```

### Get Today's Abnormalities
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde"
```

### Get Abnormalities for a Date
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/date/2026-04-06"
```

### Get Critical Only
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/critical"
```

### Get Date Range (Weekly Report)
```bash
curl -X GET "https://api-for-ecg.onrender.com/api/abnormality/user/60d5ec49c1234567890abcde/range?startDate=2026-04-01&endDate=2026-04-07"
```

---

## Database Structure Example

After a day of monitoring, your MongoDB document looks like:

```javascript
{
  "_id": ObjectId("507f1f77bcf86cd799439011"),
  "userId": ObjectId("60d5ec49c1234567890abcde"),
  "deviceId": "ESP_ECG_123",
  "date": "2026-04-06",
  "abnormalities": [
    {
      "timestamp": ISODate("2026-04-06T09:15:22.000Z"),
      "abnormalityName": "Sinus Tachycardia",
      "severity": "WARNING",
      "confidence": 0.9,
      "bpm": 115,
      "additionalData": {}
    },
    {
      "timestamp": ISODate("2026-04-06T14:32:15.000Z"),
      "abnormalityName": "Atrial Fibrillation",
      "severity": "WARNING",
      "confidence": 0.87,
      "bpm": 125,
      "additionalData": { "note": "CV=0.423, RMSSD=142ms" }
    },
    {
      "timestamp": ISODate("2026-04-06T18:45:33.000Z"),
      "abnormalityName": "Ventricular Tachycardia",
      "severity": "CRITICAL",
      "confidence": 0.92,
      "bpm": 155,
      "additionalData": { "qrs_width": 130 }
    }
  ],
  "totalAbnormalities": 3,
  "lastUpdated": ISODate("2026-04-06T18:45:33.000Z"),
  "createdAt": ISODate("2026-04-06T09:15:22.000Z")
}
```

---

## Features

✅ **One document per user per day** - Efficient storage  
✅ **Abnormalities in array** - Easy to append and retrieve  
✅ **Duplicate prevention** - No spam submissions (60-second window)  
✅ **Severity classification** - CRITICAL/WARNING/INFO sorting  
✅ **Date-based queries** - Get data for specific dates or ranges  
✅ **Critical alert filter** - Quick access to severe events  
✅ **IST timezone** - Automatic India Standard Time handling  
✅ **Background submission** - Non-blocking API calls  
✅ **Auto-indexing** - Optimized for queries  

---

## Frontend Changes

The new `live_monitor_v5.5.py` includes:

1. **New global variables**:
   ```python
   API_ABNORMALITY_URL = '...'
   USER_ID = "..."
   DEVICE_ID = "..."
   abnormality_tracker = {}  # Deduplication
   ```

2. **New function**: `post_abnormality_to_api()`
   - Handles duplicate prevention
   - Submits in background thread
   - Graceful error handling

3. **Modified LiveDetector._run()**
   - Calls `post_abnormality_to_api()` when abnormality detected
   - Still maintains all visualization logic

4. **No breaking changes** - All existing features work unchanged

---

## Next Steps

### 1. Test the API
Use the Postman collection or curl commands from `ABNORMALITY_API_DOCS.md`

### 2. Build a Dashboard
Create a web UI to display:
- Today's abnormalities count
- Critical events alert
- Weekly trend graphs
- Filter by severity

### 3. Enable Notifications
Send notifications for CRITICAL events:
- Push notifications
- Email alerts
- SMS alerts (via Twilio)

### 4. Generate Reports
Create PDF/CSV reports using the date range endpoint

---

## Troubleshooting

**Issue**: Abnormalities not being stored
- Check USER_ID is a valid MongoDB ObjectId
- Verify API endpoint URL is correct
- Check backend logs for errors

**Issue**: Duplicate submissions
- `ABNORMALITY_DUPLICATE_PREVENTION_SEC` might be too low
- Increase to 120 seconds if needed

**Issue**: Wrong date in database
- Verify server timezone is IST
- Check `getISTTime()` function

**Issue**: API returns 400 error
- Verify all required fields are sent
- Check data types (severity must be "CRITICAL", "WARNING", or "INFO")

---

## Files Modified/Created

| File | Status | Description |
|------|--------|-------------|
| `models/abnormalityModel.js` | ✅ Created | MongoDB schema |
| `controllers/abnormalityController.js` | ✅ Created | API logic |
| `routes/abnormality.routes.js` | ✅ Created | Route definitions |
| `index.js` | ✅ Updated | Route mounting |
| `live_monitor_v5.5.py` | ✅ Created | Enhanced frontend |
| `ABNORMALITY_API_DOCS.md` | ✅ Created | Complete documentation |

---

## Support

For detailed API reference, see: `ABNORMALITY_API_DOCS.md`  
For ECG monitoring, see: `API_DOCS.md`
