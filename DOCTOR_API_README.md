# Doctor API README

This guide explains how to use the doctor APIs from a frontend app, including request payloads, authentication, responses, and common flows.

## Base URL

- Local: `http://localhost:9000`
- Production: use your deployed backend URL

## Auth Rules

- Doctor login returns a JWT token.
- Send protected requests with:

```http
Authorization: Bearer YOUR_DOCTOR_TOKEN
Content-Type: application/json
```

- Admin approval endpoints require the admin token.
- Public blog list only returns approved blogs.

## Main Flows

1. Doctor registers
2. Admin approves doctor
3. Doctor logs in
4. Doctor updates profile or changes password
5. Doctor uses OTP flow for forgot password
6. Doctor writes blog
7. Admin approves blog
8. Approved blogs show in blog list

---

## 1. Doctor Register

**Endpoint:** `POST /api/doctor/register`

Use this when a doctor signs up from the frontend.

### Payload

```json
{
  "full_name": "Dr. Raj Sharma",
  "email": "doctor@example.com",
  "phoneNumber": "9876543210",
  "password": "Doctor@123",
  "specialization": "Cardiologist",
  "experienceYears": 8,
  "qualification": "MBBS, MD",
  "clinicAddress": "Ahmedabad, Gujarat",
  "bio": "Cardiac specialist with 8 years of experience"
}
```

### Success Response

```json
{
  "success": true,
  "message": "Doctor registered successfully. Waiting for admin approval.",
  "doctor": {
    "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
    "full_name": "Dr. Raj Sharma",
    "email": "doctor@example.com",
    "phoneNumber": "9876543210",
    "specialization": "Cardiologist",
    "experienceYears": 8,
    "qualification": "MBBS, MD",
    "clinicAddress": "Ahmedabad, Gujarat",
    "bio": "Cardiac specialist with 8 years of experience",
    "status": "active",
    "approvalStatus": "pending",
    "approvedAt": null,
    "rejectionReason": "",
    "createdAt": "2026-04-21T10:00:00.000Z",
    "updatedAt": "2026-04-21T10:00:00.000Z"
  }
}
```

### Frontend Example

```javascript
const registerDoctor = async () => {
  const response = await fetch("http://localhost:3000/api/doctor/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      full_name: "Dr. Raj Sharma",
      email: "doctor@example.com",
      phoneNumber: "9876543210",
      password: "Doctor@123",
      specialization: "Cardiologist",
      experienceYears: 8,
      qualification: "MBBS, MD",
      clinicAddress: "Ahmedabad, Gujarat",
      bio: "Cardiac specialist with 8 years of experience",
    }),
  });

  return response.json();
};
```

---

## 2. Doctor Login

**Endpoint:** `POST /api/doctor/login`

Login uses `phoneNumber` only.

### Payload

```json
{
  "phoneNumber": "9876543210",
  "password": "Doctor@123"
}
```

### Success Response

```json
{
  "success": true,
  "message": "Doctor login successful",
  "token": "jwt_token_here",
  "doctor": {
    "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
    "full_name": "Dr. Raj Sharma",
    "email": "doctor@example.com",
    "phoneNumber": "9876543210",
    "specialization": "Cardiologist",
    "experienceYears": 8,
    "qualification": "MBBS, MD",
    "clinicAddress": "Ahmedabad, Gujarat",
    "bio": "Cardiac specialist with 8 years of experience",
    "status": "active",
    "approvalStatus": "approved",
    "approvedAt": "2026-04-21T10:10:00.000Z",
    "rejectionReason": "",
    "createdAt": "2026-04-21T10:00:00.000Z",
    "updatedAt": "2026-04-21T10:10:00.000Z"
  }
}
```

### Approval Rules

- If the doctor is not approved yet, login returns `403`.
- If the doctor is blocked, login returns `403`.

### Frontend Example

```javascript
const loginDoctor = async (credentials) => {
  const response = await fetch("http://localhost:3000/api/doctor/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(credentials),
  });

  return response.json();
};
```

---

## 3. Get Doctor Profile

**Endpoint:** `GET /api/doctor/profile`

**Auth:** required

### Response

```json
{
  "success": true,
  "doctor": {
    "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
    "full_name": "Dr. Raj Sharma",
    "email": "doctor@example.com",
    "phoneNumber": "9876543210",
    "specialization": "Cardiologist",
    "experienceYears": 8,
    "qualification": "MBBS, MD",
    "clinicAddress": "Ahmedabad, Gujarat",
    "bio": "Cardiac specialist with 8 years of experience",
    "status": "active",
    "approvalStatus": "approved",
    "approvedAt": "2026-04-21T10:10:00.000Z",
    "rejectionReason": "",
    "createdAt": "2026-04-21T10:00:00.000Z",
    "updatedAt": "2026-04-21T10:10:00.000Z"
  }
}
```

### Frontend Example

```javascript
const fetchDoctorProfile = async (token) => {
  const response = await fetch("http://localhost:3000/api/doctor/profile", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.json();
};
```

---

## 4. Update Doctor Profile

**Endpoint:** `PUT /api/doctor/profile`

**Auth:** required

### Payload

Send only fields you want to update.

```json
{
  "full_name": "Dr. Raj Sharma",
  "specialization": "Cardiologist",
  "experienceYears": 9,
  "clinicAddress": "Surat, Gujarat",
  "bio": "Available for online consultation"
}
```

### Success Response

```json
{
  "success": true,
  "message": "Doctor profile updated successfully",
  "doctor": {
    "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
    "full_name": "Dr. Raj Sharma",
    "email": "doctor@example.com",
    "phoneNumber": "9876543210",
    "specialization": "Cardiologist",
    "experienceYears": 9,
    "qualification": "MBBS, MD",
    "clinicAddress": "Surat, Gujarat",
    "bio": "Available for online consultation",
    "status": "active",
    "approvalStatus": "approved",
    "approvedAt": "2026-04-21T10:10:00.000Z",
    "rejectionReason": "",
    "createdAt": "2026-04-21T10:00:00.000Z",
    "updatedAt": "2026-04-21T10:15:00.000Z"
  }
}
```

---

## 5. Change Password

**Endpoint:** `PUT /api/doctor/change-password`

**Auth:** required

### Payload

```json
{
  "oldPassword": "Doctor@123",
  "newPassword": "Doctor@456"
}
```

### Response

```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

### Frontend Example

```javascript
const changeDoctorPassword = async (token, payload) => {
  const response = await fetch("http://localhost:3000/api/doctor/change-password", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  return response.json();
};
```

---

## 6. Forgot Password With OTP

This flow uses the doctor mobile number.

### Step 1: Request OTP

**Endpoint:** `POST /api/doctor/forgot-password/request-otp`

#### Payload

```json
{
  "phoneNumber": "9876543210"
}
```

#### Response

```json
{
  "success": true,
  "message": "OTP sent successfully",
  "phoneNumber": "9876543210",
  "expiresAt": "2026-04-21T10:25:00.000Z",
  "otp": "123456"
}
```

Note: `otp` is included in the response so you can use it directly in the frontend flow.

### Step 2: Verify OTP

**Endpoint:** `POST /api/doctor/forgot-password/verify-otp`

#### Payload

```json
{
  "phoneNumber": "9876543210",
  "otp": "123456"
}
```

#### Response

```json
{
  "success": true,
  "message": "OTP verified successfully",
  "resetToken": "reset_token_here",
  "resetTokenExpiresAt": "2026-04-21T10:30:00.000Z"
}
```

### Step 3: Reset Password

**Endpoint:** `POST /api/doctor/forgot-password/reset`

#### Payload

```json
{
  "phoneNumber": "9876543210",
  "resetToken": "reset_token_here",
  "newPassword": "Doctor@789"
}
```

#### Response

```json
{
  "success": true,
  "message": "Password reset successfully"
}
```

### Frontend Example

```javascript
const requestOtp = async (phoneNumber) => {
  const response = await fetch("http://localhost:3000/api/doctor/forgot-password/request-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber }),
  });

  return response.json();
};

const verifyOtp = async (phoneNumber, otp) => {
  const response = await fetch("http://localhost:3000/api/doctor/forgot-password/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber, otp }),
  });

  return response.json();
};

const resetPassword = async (phoneNumber, resetToken, newPassword) => {
  const response = await fetch("http://localhost:3000/api/doctor/forgot-password/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber, resetToken, newPassword }),
  });

  return response.json();
};
```

---

## 7. Doctor Blog Flow

### Create Blog

**Endpoint:** `POST /api/doctor/blog/create`

**Auth:** required

**Content-Type:** `multipart/form-data`

#### Payload

Use form-data fields:

- `blog_title` (text)
- `description` (text)
- `read_time` (text)
- `photo` (file)

#### cURL Example

```bash
curl -X POST http://localhost:3000/api/doctor/blog/create \
  -H "Authorization: Bearer YOUR_DOCTOR_TOKEN" \
  -F "blog_title=How to Manage Blood Pressure" \
  -F "description=High blood pressure management starts with ..." \
  -F "read_time=4 min" \
  -F "photo=@/path/to/blog-image.jpg"
```

#### Response

```json
{
  "success": true,
  "message": "Blog created successfully and sent for admin approval",
  "blog": {
    "_id": "66f1b2c3d4e5f6a7b8c9d0e1",
    "doctorId": "66f1a1e2a2c3b4d5e6f7a8b9",
    "blog_title": "How to Manage Blood Pressure",
    "description": "High blood pressure management starts with ...",
    "read_time": "4 min",
    "photo": "https://ik.imagekit.io/your_path/blog-image.jpg",
    "approvalStatus": "pending",
    "approvedBy": null,
    "approvedAt": null,
    "rejectionReason": "",
    "createdAt": "2026-04-21T10:20:00.000Z",
    "updatedAt": "2026-04-21T10:20:00.000Z"
  }
}
```

### My Blogs

**Endpoint:** `GET /api/doctor/blog/my`

**Auth:** required

### Update Blog

**Endpoint:** `PUT /api/doctor/blog/update/:id`

**Auth:** required

**Content-Type:** `multipart/form-data`

Use form-data and send only fields you want to update.

- `blog_title` (optional text)
- `description` (optional text)
- `read_time` (optional text)
- `photo` (optional file)

If doctor updates a blog, it automatically goes back to `pending` for admin review.

#### cURL Example

```bash
curl -X PUT http://localhost:3000/api/doctor/blog/update/BLOG_ID \
  -H "Authorization: Bearer YOUR_DOCTOR_TOKEN" \
  -F "blog_title=Updated Heart Health Tips" \
  -F "description=Updated description" \
  -F "read_time=5 min" \
  -F "photo=@/path/to/new-image.jpg"
```

### Delete Blog

**Endpoint:** `DELETE /api/doctor/blog/delete/:id`

**Auth:** required

Doctor can delete only their own blog.

#### cURL Example

```bash
curl -X DELETE http://localhost:3000/api/doctor/blog/delete/BLOG_ID \
  -H "Authorization: Bearer YOUR_DOCTOR_TOKEN"
```

#### Response

```json
{
  "success": true,
  "message": "Blog deleted successfully"
}
```

### Approved Blog List for Frontend

**Endpoint:** `GET /api/doctor/blog/list`

This returns only approved blogs and is safe to show in the app.

### Blog Details

**Endpoint:** `GET /api/doctor/blog/:id`

This only returns approved blogs.

### Frontend Example

```javascript
const createDoctorBlog = async (token, formData) => {
  const response = await fetch("http://localhost:3000/api/doctor/blog/create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  return response.json();
};

const updateDoctorBlog = async (token, blogId, formData) => {
  const response = await fetch(`http://localhost:3000/api/doctor/blog/update/${blogId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  return response.json();
};

const deleteDoctorBlog = async (token, blogId) => {
  const response = await fetch(`http://localhost:3000/api/doctor/blog/delete/${blogId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.json();
};
```

---

## 8. Admin Approval APIs

These routes are only for the admin panel.

### Get Doctor List With Pagination, Filter, and Search

**Endpoint:** `GET /api/doctor/admin/list`

**Auth:** required

Use this route to build the admin doctor list screen.

#### Query Parameters

- `page` optional, default `1`
- `limit` optional, default `10`
- `search` optional, searches `full_name`, `email`, `phoneNumber`, `specialization`, `qualification`, and `clinicAddress`
- `status` optional, values: `active`, `blocked`
- `approvalStatus` optional, values: `pending`, `approved`, `rejected`
- `specialization` optional, partial match

#### Example Request

```bash
curl "http://localhost:3000/api/doctor/admin/list?page=1&limit=10&search=raj&status=active&approvalStatus=approved" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

#### Success Response

```json
{
  "success": true,
  "page": 1,
  "limit": 10,
  "totalDoctors": 25,
  "totalPages": 3,
  "doctors": [
    {
      "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
      "full_name": "Dr. Raj Sharma",
      "email": "doctor@example.com",
      "phoneNumber": "9876543210",
      "specialization": "Cardiologist",
      "experienceYears": 8,
      "qualification": "MBBS, MD",
      "clinicAddress": "Ahmedabad, Gujarat",
      "bio": "Cardiac specialist with 8 years of experience",
      "status": "active",
      "approvalStatus": "approved",
      "approvedBy": "66f1c3d4e5f6a7b8c9d0e1f2",
      "approvedAt": "2026-04-21T10:10:00.000Z",
      "rejectionReason": "",
      "createdAt": "2026-04-21T10:00:00.000Z",
      "updatedAt": "2026-04-21T10:10:00.000Z"
    }
  ]
}
```

### View Doctor Profile

**Endpoint:** `GET /api/doctor/admin/:id`

**Auth:** required

This returns one doctor profile plus all blogs written by that doctor.

#### Success Response

```json
{
  "success": true,
  "doctor": {
    "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
    "full_name": "Dr. Raj Sharma",
    "email": "doctor@example.com",
    "phoneNumber": "9876543210",
    "specialization": "Cardiologist",
    "experienceYears": 8,
    "qualification": "MBBS, MD",
    "clinicAddress": "Ahmedabad, Gujarat",
    "bio": "Cardiac specialist with 8 years of experience",
    "status": "active",
    "approvalStatus": "approved",
    "blogs": []
  }
}
```

### Update Doctor Status

**Endpoint:** `PATCH /api/doctor/admin/:id/status`

**Auth:** required

Use this to block or activate a doctor.

#### Payload

```json
{
  "status": "blocked"
}
```

or

```json
{
  "status": "active"
}
```

#### Response

```json
{
  "success": true,
  "message": "Doctor status updated successfully",
  "doctor": {
    "_id": "66f1a1e2a2c3b4d5e6f7a8b9",
    "status": "blocked"
  }
}
```

### Get Pending Doctors

**Endpoint:** `GET /api/doctor/admin/pending`

### Approve / Reject Doctor

**Endpoint:** `PATCH /api/doctor/admin/:id/approval`

#### Payload

```json
{
  "approvalStatus": "approved"
}
```

or

```json
{
  "approvalStatus": "rejected",
  "rejectionReason": "Incomplete credentials"
}
```

### Get Pending Blogs

**Endpoint:** `GET /api/doctor/admin/blog/pending`

### Get Blog List With Pagination, Filter, and Search

**Endpoint:** `GET /api/doctor/admin/blog/list`

**Auth:** required

#### Query Parameters

- `page` optional, default `1`
- `limit` optional, default `10`
- `search` optional, searches `blog_title`, `description`, and `read_time`
- `approvalStatus` optional, values: `pending`, `approved`, `rejected`
- `doctorId` optional, filter by doctor

#### Example Request

```bash
curl "http://localhost:3000/api/doctor/admin/blog/list?page=1&limit=10&search=pressure&approvalStatus=pending" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

#### Success Response

```json
{
  "success": true,
  "page": 1,
  "limit": 10,
  "totalBlogs": 4,
  "totalPages": 1,
  "blogs": []
}
```

### Approve / Reject Blog

**Endpoint:** `PATCH /api/doctor/admin/blog/:id/approval`

#### Payload

```json
{
  "approvalStatus": "approved"
}
```

---

## 9. Common Status Codes

- `200` success
- `201` created
- `400` validation error
- `401` unauthorized
- `403` forbidden
- `404` not found
- `500` server error

## 10. Frontend Usage Pattern

Typical frontend flow:

1. Register doctor
2. Show message: waiting for admin approval
3. Admin approves doctor in admin panel
4. Doctor logs in and token is stored
5. Use token for profile and blog APIs
6. Use OTP flow when password is forgotten

### Example Axios Setup

```javascript
import axios from "axios";

const api = axios.create({
  baseURL: "http://localhost:3000/api/doctor",
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("doctorToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

If you want, I can also add a Postman collection style document for these endpoints.
