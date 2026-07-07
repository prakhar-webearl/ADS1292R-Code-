# FAQ API Documentation

This document covers the FAQ management API used by admins to maintain the question-and-answer content shown in the app.

## Base URL

- Local: `http://localhost:3000`
- Production: `https://api-for-ecg.onrender.com`

## Authentication

Admin token is required for create, getById, update, and delete routes.
The getAll route is public.

```http
Authorization: Bearer YOUR_ADMIN_TOKEN
```

## Schema

Each FAQ document contains:

```json
{
  "_id": "FAQ_ID",
  "question": "How do I connect the device?",
  "answer": "Open the app, pair the device, then start monitoring.",
  "createdAt": "2026-04-13T10:00:00.000Z",
  "updatedAt": "2026-04-13T10:00:00.000Z"
}
```

## CRUD Endpoints

### 1) Create FAQ

- Method: `POST`
- Endpoint: `/api/faq/create`

Request body:

```json
{
  "question": "How do I connect the device?",
  "answer": "Open the app, pair the device, then start monitoring."
}
```

Example:

```bash
curl -X POST http://localhost:3000/api/faq/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "question": "How do I connect the device?",
    "answer": "Open the app, pair the device, then start monitoring."
  }'
```

### 2) Get all FAQs

- Method: `GET`
- Endpoint: `/api/faq/getAll`
- Auth: Not required

Example:

```bash
curl -X GET http://localhost:3000/api/faq/getAll
```

### 3) Get FAQ by ID

- Method: `GET`
- Endpoint: `/api/faq/getById/:id`

Example:

```bash
curl -X GET http://localhost:3000/api/faq/getById/FAQ_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 4) Update FAQ

- Method: `PUT`
- Endpoint: `/api/faq/update/:id`

Request body:

```json
{
  "question": "How do I connect the device?",
  "answer": "Use the pairing flow inside the app settings."
}
```

Example:

```bash
curl -X PUT http://localhost:3000/api/faq/update/FAQ_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "question": "How do I connect the device?",
    "answer": "Use the pairing flow inside the app settings."
  }'
```

### 5) Delete FAQ

- Method: `DELETE`
- Endpoint: `/api/faq/delete/:id`

Example:

```bash
curl -X DELETE http://localhost:3000/api/faq/delete/FAQ_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## Response Shape

List endpoints return:

```json
{
  "success": true,
  "message": "FAQs fetched successfully",
  "totalFaqs": 2,
  "faqs": []
}
```

Single-item endpoints return:

```json
{
  "success": true,
  "message": "FAQ fetched successfully",
  "faq": {}
}
```

## Notes

- `question` and `answer` are required for create and update.
- FAQ records are sorted by newest first.
- This module follows the same admin CRUD pattern used by the other content-management APIs in the project.
