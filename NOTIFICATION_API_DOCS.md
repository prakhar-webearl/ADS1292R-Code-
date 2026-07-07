# Notification API Docs

This document explains how to use the Notification APIs.

## Base URL

- Production: `https://api-for-ecg.onrender.com`
- Local: `http://localhost:3000`

All notification routes are mounted under:

- `/api/notification`

## Notification Data Model

- `title` (String, required)
- `notification` (String, required)
- `details` (String, optional, default: empty string)
- `targetUserId` (String, required, notification visible only to this user/member)
- `createdAt` and `updatedAt` are auto-managed by MongoDB timestamps.

Notifications are created by the backend for user-specific events such as ECG session start, blog publish, consultancy booking, and report generation.

## Authentication

No authentication is required for create, getAll, getById, and update routes.
Admin JWT token is required only for delete route.

Header format:

```http
Authorization: Bearer YOUR_ADMIN_TOKEN
```

## Endpoints

### Quick Endpoint List

- `POST /api/notification/create/:userId`
- `GET /api/notification/getAll?userId=USER_ID`
- `GET /api/notification/getById/:id?userId=USER_ID`
- `PUT /api/notification/update/:id`
- `DELETE /api/notification/delete/:id`

### 1) Create Notification For User

- Method: `POST`
- URL: `/api/notification/create/:userId`
- Auth: Not required

Request body:

```json
{
  "title": "ECG Alert",
  "notification": "Abnormal heartbeat detected",
  "details": "Please consult doctor immediately."
}
```

cURL example:

```bash
curl -X POST http://localhost:3000/api/notification/create/6618e2f0f26b5f03fdb1abcd \
  -H "Content-Type: application/json" \
  -d '{
    "title": "ECG Alert",
    "notification": "Abnormal heartbeat detected",
    "details": "Please consult doctor immediately."
  }'
```

Success response (201):

```json
{
  "success": true,
  "message": "Notification created successfully",
  "notification": {
    "_id": "6618e2f0f26b5f03fdb1abcd",
    "title": "ECG Alert",
    "notification": "Abnormal heartbeat detected",
    "details": "Please consult doctor immediately.",
    "targetUserId": "66a1c2f0f26b5f03fdb1abcd",
    "createdAt": "2026-04-13T10:00:00.000Z",
    "updatedAt": "2026-04-13T10:00:00.000Z"
  }
}
```

### 2) Get All Notifications (Public)

- Method: `GET`
- URL: `/api/notification/getAll?userId=USER_ID`
- Auth: Not required

cURL example:

```bash
curl "http://localhost:3000/api/notification/getAll?userId=USER_OR_MEMBER_ID"
```

Success response (200):

```json
{
  "success": true,
  "message": "Notifications fetched successfully",
  "totalNotifications": 2,
  "notifications": [
    {
      "_id": "6618e2f0f26b5f03fdb1abcd",
      "title": "ECG Alert",
      "notification": "Abnormal heartbeat detected",
      "details": "Please consult doctor immediately.",
      "targetUserId": "66a1c2f0f26b5f03fdb1abcd",
      "createdAt": "2026-04-13T10:00:00.000Z",
      "updatedAt": "2026-04-13T10:00:00.000Z"
    }
  ]
}
```

### 3) Get Notification By ID (Public)

- Method: `GET`
- URL: `/api/notification/getById/:id?userId=USER_ID`
- Auth: Not required

cURL example:

```bash
curl "http://localhost:3000/api/notification/getById/6618e2f0f26b5f03fdb1abcd?userId=USER_OR_MEMBER_ID"
```

Success response (200):

```json
{
  "success": true,
  "message": "Notification fetched successfully",
  "notification": {
    "_id": "6618e2f0f26b5f03fdb1abcd",
    "title": "ECG Alert",
    "notification": "Abnormal heartbeat detected",
    "details": "Please consult doctor immediately.",
    "targetUserId": "66a1c2f0f26b5f03fdb1abcd",
    "createdAt": "2026-04-13T10:00:00.000Z",
    "updatedAt": "2026-04-13T10:00:00.000Z"
  }
}
```

Invalid ID response (400):

```json
{
  "success": false,
  "message": "Invalid notification id"
}
```

### 4) Update Notification

- Method: `PUT`
- URL: `/api/notification/update/:id`
- Auth: Not required

Note: Update API is available and requires `targetUserId` in request body.

Request body:

```json
{
  "title": "Updated ECG Alert",
  "notification": "High-risk abnormality detected",
  "details": "Open app and contact doctor now.",
  "targetUserId": "USER_OR_MEMBER_ID"
}
```

cURL example:

```bash
curl -X PUT http://localhost:3000/api/notification/update/6618e2f0f26b5f03fdb1abcd \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated ECG Alert",
    "notification": "High-risk abnormality detected",
    "details": "Open app and contact doctor now.",
    "targetUserId": "USER_OR_MEMBER_ID"
  }'
```

Success response (200):

```json
{
  "success": true,
  "message": "Notification updated successfully",
  "notification": {
    "_id": "6618e2f0f26b5f03fdb1abcd",
    "title": "Updated ECG Alert",
    "notification": "High-risk abnormality detected",
    "details": "Open app and contact doctor now.",
    "createdAt": "2026-04-13T10:00:00.000Z",
    "updatedAt": "2026-04-13T10:30:00.000Z"
  }
}
```

### 5) Delete Notification (Admin)

- Method: `DELETE`
- URL: `/api/notification/delete/:id`
- Auth: Required (Admin)

cURL example:

```bash
curl -X DELETE http://localhost:3000/api/notification/delete/6618e2f0f26b5f03fdb1abcd \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Success response (200):

```json
{
  "success": true,
  "message": "Notification deleted successfully"
}
```

## Error Notes

Common errors:

- `400`: Required fields missing (`title` or `notification`) or invalid MongoDB ID.
- `401`: Missing/invalid admin token for delete route.
- `404`: Notification not found.
- `500`: Internal server error.

## Live Notification (Socket.IO)

When a new notification is created, server sends the socket event only to the target user room.

- Event name: `notification:new`

Payload example:

```json
{
  "success": true,
  "message": "New notification posted",
  "notification": {
    "_id": "6618e2f0f26b5f03fdb1abcd",
    "title": "ECG Alert",
    "notification": "Abnormal heartbeat detected",
    "details": "Please consult doctor immediately.",
    "targetUserId": "66a1c2f0f26b5f03fdb1abcd",
    "targetUserId": "66a1c2f0f26b5f03fdb1abcd",
    "createdAt": "2026-04-13T10:00:00.000Z",
    "updatedAt": "2026-04-13T10:00:00.000Z"
  }
}
```

Client example:

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000");

socket.emit("notification:subscribe", { userId: "USER_OR_MEMBER_ID" });

socket.on("notification:new", (payload) => {
  console.log("Live notification received:", payload);
});
```
