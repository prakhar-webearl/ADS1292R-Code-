# ECG API - Mac Quick Start

Node.js + Express backend for ECG ingest, live streaming, user auth, WiFi config, and abnormality tracking.

## Base URL

- Production: https://api-for-ecg.onrender.com
- Local: http://localhost:3000

## API Documentation Files

- Admin APIs: `ADMIN_API_DOCS.md`
- General APIs: `API_DOCS.md`
- Abnormality APIs: `ABNORMALITY_API_DOCS.md`
- Doctor APIs: `DOCTOR_API_README.md`
- Doctor Selection APIs: `DOCTOR_SELECTION_API_README.md`
- Consultancy APIs: `CONSULTANCY_COMPLETE_WORKFLOW.md`
- Admin Doctor Assignment Guide: `ADMIN_DOCTOR_ASSIGNMENT_GUIDE.md`
- FAQ APIs: `FAQ_API_DOCS.md`
- Notification APIs: `NOTIFICATION_API_DOCS.md`

## 1. Run Locally on Mac

### Prerequisites

- Node.js 18+ (`node -v`)
- npm (`npm -v`)
- MongoDB connection string (local or Atlas)

### Install and start

```bash
git clone https://github.com/sindhav88/api-for-ECG.git
cd api-for-ECG
npm install
```

Create `.env` in project root:

```env
PORT=3000
MONGO_URL=mongodb://127.0.0.1:27017/ecg
JWT_SECRET=replace_with_strong_secret
JWT_ADMIN_SECRET=replace_with_strong_admin_secret
RAZORPAY_KEY_ID=replace_with_razorpay_key_id
RAZORPAY_KEY_SECRET=replace_with_razorpay_key_secret
```

Run server:

```bash
npm run dev
```

or

```bash
npm start
```

Health check:

```bash
curl http://localhost:3000/
```

Expected response: `Hello World!`

## 2. First API Flow (User Auth)

All user routes are mounted under `/api/user`.

### Sign up

```bash
curl -X POST http://localhost:3000/api/user/signup \
  -H "Content-Type: application/json" \
  -d '{
    "full_name":"Test User",
    "email":"test@example.com",
    "phoneNumber":"9876543210",
    "dob":"1995-01-01",
    "gender":"Male",
    "weight":70,
    "height":175,
    "password":"Test@123"
  }'
```

### Sign in (get JWT token)

```bash
curl -X POST http://localhost:3000/api/user/signin \
  -H "Content-Type: application/json" \
  -d '{
    "email":"test@example.com",
    "password":"Test@123"
  }'
```

Copy `token` from response.

### Get profile (protected route)

```bash
curl http://localhost:3000/api/user/getprofile \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Update profile (protected route)

```bash
curl -X PUT http://localhost:3000/api/user/updateprofile \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "age": 30,
    "gender": "Male",
    "weight": 72,
    "height": 175
  }'
```

### Change password (protected route)

```bash
curl -X PUT http://localhost:3000/api/user/changepassword \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "oldPassword":"Test@123",
    "newPassword":"NewPass@123"
  }'
```

### Forgot password (public route)

```bash
curl -X POST http://localhost:3000/api/user/forgotPassword \
  -H "Content-Type: application/json" \
  -d '{
    "email":"test@example.com",
    "newPassword":"Reset@123"
  }'
```

## 3. ECG Endpoints

### Send ECG chunk

`POST /api/ecg`

```bash
curl -X POST http://localhost:3000/api/ecg \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId":"ESP_ECG_123",
    "seq":1205,
    "sr":360,
    "lo":false,
    "data":[512,514,516]
  }'
```

### Get ECG data by device

`GET /api/ecg/:deviceId?limit=10`

```bash
curl "http://localhost:3000/api/ecg/ESP_ECG_123?limit=10"
```

### Live ECG stream (SSE)

`GET /api/ecg/live/:deviceId`

```bash
curl -N http://localhost:3000/api/ecg/live/ESP_ECG_123
```

### Update device result

`PUT /api/ecg/device_result`

```bash
curl -X PUT http://localhost:3000/api/ecg/device_result \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId":"ESP_ECG_123",
    "seq":1205,
    "recordId":"67f2c9f17a4c3f7f00abc123",
    "device_result":"Sinus Tachycardia | 90% | 115 bpm"
  }'
```

## 4. Abnormality Endpoints

### Store abnormality

`POST /api/abnormality`

### Get today

`GET /api/abnormality/user/:userId`

### Get by date

`GET /api/abnormality/user/:userId/date/:YYYY-MM-DD`

### Get date range

`GET /api/abnormality/user/:userId/range?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

### Get critical only

`GET /api/abnormality/user/:userId/critical`

### Delete by date

`DELETE /api/abnormality/user/:userId/date/:YYYY-MM-DD`

Notes:

- `severity` allowed values: `CRITICAL`, `WARNING`, `INFO`
- Use a valid MongoDB `userId`

## 5. WiFi Config Endpoints

Mounted under `/api/wifi-config`:

- `POST /api/wifi-config` save/update credentials
- `GET /api/wifi-config/user/:userId` get all for user
- `GET /api/wifi-config/device/:deviceId` get by device
- `DELETE /api/wifi-config/user/:userId/device/:deviceId` delete one

## 6. Protected Content Routes

After login, token is required for these user-scoped routes:

- `GET /api/user/plan/getallplans`
- `GET /api/user/plan/getplan/:id`
- `POST /api/user/plan/create-order` (Razorpay order creation)
- `POST /api/user/plan/verify-payment` (Razorpay signature verify)
- `GET /api/user/plan/my-purchases`
- `GET /api/user/plan/current`

Direct plan module routes are also available:

- User: `/api/plan/user/*`
- Admin: `/api/plan/admin/*`

Quick test:

```bash
curl http://localhost:3000/api/user/plan/getallplans \
  -H "Authorization: Bearer YOUR_TOKEN"
```

For full request/response examples, see `PLAN_PURCHASE_API_README.md`.

## 7. Consultancy + Doctor Video Call Flow

This is the complete user journey for consultancy after the ECG report is created.

### How it works

1. The user books a consultancy with `POST /api/consultancy/create-order`.
2. The backend checks the user’s active plan and consultancy quota.
3. If quota is available, the consultancy is created immediately as a free booking.
4. If quota is exhausted and `payIfNoFree=true` is sent, the backend creates a Razorpay order for a one-off paid booking.
5. After payment confirmation, the consultancy becomes booked and available for admin doctor assignment.
6. Admin assigns a doctor to the consultancy.
7. Doctor initiates the video call for that consultancy.
8. User and doctor join the call room using the same `roomId`.
9. The backend tracks the session timer using `consultationDurationMinutes` from the consultancy.
10. If the session ends or an extension is requested, the backend handles extension approval/rejection and updates the call status.

### Important concept

- `consultancyId` and `roomId` are linked.
- The video call room is created for the consultancy booking.
- The call duration is controlled by `consultationDurationMinutes`.
- Extension flow is available when the session is about to end.

### Video call endpoints

Mounted under:

`/api/video-call`

#### Doctor starts the call

`POST /api/video-call/initiate`

Request body:

```json
{
  "consultancyId": "CONSULTANCY_ID"
}
```

#### User/doctor check call status

`GET /api/video-call/:roomId`

Example:

```bash
curl http://localhost:3000/api/video-call/CONSULTANCY_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### Join/leave/update call events

`POST /api/video-call/event`

Example body:

```json
{
  "roomId": "CONSULTANCY_ID",
  "event": "join",
  "userId": "USER_ID",
  "userType": "User"
}
```

#### Complete the call

`POST /api/video-call/complete`

#### Request extension

`POST /api/video-call/request-extension`

#### Respond to extension

`POST /api/video-call/respond-extension`

### Session duration

The consultancy booking can send `consultationDurationMinutes`. The backend uses that value to start and sync the video-call timer. Example values can be `15`, `20`, `30`, or any valid minute value supported by your frontend flow.

### Practical flow summary

```text
Book consultancy -> pay if needed -> admin assigns doctor -> doctor initiates call -> user joins -> timer runs -> extension if needed -> call completes
```


## 7. FAQ API

FAQ content is managed by admins.

Admin routes:

- `POST /api/faq/create`
- `GET /api/faq/getById/:id`
- `PUT /api/faq/update/:id`
- `DELETE /api/faq/delete/:id`

Public route:

- `GET /api/faq/getAll`

See `FAQ_API_DOCS.md` for request and response examples.

## 8. Terms & Privacy Policy APIs

These APIs support HTML content storage for terms and privacy policy pages.

### Terms & Condition

Admin routes:

- `POST /api/termscondition/create`
- `GET /api/termscondition/getAll`
- `GET /api/termscondition/getById/:id`
- `PUT /api/termscondition/update/:id`
- `DELETE /api/termscondition/delete/:id`

Public route:

- `GET /api/termscondition/public`

### Privacy Policy

Admin routes:

- `POST /api/privacypolicy/create`
- `GET /api/privacypolicy/getAll`
- `GET /api/privacypolicy/getById/:id`
- `PUT /api/privacypolicy/update/:id`
- `DELETE /api/privacypolicy/delete/:id`

Public route:

- `   `

### Example HTML payload

```bash
curl -X POST http://localhost:3000/api/termscondition/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "title": "Terms & Conditions",
    "contentHtml": "<h1>Terms & Conditions</h1><p>Your HTML content here.</p>"
  }'
```

## 9. Notification API

Notifications are mounted under `/api/notification`.

Data fields:

- `title` (required)
- `notification` (required)
- `details` (optional)
- `targetUserId` (required, only this user can fetch/receive notification)

### Routes

Admin protected routes:

- `DELETE /api/notification/delete/:id`

Public routes:

- `POST /api/notification/create/:userId`
- `PUT /api/notification/update/:id`
- `GET /api/notification/getAll?userId=USER_ID`
- `GET /api/notification/getById/:id?userId=USER_ID`

### Create notification

```bash
curl -X POST http://localhost:3000/api/notification/create/USER_OR_MEMBER_ID \
  -H "Content-Type: application/json" \
  -d '{
    "title": "ECG Alert",
    "notification": "Abnormal heartbeat detected",
    "details": "Please consult doctor immediately."
  }'
```

### Get all notifications for a user

```bash
curl "http://localhost:3000/api/notification/getAll?userId=USER_OR_MEMBER_ID"
```

### Get notification by ID for a user

```bash
curl "http://localhost:3000/api/notification/getById/NOTIFICATION_ID?userId=USER_OR_MEMBER_ID"
```

### Update notification

```bash
curl -X PUT http://localhost:3000/api/notification/update/NOTIFICATION_ID \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated ECG Alert",
    "notification": "High-risk abnormality detected",
    "details": "Open app and contact doctor now.",
    "targetUserId": "USER_OR_MEMBER_ID"
  }'
```

### Delete notification (Admin)

```bash
curl -X DELETE http://localhost:3000/api/notification/delete/NOTIFICATION_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Live notification for only target user

Socket event name:

- `notification:new`

Subscribe flow from frontend:

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000");
socket.emit("notification:subscribe", { userId: "USER_OR_MEMBER_ID" });

socket.on("notification:new", (payload) => {
  console.log("User-scoped live notification:", payload);
});
```

## Troubleshooting (Mac)

- `Error: MONGO_URL missing`:
  - Check `.env` is in project root and has `MONGO_URL`.
- `Not authorized, invalid token`:
  - Ensure header format is exactly `Authorization: Bearer YOUR_TOKEN`.
- `EADDRINUSE: port 3000`:
  - Change `PORT` in `.env` or stop the existing process.

## Detailed Docs

- See `API_DOCS.md` for ECG examples.
- See `ABNORMALITY_API_DOCS.md` for abnormality details.
- See `FAQ_API_DOCS.md` for FAQ CRUD details.