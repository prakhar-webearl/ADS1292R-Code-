# Doctor Selection APIs

This document describes the APIs for selecting and listing active, approved doctors - used by admin when assigning doctors to consultancies.

## Base URL

- Local: `http://localhost:3000`
- Production: your deployed API URL

## Admin Authentication

All doctor selection endpoints require admin authentication:

- `Authorization: Bearer <ADMIN_JWT_TOKEN>`

---

## 1. Get Active & Approved Doctors

**Endpoint:**
- `GET /api/doctor/admin/active-approved`
- Protected route (admin auth required)

Use this endpoint to fetch the list of active and approved doctors when assigning a doctor to a consultancy.

### Query Parameters

All parameters are optional for filtering:

- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10)
- `search` - Search by full_name, email, phoneNumber, specialization, qualification, or clinicAddress
- `specialization` - Filter by specialization (partial match)

### Example Requests

**Get all active approved doctors (paginated):**

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Search for cardiologist:**

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?search=cardiologist" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Filter by specialization:**

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?specialization=Cardiology&page=1&limit=5" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Success Response

```json
{
  "success": true,
  "message": "Active approved doctors fetched successfully",
  "page": 1,
  "limit": 10,
  "totalDoctors": 5,
  "totalPages": 1,
  "doctors": [
    {
      "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
      "full_name": "Dr. Priya Singh",
      "email": "priya@clinic.com",
      "phoneNumber": "9876543210",
      "specialization": "Cardiology",
      "experienceYears": 8,
      "qualification": "MBBS, MD",
      "clinicAddress": "Ahmedabad, Gujarat",
      "bio": "Cardiac specialist with 8 years of experience",
      "status": "active",
      "approvalStatus": "approved",
      "approvedAt": "2026-04-21T10:10:00.000Z",
      "createdAt": "2026-04-21T10:00:00.000Z",
      "updatedAt": "2026-04-21T10:10:00.000Z"
    },
    {
      "_id": "66f1b2c3d4e5f6a7b8c9d0e1",
      "full_name": "Dr. Raj Sharma",
      "email": "raj@clinic.com",
      "phoneNumber": "8765432109",
      "specialization": "General Medicine",
      "experienceYears": 12,
      "qualification": "MBBS, MD",
      "clinicAddress": "Surat, Gujarat",
      "bio": "General physician with extensive experience",
      "status": "active",
      "approvalStatus": "approved",
      "approvedAt": "2026-04-20T12:30:00.000Z",
      "createdAt": "2026-04-20T11:00:00.000Z",
      "updatedAt": "2026-04-20T12:30:00.000Z"
    }
  ]
}
```

### Response Fields

- `success` - Boolean indicating success
- `message` - Response message
- `page` - Current page number
- `limit` - Items per page
- `totalDoctors` - Total count of active approved doctors
- `totalPages` - Total pages available
- `doctors` - Array of doctor objects

### Doctor Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Unique doctor ID (use this for assignment) |
| `full_name` | String | Doctor's full name |
| `email` | String | Doctor's email |
| `phoneNumber` | String | Doctor's phone |
| `specialization` | String | Doctor's specialization (e.g., "Cardiology") |
| `experienceYears` | Number | Years of experience |
| `qualification` | String | Medical qualifications (e.g., "MBBS, MD") |
| `clinicAddress` | String | Clinic location |
| `bio` | String | Doctor's bio/description |
| `status` | String | Always "active" (this endpoint only returns active doctors) |
| `approvalStatus` | String | Always "approved" (this endpoint only returns approved doctors) |
| `approvedAt` | Date | When doctor was approved |

### Error Responses

**Unauthorized (401):**
```json
{
  "success": false,
  "message": "Not authorized to access this resource"
}
```

**Forbidden (403):**
```json
{
  "success": false,
  "message": "You do not have permission to access this resource"
}
```

**Server Error (500):**
```json
{
  "success": false,
  "message": "Error fetching active approved doctors",
  "error": "error details"
}
```

---

## Workflow: Assigning Doctor to Consultancy

### Step 1: Get Unassigned Consultancies

Get the list of consultancies waiting for doctor assignment, including rejected consultancies that need reassignment:

```bash
curl "http://localhost:3000/api/consultancy/admin/unassigned" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

You can also filter and paginate:

```bash
curl "http://localhost:3000/api/consultancy/admin/unassigned?assignmentStatus=rejected&page=1&limit=10&search=rahul" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Response includes `page`, `limit`, `totalUnassigned`, `totalRejectedCount`, `totalPages`, and the consultancies array with full user details.

### Step 2: Get Active Doctors to Choose From

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Step 3: Assign Doctor to Consultancy

```bash
curl -X PATCH "http://localhost:3000/api/consultancy/admin/assign-doctor" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "consultancyId": "CONSULTANCY_ID_FROM_STEP_1",
    "doctorId": "DOCTOR_ID_FROM_STEP_2"
  }'
```

---

## Frontend Integration Example

### JavaScript/React Example

```javascript
// Get unassigned consultancies
const getUnassignedConsultancies = async (token) => {
  const response = await fetch(
    'http://localhost:9000/api/consultancy/admin/unassigned',
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
  return response.json();
};

// Get active approved doctors
const getActiveDoctors = async (token, search = '', page = 1, limit = 10) => {
  const url = new URL('http://localhost:9000/api/doctor/admin/active-approved');
  url.searchParams.append('page', page);
  url.searchParams.append('limit', limit);
  if (search) {
    url.searchParams.append('search', search);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.json();
};

// Assign doctor to consultancy
const assignDoctorToConsultancy = async (token, consultancyId, doctorId) => {
  const response = await fetch(
    'http://localhost:3000/api/consultancy/admin/assign-doctor',
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        consultancyId,
        doctorId,
      }),
    }
  );
  return response.json();
};

// Usage in admin panel
const adminPanel = async (adminToken) => {
  // 1. Load unassigned consultancies
  const consultanciesData = await getUnassignedConsultancies(adminToken);
  console.log(`Found ${consultanciesData.totalUnassigned} unassigned consultancies`);

  // 2. Load doctors for dropdown
  const doctorsData = await getActiveDoctors(adminToken);
  console.log(`Found ${doctorsData.totalDoctors} active doctors`);

  // 3. Assign first unassigned to first doctor (example)
  if (consultanciesData.consultancies.length > 0 && doctorsData.doctors.length > 0) {
    const consultancy = consultanciesData.consultancies[0];
    const doctor = doctorsData.doctors[0];

    const result = await assignDoctorToConsultancy(
      adminToken,
      consultancy._id,
      doctor._id
    );

    if (result.success) {
      console.log(
        `Assigned ${doctor.full_name} to consultancy for ${consultancy.userId.full_name}`
      );
    }
  }
};
```

---

## cURL Examples

**List first 10 active approved doctors:**

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?page=1&limit=10" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Search for "Dr. Priya":**

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?search=priya&page=1&limit=10" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Filter by Cardiology specialization:**

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?specialization=Cardiology&page=1&limit=10" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Search + Paginate (page 2, 5 per page):**

```bash
curl "http://localhost:3000/api/doctor/admin/active-approved?search=doctor&page=2&limit=5" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## Key Points

- ✅ Only returns **active** doctors (status = "active")
- ✅ Only returns **approved** doctors (approvalStatus = "approved")
- ✅ Excludes blocked or pending approval doctors
- ✅ Supports search and filtering
- ✅ Paginated response
- ✅ Requires admin authentication
- ✅ Safe to use in admin UI for dropdown/selection

