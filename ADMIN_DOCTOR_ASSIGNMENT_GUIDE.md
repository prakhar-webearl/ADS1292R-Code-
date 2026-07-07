# Admin Doctor Assignment Workflow

Complete step-by-step guide for admins to manage consultancy bookings and assign doctors.

## Quick Workflow (Admin Dashboard)

```
1. LOGIN
   └─ POST /api/appAdmin/login → Get admin token
   
2. VIEW UNASSIGNED CONSULTANCIES
   └─ GET /api/consultancy/admin/unassigned → See pending assignments
   
3. CHOOSE DOCTOR TO ASSIGN
   └─ GET /api/doctor/admin/active-approved → List available doctors
   
4. ASSIGN DOCTOR
   └─ PATCH /api/consultancy/admin/assign-doctor → Assign selected doctor
   
5. VERIFY ASSIGNMENT
   └─ GET /api/consultancy/admin/getAll → See all with doctor info
```

---

## API Endpoints for Admin

### 1. Get All Consultancies (with assignments)

```bash
GET /api/consultancy/admin/getAll
Authorization: Bearer ADMIN_TOKEN
```

Shows all bookings including unassigned ones (doctorId = null).

**Response:**
```json
{
  "success": true,
  "totalBookings": 5,
  "bookings": [
    {
      "_id": "id1",
      "full_name": "Rahul",
      "consultationDate": "2026-05-15",
      "timeSlot": "10:00 AM",
      "doctorId": "doc1",        // ✅ Assigned
      "doctorAssignedAt": "2026-05-10T..."
    },
    {
      "_id": "id2",
      "full_name": "Priya",
      "consultationDate": "2026-05-16",
      "timeSlot": "11:00 AM",
      "doctorId": null,          // ❌ Not assigned
      "doctorAssignedAt": null
    }
  ]
}
```

### 2. Get Only Unassigned Consultancies (NEW)

```bash
GET /api/consultancy/admin/unassigned
Authorization: Bearer ADMIN_TOKEN
```

Shows **only** consultancies waiting for doctor assignment.

**Response:**
```json
{
  "success": true,
  "totalUnassigned": 2,
  "consultancies": [
    {
      "_id": "id2",
      "userId": {
        "full_name": "Priya Verma",
        "email": "priya@email.com",
        "phoneNumber": "9876543210",
        "dob": "1992-03-20",
        "gender": "Female",
        "weight": 60,
        "height": 165
      },
      "consultationDate": "2026-05-16T00:00:00.000Z",
      "timeSlot": "11:00 AM - 11:30 AM",
      "amount": 499,
      "notes": "Follow-up for ECG",
      "doctorId": null,
      "doctorAssignedAt": null
    }
  ]
}
```

### 3. Get Active & Approved Doctors (NEW)

```bash
GET /api/doctor/admin/active-approved?page=1&limit=10&search=cardiologist
Authorization: Bearer ADMIN_TOKEN
```

Shows active and approved doctors available for assignment.

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Records per page (default: 10)
- `search` - Search by name, email, phone, specialization, etc.
- `specialization` - Filter by specialty

**Response:**
```json
{
  "success": true,
  "page": 1,
  "limit": 10,
  "totalDoctors": 3,
  "totalPages": 1,
  "doctors": [
    {
      "_id": "doc1",
      "full_name": "Dr. Priya Singh",
      "email": "priya@clinic.com",
      "phoneNumber": "9876543210",
      "specialization": "Cardiology",
      "experienceYears": 8,
      "qualification": "MBBS, MD",
      "clinicAddress": "Ahmedabad, Gujarat",
      "bio": "Cardiac specialist",
      "status": "active",
      "approvalStatus": "approved"
    }
  ]
}
```

### 4. Assign Doctor to Consultancy

```bash
PATCH /api/consultancy/admin/assign-doctor
Authorization: Bearer ADMIN_TOKEN
Content-Type: application/json

{
  "consultancyId": "id2",
  "doctorId": "doc1"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Doctor assigned successfully",
  "booking": {
    "_id": "id2",
    "userId": { ... },
    "doctorId": "doc1",
    "doctorAssignedAt": "2026-05-10T14:30:00Z",
    "doctorDetails": {
      "full_name": "Dr. Priya Singh",
      "specialization": "Cardiology"
    }
  }
}
```

---

## Admin UI Flow

### Screen 1: Dashboard - Unassigned Consultancies

```
[Admin Dashboard]
   ↓
GET /api/consultancy/admin/unassigned
   ↓
Show list:
┌─────────────────────────────────────┐
│ UNASSIGNED CONSULTANCIES            │
├─────────────────────────────────────┤
│ Patient: Priya Verma                │
│ Date: 15 May 2026, 11:00 AM         │
│ Email: priya@email.com              │
│ [Assign Doctor Button]              │
├─────────────────────────────────────┤
│ Patient: Raj Kumar                  │
│ Date: 16 May 2026, 2:00 PM          │
│ Email: raj@email.com                │
│ [Assign Doctor Button]              │
└─────────────────────────────────────┘
```

### Screen 2: Doctor Selection Modal (on button click)

```
[Select Doctor for Priya Verma's Consultancy]
   ↓
GET /api/doctor/admin/active-approved?search=&page=1&limit=10
   ↓
Show dropdown/table:
┌──────────────────────────────────────┐
│ Search: [           ] [Search]      │
│                                      │
│ Available Doctors:                   │
├──────────────────────────────────────┤
│ ✓ Dr. Priya Singh (Cardiology)       │
│   Experience: 8 years                │
│                                      │
│ ✓ Dr. Raj Sharma (General Medicine)  │
│   Experience: 12 years               │
│                                      │
│ ✓ Dr. Anjali Patel (Neurology)       │
│   Experience: 5 years                │
└──────────────────────────────────────┘
```

### Screen 3: Assignment Confirmation

```
User selects "Dr. Priya Singh"
   ↓
PATCH /api/consultancy/admin/assign-doctor
   ↓
Success! Show confirmation:
┌──────────────────────────────────────┐
│ ✓ Doctor Assigned Successfully       │
│                                      │
│ Consultancy: Priya Verma             │
│ Doctor: Dr. Priya Singh              │
│ Date: 15 May 2026, 11:00 AM          │
│ Assigned At: 10 May 2026, 2:30 PM    │
│                                      │
│ [Close] [View All Bookings]          │
└──────────────────────────────────────┘
```

---

## Complete cURL Workflow Example

```bash
# Step 1: Get admin token
curl -X POST http://localhost:3000/api/appAdmin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@ecg.com",
    "password": "admin123"
  }' > admin_login.json

ADMIN_TOKEN=$(cat admin_login.json | jq -r '.token')

# Step 2: View unassigned consultancies
curl http://localhost:3000/api/consultancy/admin/unassigned \
  -H "Authorization: Bearer $ADMIN_TOKEN" > unassigned.json

CONSULTANCY_ID=$(cat unassigned.json | jq -r '.consultancies[0]._id')
PATIENT_NAME=$(cat unassigned.json | jq -r '.consultancies[0].userId.full_name')

echo "Found unassigned consultancy for: $PATIENT_NAME"

# Step 3: Get available doctors
curl "http://localhost:3000/api/doctor/admin/active-approved?limit=5" \
  -H "Authorization: Bearer $ADMIN_TOKEN" > doctors.json

DOCTOR_ID=$(cat doctors.json | jq -r '.doctors[0]._id')
DOCTOR_NAME=$(cat doctors.json | jq -r '.doctors[0].full_name')

echo "Selected doctor: $DOCTOR_NAME"

# Step 4: Assign doctor to consultancy
curl -X PATCH http://localhost:3000/api/consultancy/admin/assign-doctor \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{
    \"consultancyId\": \"$CONSULTANCY_ID\",
    \"doctorId\": \"$DOCTOR_ID\"
  }"

echo "Assignment complete!"
```

---

## Field Reference

### Consultancy Fields

| Field | Type | Value | Description |
|-------|------|-------|-------------|
| `_id` | String | Object ID | Unique consultancy ID |
| `userId` | Object | User details | Patient information |
| `full_name` | String | Patient name | Full name of patient |
| `email` | String | Email | Patient email |
| `phoneNumber` | String | Phone | Patient contact |
| `consultationDate` | Date | ISO 8601 | Date of consultation |
| `timeSlot` | String | "10:00 AM" | Time slot |
| `amount` | Number | 499 | Booking amount (rupees) |
| `paymentStatus` | String | "paid" | Must be "paid" |
| `bookingStatus` | String | "booked" | Must be "booked" |
| `doctorId` | String | Doctor ID | null if unassigned |
| `doctorAssignedAt` | Date | ISO 8601 | When assigned |

### Doctor Fields

| Field | Type | Value | Description |
|-------|------|-------|-------------|
| `_id` | String | Object ID | Unique doctor ID (use for assignment) |
| `full_name` | String | Name | Doctor name |
| `email` | String | Email | Doctor email |
| `phoneNumber` | String | Phone | Doctor contact |
| `specialization` | String | "Cardiology" | Medical specialization |
| `experienceYears` | Number | 8 | Years of experience |
| `qualification` | String | "MBBS, MD" | Medical qualifications |
| `clinicAddress` | String | Address | Clinic location |
| `bio` | String | Bio | Doctor bio |
| `status` | String | "active" | Always active (filter applied) |
| `approvalStatus` | String | "approved" | Always approved (filter applied) |

---

## Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Assignment completed |
| 400 | Bad Request | Invalid data sent |
| 401 | Unauthorized | Admin token missing/invalid |
| 403 | Forbidden | Not admin user |
| 404 | Not Found | Consultancy or doctor not found |
| 500 | Server Error | Backend issue |

---

## Notes

✅ **Only unassigned consultancies** are shown in `/admin/unassigned`  
✅ **Only active approved doctors** are shown in `/admin/active-approved`  
✅ **Blocked or pending** doctors are automatically filtered out  
✅ **Search works** on multiple fields (name, email, phone, specialty)  
✅ **Results are paginated** for large datasets  
✅ **Assignment is one-time** - doctor cannot be reassigned to same consultancy  

