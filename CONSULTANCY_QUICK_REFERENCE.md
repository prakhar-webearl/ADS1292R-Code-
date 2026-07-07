# Consultancy Booking Flow - Quick Reference

## 3-Step User Journey

### 1️⃣ User Booking (Payment)
**POST** `/api/consultancy/create-order`  
User enters date, time slot, and personal details → Razorpay order created  
**Then:** User completes payment  
**Then:** **POST** `/api/consultancy/verify-payment` → Booking confirmed ✅

### 2️⃣ Admin Doctor Assignment  
**GET** `/api/consultancy/admin/getAll` → Admin sees all pending bookings  
**GET** `/api/consultancy/admin/unassigned?page=1&limit=10&assignmentStatus=rejected` → View unassigned or rejected bookings  
**PATCH** `/api/consultancy/admin/assign-doctor` → Admin assigns doctor 👨‍⚕️

### 3️⃣ Doctor Consultation  
**GET** `/api/consultancy/doctor/my-consultancies?assignmentStatus=approved` → Doctor sees approved consultancies 📋
**GET** `/api/consultancy/doctor/my-consultancies?assignmentStatus=rejected` → Doctor sees rejected consultancies 📋
**GET** `/api/consultancy/doctor/my-consultancies?assignmentStatus=all` → Doctor sees all consultancies 📋

---

## API Endpoints Quick Reference

| Role | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| **User** | POST | `/api/consultancy/create-order` | Create Razorpay order |
| **User** | POST | `/api/consultancy/verify-payment` | Confirm booking after payment |
| **User** | GET | `/api/consultancy/my-bookings` | View user's own bookings |
| **Admin** | GET | `/api/consultancy/admin/getAll` | View ALL bookings |
| **Admin** | GET | `/api/consultancy/admin/unassigned` | View unassigned/rejected bookings with pagination |
| **Admin** | PATCH | `/api/consultancy/admin/assign-doctor` | Assign doctor to consultancy |
| **Admin** | GET | `/api/doctor/admin/active-approved` | Get active & approved doctors |
| **Doctor** | GET | `/api/consultancy/doctor/my-consultancies` | View consultancies with status filter |

---

## Key Status Fields

```javascript
{
  paymentStatus: "pending" | "paid" | "failed",
  bookingStatus: "pending" | "booked" | "cancelled",
  doctorId: null, // null = not assigned, ObjectId = assigned
  doctorAssignedAt: null // timestamp when doctor was assigned
}
```

- ✅ **Booking confirmed** = `paymentStatus: "paid"` AND `bookingStatus: "booked"`
- ✅ **Doctor assigned** = `doctorId` has value AND `doctorAssignedAt` has timestamp

---

## Middleware Protection

- **User routes:** `protect` middleware (JWT_SECRET)
- **Admin routes:** `AppAdminprotect` middleware (JWT_ADMIN_SECRET)
- **Doctor routes:** `protectDoctor` middleware (JWT_DOCTOR_SECRET)

---

## Data Population

**Admin sees:**
- User: `full_name, email, phoneNumber, status`
- Doctor: `full_name, email, specialization` (null if not assigned)

**Doctor sees:**
- User: `full_name, email, phoneNumber, dob, gender, weight, height`

---

## Files Modified/Created

✅ **models/consultancyModel.js**
- Added `doctorId` field (ref to Doctor, default: null)
- Added `doctorAssignedAt` field (Date, default: null)
- Added index on `doctorId` for efficient queries

✅ **controllers/consultancy.Controller.js**
- Added `assignDoctorToConsultancy()` → Admin assigns doctor
- Added `getDoctorConsultancies()` → Doctor lists assigned consultancies
- Fixed `getAllConsultancyBookingsForAdmin()` to populate doctor details

✅ **routes/consultancy.routes.js**
- Fixed: Added missing `AppAdminprotect` to GET `/admin/getAll`
- Added: `PATCH /admin/assign-doctor` endpoint
- Added: `GET /doctor/my-consultancies` endpoint

✅ **CONSULTANCY_COMPLETE_WORKFLOW.md** (NEW)
- Full documentation with all 3 workflows
- Request/response examples for all 6 endpoints
- Frontend integration code samples

✅ **README.md**
- Added Consultancy APIs to documentation file list

---

## Testing Examples

### 1. User Books
```bash
curl -X POST http://localhost:3000/api/consultancy/create-order \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer USER_TOKEN" \
  -d '{
    "consultationDate": "2026-05-15",
    "timeSlot": "10:00 AM - 10:30 AM",
    "amount": 499,
    "currency": "INR",
    "full_name": "Rahul Sharma",
    "email": "rahul@example.com",
    "phoneNumber": "9876543210"
  }'
```

### 2. Verify Payment
```bash
curl -X POST http://localhost:3000/api/consultancy/verify-payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer USER_TOKEN" \
  -d '{
    "bookingId": "BOOKING_ID",
    "razorpay_order_id": "order_xxxxx",
    "razorpay_payment_id": "pay_xxxxx",
    "razorpay_signature": "signature_xxxxx"
  }'
```

### 3. Admin Assigns Doctor
```bash
curl -X PATCH http://localhost:3000/api/consultancy/admin/assign-doctor \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{
    "consultancyId": "BOOKING_ID",
    "doctorId": "DOCTOR_ID"
  }'
```

### 4. Doctor Views Consultancies
```bash
curl http://localhost:3000/api/consultancy/doctor/my-consultancies \
  -H "Authorization: Bearer DOCTOR_TOKEN"
```

Filter examples:

```bash
curl "http://localhost:3000/api/consultancy/doctor/my-consultancies?assignmentStatus=approved" \
  -H "Authorization: Bearer DOCTOR_TOKEN"
```

```bash
curl "http://localhost:3000/api/consultancy/doctor/my-consultancies?assignmentStatus=rejected" \
  -H "Authorization: Bearer DOCTOR_TOKEN"
```

### 5. Admin Gets Unassigned Consultancies
```bash
curl "http://localhost:3000/api/consultancy/admin/unassigned?page=1&limit=10&assignmentStatus=rejected" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

This response now includes `totalRejectedCount` so admin panels can show how many rejected consultancies need reassignment.

### 6. Admin Gets Active Approved Doctors (for selection)
```bash
curl http://localhost:3000/api/doctor/admin/active-approved?page=1&limit=10 \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

---

## Complete Data Model

```javascript
{
  _id: ObjectId,
  
  // User Info
  userId: ObjectId (ref: User),
  full_name: String,
  email: String,
  phoneNumber: String,
  
  // Consultation Details
  consultationDate: Date,
  timeSlot: String,
  notes: String,
  
  // Payment Info
  amount: Number,
  currency: String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  razorpaySignature: String,
  paymentStatus: "pending" | "paid" | "failed",
  orderExpiresAt: Date,
  
  // Booking Status
  bookingStatus: "pending" | "booked" | "cancelled",
  bookedAt: Date,
  
  // Doctor Assignment (NEW)
  doctorId: ObjectId (ref: Doctor) | null,
  doctorAssignedAt: Date | null,
  
  // Timestamps
  createdAt: Date,
  updatedAt: Date
}
```

---

## Notes

- All dates are stored in UTC with IST timezone offset in schema
- Doctor assignment only works on "paid" + "booked" bookings
- Time slot accepts any string format (no predefined slots)
- Doctor sees full user profile for consultation preparation
- All protected routes require valid JWT token in Authorization header

