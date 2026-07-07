# User Blog API README

This document covers user-facing blog APIs.

## Base URL

- Local: `http://localhost:3000`
- Production: `https://api-for-ecg.onrender.com`

## Authentication

All user blog APIs require user token in header:

```http
Authorization: Bearer YOUR_USER_TOKEN
```

## User Blog APIs

### 1) Get all blogs

- Method: `GET`
- Endpoint: `/api/user/article/getAllArticles`
- Auth: Required

Example:

```bash
curl -X GET http://localhost:3000/api/user/article/getAllArticles \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

### 2) Get blog by ID

- Method: `GET`
- Endpoint: `/api/user/article/getById/:id`
- Auth: Required

Example:

```bash
curl -X GET http://localhost:3000/api/user/article/getById/ARTICLE_ID \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

### 3) Home top blogs (default top 5)

- Method: `GET`
- Endpoint: `/api/user/home/top-blogs`
- Auth: Required
- Query (optional): `limit`

Example (default 5):

```bash
curl -X GET http://localhost:3000/api/user/home/top-blogs \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

Example (custom limit):

```bash
curl -X GET "http://localhost:3000/api/user/home/top-blogs?limit=5" \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

## Response Notes

- Blogs are sorted by latest first (`createdAt` descending).
- Blog `photo` is returned as a full public URL.
- If no blog exists in database, API returns temporary sample blogs for testing.
- Temporary blog objects include `isTemporary: true`.
- Top blogs response shape:
  - `success`
  - `message`
  - `totalBlogs`
  - `blogs`

## Admin Blog APIs (Reference)

These are admin-side blog management routes:

- `POST /api/article/create`
- `GET /api/article/getall`
- `GET /api/article/getById/:id`
- `PUT /api/article/update/:id`
- `DELETE /api/article/delete/:id`
