    # Consultancy Booking Complete Workflow

This document covers the entire consultancy booking system flow: **user booking → plan quota check → payment → admin doctor assignment → doctor consultation**.

## Base URL

- Local: `http://localhost:9000`
- Production: your deployed API URL

---

## Part 1: User Booking Flow (Frontend Integration)

### Authentication (User)

For protected user routes, send token in header:

- `Authorization: Bearer <JWT_TOKEN>`

### Step 1: Create Consultancy Booking (User Books Consultancy)

**Endpoint:**
- `POST /api/consultancy/create-order`
- Protected route (user auth required)

Before creating a booking, the backend checks the authenticated user's active plan:

- **All plans enforce `consultancyCount` quota** (both free and paid).
- If quota is available: booking is **free** (amount = 0).
- If quota is exhausted: return 403 with hint to use `payIfNoFree: true` for one-off paid booking.
- One-off paid booking (after quota exhausted) requires `amount` and Razorpay payment.

**Request Body:**

```json
{
  "consultationDate": "2026-05-15",
  "timeSlot": "10:00 AM - 10:30 AM",
  "consultationDurationMinutes": 20,
  "consultationLanguage": "Hindi",
  "monitorId": "ESP_ECG_123",
  "currency": "INR",
  "full_name": "Rahul Sharma",
  "email": "rahul@example.com",
  "phoneNumber": "9876543210",
  "notes": "Need consultation for ECG report",
  "memberId": "665f1b2c9a8b2c0098765432",
  "memberName": "Anita Sharma",
  "memberRelation": "Mother"
}
```

**Success Response (Paid Plan):**

```json
{
  "success": true,
  "message": "Razorpay order created. Complete payment to confirm booking",
  "key": "rzp_test_xxxxx",
  "booking": {
    "_id": "BOOKING_ID",
    "razorpayOrderId": "order_Q2abc123",
    "paymentStatus": "pending",
    "bookingStatus": "pending",
    "doctorId": null,
    "monitorId": "ESP_ECG_123"
  },
  "order": {
    "id": "order_Q2abc123",
    "entity": "order",
    "amount": 49900,
    "currency": "INR"
  }
}
```

`consultationDurationMinutes` supports: `15`, `20`, `30`, `45`, `60` (default `30` if omitted).

**Success Response (Free Plan):**

```json
{
  "success": true,
  "message": "Free plan consultancy booked successfully",
  "booking": {
    "_id": "BOOKING_ID",
    "paymentStatus": "paid",
    "bookingStatus": "booked",
    "amount": 0,
    "doctorId": null,
    "monitorId": "ESP_ECG_123"
  },
  "planUsage": {
    "isUnlimited": false,
    "limit": 10,
    "used": 3,
    "remaining": 7
  }
}
```

### Step 2: Verify Payment (Paid Plans Only)

**Endpoint:**
- `POST /api/consultancy/verify-payment`
- Protected route (user auth required)

**Request Body:**

```json
{
  "bookingId": "BOOKING_ID",
  "razorpay_order_id": "order_Q2abc123",
  "razorpay_payment_id": "pay_Q2xyz456",
  "razorpay_signature": "generated_signature_from_razorpay"
}
```

**Success Response:**

```json
{
  "success": true,
  "message": "Payment verified and consultancy booked successfully",
  "booking": {
    "_id": "BOOKING_ID",
    "paymentStatus": "paid",
    "bookingStatus": "booked",
    "doctorId": null,
    "doctorAssignedAt": null,
    "doctorAssignmentStatus": "unassigned"
  }
}
```

**Important:**

- Free plan bookings are confirmed directly in Step 1.
- Paid plan bookings are confirmed after Step 2 signature verification.
- Doctor is assigned later by admin.

### Step 3: Get User's Bookings

**Endpoint:**
- `GET /api/consultancy/my-bookings`
- Protected route (user auth required)

**Success Response:**

```json
{
  "success": true,
  "totalBookings": 2,
  "bookings": [
    {
      "_id": "BOOKING_ID",
      "consultationDate": "2026-05-15T00:00:00.000Z",
      "timeSlot": "10:00 AM - 10:30 AM",
      "consultationDurationMinutes": 20,
      "paymentStatus": "paid",
      "bookingStatus": "booked",
      "doctorId": null,
      "doctorAssignedAt": null,
      "full_name": "Rahul Sharma",
      "amount": 499
    }
  ]
}
```

---

## Part 2: Admin Workflow

### Authentication (Admin)

For admin routes, send token in header:

- `Authorization: Bearer <ADMIN_JWT_TOKEN>`

### Admin API 1: Get All Consultancy Bookings

**Endpoint:**
- `GET /api/consultancy/admin/getAll`
- Protected route (admin auth required)

**Success Response:**

```json
{
  "success": true,
  "message": "All consultancy bookings fetched successfully",
  "totalBookings": 5,
  "bookings": [
    {
      "_id": "BOOKING_ID",
      "userId": {
        "_id": "USER_ID",
        "full_name": "Rahul Sharma",
        "email": "rahul@example.com",
        "phoneNumber": "9876543210",
        "status": "active"
      },
      "consultationDate": "2026-05-15T00:00:00.000Z",
      "timeSlot": "10:00 AM - 10:30 AM",
      "consultationDurationMinutes": 20,
      "consultationLanguage": "Hindi",
      "amount": 499,
      "paymentStatus": "paid",
      "bookingStatus": "booked",
      "doctorId": null,
      "doctorAssignedAt": null
    }
  ]
}
```

### Admin API 2: Assign Doctor to Consultancy

**Endpoint:**
- `PATCH /api/consultancy/admin/assign-doctor`
- Protected route (admin auth required)

**Request Body:**

```json
{
  "consultancyId": "BOOKING_ID",
  "doctorId": "DOCTOR_ID"
}
```

**Success Response:**

```json
{
  "success": true,
  "message": "Doctor assigned successfully",
  "booking": {
    "_id": "BOOKING_ID",
    "userId": {
      "full_name": "Rahul Sharma",
      "email": "rahul@example.com",
      "phoneNumber": "9876543210"
    },
    "consultationDate": "2026-05-15T00:00:00.000Z",
    "timeSlot": "10:00 AM - 10:30 AM",
    "amount": 499,
    "paymentStatus": "paid",
    "bookingStatus": "booked",
    "doctorId": "DOCTOR_ID",
    "doctorAssignedAt": "2026-05-10T14:30:00.000Z",
    "doctorDetails": {
      "_id": "DOCTOR_ID",
      "full_name": "Dr. Priya Singh",
      "email": "priya@clinic.com",
      "specialization": "Cardiology"
    }
  }
}
```

**Error Cases:**
- `400`: Consultancy not in "booked" or "paid" status
- `404`: Consultancy ID not found

### Admin API 3: Get Unassigned Consultancies

**Endpoint:**
- `GET /api/consultancy/admin/unassigned`
- Protected route (admin auth required)

Use this to view consultancies that are waiting for assignment or were rejected by a doctor.

### Query Parameters

- `page` - Page number, default `1`
- `limit` - Items per page, default `10`
- `search` - Search by patient name, email, phone number, or time slot
- `assignmentStatus` - Optional filter: `all`, `unassigned`, `pending`, `approved`, or `rejected`

### Example Requests

```bash
curl "http://localhost:3000/api/consultancy/admin/unassigned?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

```bash
curl "http://localhost:3000/api/consultancy/admin/unassigned?assignmentStatus=rejected&search=rahul&page=1&limit=10" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Success Response:**

```json
{
  "success": true,
  "message": "Unassigned consultancies fetched successfully",
  "page": 1,
  "limit": 10,
  "totalUnassigned": 3,
  "totalRejectedCount": 1,
  "totalPages": 1,
  "consultancies": [
    {
      "_id": "BOOKING_ID",
      "userId": {
        "_id": "USER_ID",
        "full_name": "Rahul Sharma",
        "email": "rahul@example.com",
        "phoneNumber": "9876543210",
        "dob": "1990-05-15T00:00:00.000Z",
        "gender": "Male",
        "weight": 75,
        "height": 180
      },
      "consultationDate": "2026-05-15T00:00:00.000Z",
      "timeSlot": "10:00 AM - 10:30 AM",
      "amount": 499,
      "paymentStatus": "paid",
      "bookingStatus": "booked",
      "doctorId": null,
      "doctorAssignedAt": null,
      "notes": "Need consultation for ECG report"
    }
  ]
}
```

**Notes:**
- `assignmentStatus=rejected` returns doctor-rejected consultancies for reassignment.
- `assignmentStatus=unassigned` returns only consultancies that have not been assigned yet, including older records where `doctorAssignmentStatus` was never stored.
- Pagination keeps the list manageable for admin screens.
- `totalRejectedCount` gives the overall count of doctor-rejected consultancies for the admin dashboard.

---

## Part 3: Doctor Workflow

### Authentication (Doctor)

For doctor routes, send token in header:

- `Authorization: Bearer <DOCTOR_JWT_TOKEN>`

### Doctor API: Get My Assigned Consultancies

**Endpoint:**
- `GET /api/consultancy/doctor/my-consultancies`
- Protected route (doctor auth required)

### Query Parameters

- `assignmentStatus` - Optional filter: `all`, `pending`, `approved`, or `rejected`

### Example Requests

```bash
curl "http://localhost:3000/api/consultancy/doctor/my-consultancies?assignmentStatus=all" \
  -H "Authorization: Bearer YOUR_DOCTOR_TOKEN"
```

```bash
curl "http://localhost:3000/api/consultancy/doctor/my-consultancies?assignmentStatus=approved" \
  -H "Authorization: Bearer YOUR_DOCTOR_TOKEN"
```

```bash
curl "http://localhost:3000/api/consultancy/doctor/my-consultancies?assignmentStatus=rejected" \
  -H "Authorization: Bearer YOUR_DOCTOR_TOKEN"
```

**Success Response:**

```json
{
  "success": true,
  "message": "Doctor consultancies fetched successfully",
  "assignmentStatus": "all",
  "totalConsultancies": 3,
  "consultancies": [
    {
      "_id": "BOOKING_ID",
      "userId": {
        "_id": "USER_ID",
        "full_name": "Rahul Sharma",
        "email": "rahul@example.com",
        "phoneNumber": "9876543210",
        "dob": "1990-05-15T00:00:00.000Z",
        "gender": "Male",
        "weight": 75,
        "height": 180
      },
      "consultationDate": "2026-05-15T00:00:00.000Z",
      "timeSlot": "10:00 AM - 10:30 AM",
      "amount": 499,
      "paymentStatus": "paid",
      "bookingStatus": "booked",
      "doctorAssignedAt": "2026-05-10T14:30:00.000Z",
      "notes": "Need consultation for ECG report"
    }
  ]
}
```

**Features:**
- Shows consultancies assigned to the logged-in doctor
- Sorted by consultation date (upcoming first)
- Includes full user profile for better context
- Supports filtering by `all`, `pending`, `approved`, and `rejected`

### Doctor API: Approve or Reject Assigned Consultancy

**Endpoint:**
- `PATCH /api/consultancy/doctor/respond-assignment`
- Protected route (doctor auth required)

Doctor can respond only to consultancies assigned to them.

**Request Body (Approve):**

```json
{
  "consultancyId": "BOOKING_ID",
  "decision": "approved"
}
```

**Request Body (Reject):**

```json
{
  "consultancyId": "BOOKING_ID",
  "decision": "rejected",
  "rejectionReason": "Not available in this slot"
}
```

**Success Response:**

```json
{
  "success": true,
  "message": "Consultancy rejected successfully",
  "booking": {
    "_id": "BOOKING_ID",
    "doctorAssignmentStatus": "rejected",
    "doctorRespondedAt": "2026-05-10T15:10:00.000Z",
    "doctorRejectionReason": "Not available in this slot"
  }
}
```

**Important:** Rejected consultancies are returned by `GET /api/consultancy/admin/unassigned` so admin can reassign a new doctor.

**Note:** `assignmentStatus=all` shows all doctor-assigned consultancies, including rejected ones.

---

## Complete User Journey

```
1. USER BOOKS
   ├─ User calls: POST /api/consultancy/create-order
   ├─ Razorpay checkout opens
   ├─ User pays
   └─ User calls: POST /api/consultancy/verify-payment
   
2. ADMIN MANAGES
   ├─ Admin calls: GET /api/consultancy/admin/getAll
  ├─ Admin calls: GET /api/consultancy/admin/unassigned
   ├─ Admin calls: PATCH /api/consultancy/admin/assign-doctor
  └─ Doctor assignment status becomes pending
   
3. DOCTOR SERVES
   ├─ Doctor calls: GET /api/consultancy/doctor/my-consultancies
  ├─ Doctor calls: PATCH /api/consultancy/doctor/respond-assignment
  ├─ If approved: consultancy moves forward with doctor
  └─ If rejected: consultancy appears again in admin unassigned list for reassignment
```

---

## Field Descriptions

### Consultancy Booking Fields

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Unique booking ID |
| `userId` | ObjectId | Reference to User |
| `doctorId` | ObjectId | Reference to Doctor (null if not yet assigned) |
| `doctorAssignmentStatus` | String | `unassigned`, `pending`, `approved`, or `rejected` |
| `doctorRespondedAt` | Date | Timestamp when doctor approved/rejected |
| `doctorRejectionReason` | String | Doctor's rejection reason (when status is `rejected`) |
| `consultationDate` | Date | Date of consultation (YYYY-MM-DD) |
| `timeSlot` | String | Time slot string (example: "10:00 AM - 10:30 AM") |
| `consultationLanguage` | String | Preferred consultation language (example: "Hindi", "English") |
| `monitorId` | String | Monitor/device ID linked to the booking |
| `memberId` | ObjectId | Optional family member reference |
| `memberName` | String | Family member name fallback |
| `memberRelation` | String | Family member relation fallback |
| `amount` | Number | Booking amount in rupees |
| `paymentStatus` | String | "pending", "paid", or "failed" |
| `bookingStatus` | String | "pending", "booked", or "cancelled" |
| `doctorAssignedAt` | Date | Timestamp when doctor was assigned |
| `notes` | String | User's consultation notes |

---

## Environment Variables Required

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `JWT_SECRET` (for user tokens)
- `JWT_ADMIN_SECRET` (for admin tokens)
- `JWT_DOCTOR_SECRET` (for doctor tokens)

---

## Frontend Integration Example (User Side)

```javascript
async function bookConsultancy(token, payload) {
  // 1) Create order from backend
  const orderRes = await fetch('/api/consultancy/create-order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const orderData = await orderRes.json();
  if (!orderData.success) throw new Error(orderData.message || 'Create order failed');

  const options = {
    key: orderData.key,
    amount: orderData.order.amount,
    currency: orderData.order.currency,
    name: 'ECG Consultancy',
    description: 'Consultancy Booking',
    order_id: orderData.order.id,
    prefill: {
      name: payload.full_name,
      email: payload.email,
      contact: payload.phoneNumber,
    },
    handler: async function (response) {
      // 2) Verify payment and confirm booking in backend
      const verifyRes = await fetch('/api/consultancy/verify-payment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          bookingId: orderData.booking._id,
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        }),
      });

      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        throw new Error(verifyData.message || 'Payment verification failed');
      }

      console.log('Booking confirmed', verifyData.booking);
      alert('Your consultancy has been booked successfully!');
    },
  };

  const rzp = new window.Razorpay(options);
  rzp.open();
}
```

---

## Notes

- **Date format:** YYYY-MM-DD
- **Time slot:** Any text (admin and doctor see exactly what user entered)
- **Amount:** In rupees (backend converts to paise automatically)
- **Doctor assignment:** Only possible after payment is verified and booking is confirmed
- **Plan validation:** Consultancy booking is allowed only while the active plan has remaining consultancy quota
- **Reassignment:** If doctor rejects, that consultancy appears in unassigned list and admin can assign another doctor
- **Notifications:** User receives notification when booking is confirmed
