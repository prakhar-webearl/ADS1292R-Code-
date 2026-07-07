# Admin API Documentation

This document is a dedicated reference for all Admin APIs in this project.

Base URL (local):
- `http://localhost:3000`

Main admin auth prefix:
- `/api/appAdmin`

Admin auth middleware used:
- `AppAdminprotect` (JWT token required in `Authorization` header)

---

## 1) Authentication

### 1.1 Admin Login
- Method: `POST`
- URL: `/api/appAdmin/login`
- Auth required: No

Request body (`application/json`):
```json
{
  "email": "admin@example.com",
  "password": "admin123"
}
```

You can also log in using `phoneNumber` instead of `email`:
```json
{
  "phoneNumber": "9876543210",
  "password": "admin123"
}
```

Success response (`200`):
```json
{
  "_id": "<admin_id>",
  "email": "admin@example.com",
  "phoneNumber": "9876543210",
  "token": "<jwt_token>"
}
```

Error response (`401`):
```json
{
  "message": "Invalid email/phone number or password"
}
```

---

### 1.2 Using Admin Token
For all protected admin endpoints, send:

- Header: `Authorization: Bearer <token>`

Example:
```bash
curl -X GET http://localhost:3000/api/appAdmin/getadminprofile \
  -H "Authorization: Bearer <token>"
```

If token is missing:
```json
{
  "message": "Not authorized, no token"
}
```

If token is invalid:
```json
{
  "message": "Not authorized, invalid token"
}
```

---

## 2) Admin Profile APIs

### 2.1 Get Admin Profile
- Method: `GET`
- URL: `/api/appAdmin/getadminprofile`
- Auth required: Yes

Success (`200`):
```json
{
  "_id": "<admin_id>",
  "email": "admin@example.com",
  "phoneNumber": "9876543210"
}
```

---

### 2.2 Update Admin Profile
- Method: `PUT`
- URL: `/api/appAdmin/updateprofile`
- Auth required: Yes

Request body:
```json
{
  "email": "new-admin@example.com",
  "phoneNumber": "9999999999"
}
```

Success (`200`):
```json
{
  "_id": "<admin_id>",
  "email": "new-admin@example.com",
  "phoneNumber": "9999999999"
}
```

---

### 2.3 Change Admin Password
- Method: `PUT`
- URL: `/api/appAdmin/changepassword`
- Auth required: Yes

Request body:
```json
{
  "oldPassword": "old_password_here",
  "newPassword": "new_password_here"
}
```

Success (`200`):
```json
{
  "message": "Password changed successfully"
}
```

Common errors:
- `404`: `{"message":"User not found"}`
- `400`: `{"message":"Old password is incorrect"}`

### How to use change password (step-by-step)
1. Login from `/api/appAdmin/login` and copy the returned `token`.
2. Call `/api/appAdmin/changepassword` with `Authorization: Bearer <token>`.
3. Send both `oldPassword` and `newPassword` in JSON body.
4. Login again with the new password to verify.

Example:
```bash
curl -X PUT http://localhost:3000/api/appAdmin/changepassword \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "oldPassword": "admin123",
    "newPassword": "Admin@1234"
  }'
```

---

## 3) Admin User Management APIs

### 3.1 Get All Users
- Method: `GET`
- URL: `/api/appAdmin/getAllUser`
- Auth required: Yes

---

### 3.2 Get User By ID
- Method: `GET`
- URL: `/api/appAdmin/getUserById/:id`
- Auth required: Yes

Response now includes:
- `mainUser` profile data without password
- `familyMembers` created by the user
- `currentPlan` and `planPurchases`
- `consultancyHistory`
- `reports` for the main user and each family member, plus `allReports`
- `reports` contains monitor reports only

---

### 3.3 Update User Status (active/blocked)
- Method: `PATCH`
- URL: `/api/appAdmin/userStatus/:id`
- Auth required: Yes

Request body:
```json
{
  "status": "blocked"
}
```

Allowed values:
- `active`
- `blocked`

Success (`200`) includes updated user object.

---

### 3.4 Get User With Family By ID
- Method: `GET`
- URL: `/api/appAdmin/user-with-family/:id`
- Auth required: Yes

This endpoint returns the same enriched user detail payload as `getUserById`.

---

### 3.5 Delete User
- Method: `DELETE`
- URL: `/api/appAdmin/deleteUser/:id`
- Auth required: Yes

Success response:
```json
{
  "message": "User deleted successfully"
}
```

---

## 4) Other Admin-Protected APIs (outside `/api/appAdmin`)

The following endpoints are also admin-only because they use `AppAdminprotect`.

### 4.1 Plan Admin Endpoints (`/api/plan`)
- `POST /api/plan/admin/create`
- `GET /api/plan/admin/list`
- `GET /api/plan/admin/:id`
- `PUT /api/plan/admin/:id`
- `DELETE /api/plan/admin/:id`
- `PATCH /api/plan/admin/:id/status`
- `GET /api/plan/admin/purchases`
- `GET /api/plan/admin/purchases/:id`
- `PATCH /api/plan/admin/purchases/:id/status`

Legacy admin plan endpoints:
- `POST /api/plan/add`
- `GET /api/plan/getAllPlan`
- `GET /api/plan/getById/:id`
- `PUT /api/plan/update/:id`
- `DELETE /api/plan/delete/:id`
- `PATCH /api/plan/statusUpdate/:id`

### 4.2 Store Admin Endpoints (`/api/store`)
- `POST /api/store/product/create`
- `PATCH /api/store/product/:productId/status`
- `PATCH /api/store/order/:orderId/status`
- `PATCH /api/store/order/:orderId/shipping-status`

### 4.3 Article Admin Endpoints (`/api/article`)
- `POST /api/article/create`
- `GET /api/article/getall`
- `GET /api/article/getById/:id`
- `PUT /api/article/update/:id`
- `DELETE /api/article/delete/:id`

### 4.4 Test Admin Endpoints (`/api/test`)
- `POST /api/test/testCreate`
- `PUT /api/test/updateTest/:id`
- `GET /api/test/getAllTest`
- `GET /api/test/getTest/:id`
- `DELETE /api/test/deleteTest/:id`

### 4.5 Help Admin Endpoints (`/api/help`)
- `POST /api/help/create`
- `GET /api/help/getAll`
- `GET /api/help/getById/:id`
- `PUT /api/help/update/:id`
- `DELETE /api/help/delete/:id`

### 4.6 FAQ Admin Endpoints (`/api/faq`)
- `POST /api/faq/create`
- `GET /api/faq/getById/:id`
- `PUT /api/faq/update/:id`
- `DELETE /api/faq/delete/:id`

### 4.7 Privacy Policy Admin Endpoints (`/api/privacypolicy`)
- `POST /api/privacypolicy/create`
- `GET /api/privacypolicy/getAll`
- `GET /api/privacypolicy/getById/:id`
- `PUT /api/privacypolicy/update/:id`
- `DELETE /api/privacypolicy/delete/:id`

### 4.8 Terms & Conditions Admin Endpoints (`/api/termscondition`)
- `POST /api/termscondition/create`
- `GET /api/termscondition/getAll`
- `GET /api/termscondition/getById/:id`
- `PUT /api/termscondition/update/:id`
- `DELETE /api/termscondition/delete/:id`

### 4.9 Coupon Admin Endpoints (`/api/coupon`)
- `POST /api/coupon/create`
- `PATCH /api/coupon/updatecoupons/:id`
- `DELETE /api/coupon/deletecoupons/:id`

### 4.10 Notification Admin Endpoint (`/api/notification`)
- `DELETE /api/notification/delete/:id`

---

## 5) Detailed Request Body Reference (What to pass)

This section gives exact request format for each admin API.

### 5.1 `/api/appAdmin` (Admin account + users)

1. `POST /api/appAdmin/login`
- Content-Type: `application/json`
- Body (any one identity field):
```json
{
  "email": "admin@example.com",
  "password": "admin123"
}
```
or
```json
{
  "phoneNumber": "9876543210",
  "password": "admin123"
}
```

2. `GET /api/appAdmin/getadminprofile`
- Body: none

3. `PUT /api/appAdmin/updateprofile`
- Content-Type: `application/json`
- Body (any one or both):
```json
{
  "email": "new-admin@example.com",
  "phoneNumber": "9999999999"
}
```

4. `PUT /api/appAdmin/changepassword`
- Content-Type: `application/json`
- Body:
```json
{
  "oldPassword": "old_password_here",
  "newPassword": "new_password_here"
}
```

5. `GET /api/appAdmin/getAllUser`
- Body: none

6. `GET /api/appAdmin/getUserById/:id`
- Path param: `id` = User Mongo ObjectId
- Body: none

7. `PATCH /api/appAdmin/userStatus/:id`
- Content-Type: `application/json`
- Path param: `id` = User Mongo ObjectId
- Body:
```json
{
  "status": "blocked"
}
```
- Allowed `status`: `active`, `blocked`

8. `GET /api/appAdmin/user-with-family/:id`
- Path param: `id` = User Mongo ObjectId
- Body: none

9. `DELETE /api/appAdmin/deleteUser/:id`
- Path param: `id` = User Mongo ObjectId
- Body: none

### 5.2 `/api/plan` admin endpoints

#### A) Create/Update plan (multipart)

1. `POST /api/plan/admin/create`
2. `PUT /api/plan/admin/:id`
3. Legacy: `POST /api/plan/add`
4. Legacy: `PUT /api/plan/update/:id`

- Content-Type: `multipart/form-data`
- File field: `photo` (optional on update, optional in payload logic)
- Required on create: `title`, `description`
- Supported form fields:
  - `title` (string)
  - `category` (string)
  - `description` (string)
  - `duration_in_day` (string/number)
  - `times_per_week` (string/number)
  - `difficulty` (string)
  - `title2` (string)
  - `description2` (string)
  - `status` (string)
  - `planType` (string)
  - `iconType` (string)
  - `buttonState` (string)
  - `ctaLabel` (string)
  - `priceLabel` (string)
  - `currency` (string, e.g. `INR`)
  - `billingCycle` (string, usually monthly/yearly/lifetime)
  - `price` (number)
  - `sortOrder` (number)
  - `features` (JSON array string or comma-separated string)
  - `schedule` (JSON array string or comma-separated string)
  - `theme` (JSON object string)
  - `isActive` (boolean or string `true`/`false`)
  - `photo` (string fallback if no file)

Example form-data text fields:
```json
{
  "title": "Pro Plan",
  "description": "Advanced ECG plan",
  "price": 999,
  "currency": "INR",
  "billingCycle": "monthly",
  "features": "[\"Priority support\",\"Weekly report\"]",
  "theme": "{\"badgeColor\":\"#22c55e\"}",
  "isActive": true
}
```

#### B) Read plan list/details

1. `GET /api/plan/admin/list`
2. Legacy: `GET /api/plan/getAllPlan`
- Query (optional):
  - `status`
  - `planType`
  - `isActive` (`true`/`false`)
- Body: none

3. `GET /api/plan/admin/:id`
4. Legacy: `GET /api/plan/getById/:id`
- Path param: `id` = Plan ObjectId
- Body: none

#### C) Delete plan

1. `DELETE /api/plan/admin/:id`
2. Legacy: `DELETE /api/plan/delete/:id`
- Path param: `id` = Plan ObjectId
- Body: none

#### D) Update plan status

1. `PATCH /api/plan/admin/:id/status`
2. Legacy: `PATCH /api/plan/statusUpdate/:id`

- Content-Type: `application/json`
- Body (send one or more fields):
```json
{
  "status": "Pro",
  "buttonState": "upgrade",
  "isActive": true
}
```
- Allowed `status`: `Basic`, `Pro`, `Premium`, `ClinicalLite`, `Clinical`
- Allowed `buttonState`: `upgrade`, `current`, `disabled`

#### E) Admin purchase management

1. `GET /api/plan/admin/purchases`
- Query (all optional):
  - `userId`
  - `planId`
  - `purchaseStatus`
  - `isCurrent` (`true`/`false`)
- Body: none

2. `GET /api/plan/admin/purchases/:id`
- Path param: `id` = Purchase ObjectId
- Body: none

3. `PATCH /api/plan/admin/purchases/:id/status`
- Content-Type: `application/json`
- Body (send one or more):
```json
{
  "purchaseStatus": "cancelled",
  "isCurrent": false,
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "notes": "Cancelled by admin request"
}
```
- Allowed `purchaseStatus`: `pending`, `active`, `expired`, `cancelled`, `failed`
- `expiresAt` can be `null`/empty to remove expiry

### 5.3 `/api/store` admin endpoints

1. `POST /api/store/product/create`
- Content-Type: `multipart/form-data`
- Auth: admin token
- File field: `image` (required)
- Text fields:
  - `title` (required)
  - `price` (required, positive number)
  - `description` (optional)
  - `packageDetails` (optional array, JSON array string, or comma-separated)
  - `currency` (optional, default `INR`)
  - `isActive` (optional, default true)

Example:
```json
{
  "title": "ECG Device",
  "description": "Portable ECG monitor",
  "price": 2999,
  "currency": "INR",
  "packageDetails": "[\"Cable\",\"Manual\",\"Charger\"]",
  "isActive": true
}
```

2. `PATCH /api/store/product/:productId/status`
- Content-Type: `application/json`
- Body:
```json
{
  "isActive": false
}
```

3. `PATCH /api/store/order/:orderId/status`
- Content-Type: `application/json`
- Body:
```json
{
  "orderStatus": "cancelled",
  "note": "Customer requested cancellation"
}
```
- Allowed `orderStatus`: `pending`, `booked`, `cancelled`

4. `PATCH /api/store/order/:orderId/shipping-status`
- Content-Type: `application/json`
- Body:
```json
{
  "shippingStatus": "shipped",
  "note": "AWB assigned"
}
```
- Allowed `shippingStatus`:
  - `not_required`
  - `pending`
  - `packed`
  - `shipped`
  - `out_for_delivery`
  - `delivered`
  - `returned`
  - `cancelled`

### 5.4 `/api/article` admin endpoints

1. `POST /api/article/create`
- Content-Type: `multipart/form-data`
- File field: `photo` (required)
- Text fields (all required):
  - `blog_title`
  - `description`
  - `read_time`

2. `GET /api/article/getall`
- Body: none

3. `GET /api/article/getById/:id`
- Path param: `id` = Article ObjectId (or temporary blog id)
- Body: none

4. `PUT /api/article/update/:id`
- Content-Type: `multipart/form-data`
- Path param: `id` = Article ObjectId
- Send any updatable fields:
  - `blog_title`
  - `description`
  - `read_time`
  - `photo` (file field or string path)

5. `DELETE /api/article/delete/:id`
- Path param: `id` = Article ObjectId
- Body: none

### 5.5 `/api/test` admin endpoints

1. `POST /api/test/testCreate`
- Content-Type: `multipart/form-data`
- File field: `photo` (optional)
- Fields:
  - `name`
  - `description_name`
  - `description`
  - `question_title`
  - `point` (string or array)

2. `PUT /api/test/updateTest/:id`
- Content-Type: `multipart/form-data`
- Path param: `id` = Test ObjectId
- Fields (optional):
  - `name`
  - `description_name`
  - `description`
  - `question_title`
  - `point` (string/array; new points are appended)
  - `photo` file

3. `GET /api/test/getAllTest`
- Body: none

4. `GET /api/test/getTest/:id`
- Path param: `id` = Test ObjectId
- Body: none

5. `DELETE /api/test/deleteTest/:id`
- Path param: `id` = Test ObjectId
- Body: none

### 5.6 `/api/help` admin endpoints

1. `POST /api/help/create`
- Content-Type: `application/json`
- Body:
```json
{
  "question": "How to reset password?",
  "answer": "Go to profile and click change password"
}
```

2. `GET /api/help/getAll`
- Body: none

3. `GET /api/help/getById/:id`
- Path param: `id` = Help ObjectId
- Body: none

4. `PUT /api/help/update/:id`
- Content-Type: `application/json`
- Path param: `id` = Help ObjectId
- Body:
```json
{
  "question": "Updated question",
  "answer": "Updated answer"
}
```

5. `DELETE /api/help/delete/:id`
- Path param: `id` = Help ObjectId
- Body: none

### 5.7 `/api/faq` admin endpoints

1. `POST /api/faq/create`
- Content-Type: `application/json`
- Body (required):
```json
{
  "question": "Is ECG safe?",
  "answer": "Yes, it is non-invasive"
}
```

2. `GET /api/faq/getById/:id`
- Path param: `id` = FAQ ObjectId
- Body: none

3. `PUT /api/faq/update/:id`
- Content-Type: `application/json`
- Path param: `id` = FAQ ObjectId
- Body (required):
```json
{
  "question": "Updated FAQ question",
  "answer": "Updated FAQ answer"
}
```

4. `DELETE /api/faq/delete/:id`
- Path param: `id` = FAQ ObjectId
- Body: none

### 5.8 `/api/privacypolicy` admin endpoints

1. `POST /api/privacypolicy/create`
- Content-Type: `application/json`
- Body:
```json
{
  "title": "Privacy Policy",
  "contentHtml": "<p>Your policy html here</p>"
}
```
- You can send `description` instead of `contentHtml`.

2. `GET /api/privacypolicy/getAll`
- Body: none

3. `GET /api/privacypolicy/getById/:id`
- Path param: `id` = PrivacyPolicy ObjectId
- Body: none

4. `PUT /api/privacypolicy/update/:id`
- Content-Type: `application/json`
- Path param: `id` = PrivacyPolicy ObjectId
- Body (any one or both):
```json
{
  "title": "Updated title",
  "contentHtml": "<p>Updated html</p>"
}
```

5. `DELETE /api/privacypolicy/delete/:id`
- Path param: `id` = PrivacyPolicy ObjectId
- Body: none

### 5.9 `/api/termscondition` admin endpoints

1. `POST /api/termscondition/create`
- Content-Type: `application/json`
- Body:
```json
{
  "title": "Terms & Conditions",
  "contentHtml": "<p>Your terms html here</p>"
}
```
- You can send `description` instead of `contentHtml`.

2. `GET /api/termscondition/getAll`
- Body: none

3. `GET /api/termscondition/getById/:id`
- Path param: `id` = TermsCondition ObjectId
- Body: none

4. `PUT /api/termscondition/update/:id`
- Content-Type: `application/json`
- Path param: `id` = TermsCondition ObjectId
- Body (any one or both):
```json
{
  "title": "Updated terms title",
  "contentHtml": "<p>Updated terms html</p>"
}
```

5. `DELETE /api/termscondition/delete/:id`
- Path param: `id` = TermsCondition ObjectId
- Body: none

### 5.10 `/api/coupon` admin endpoints

1. `POST /api/coupon/create`
- Content-Type: `application/json`
- Body (required):
```json
{
  "code": "NEW10",
  "discount": 10,
  "startDate": "2026-05-01",
  "endDate": "2026-05-31"
}
```
- Validation:
  - `discount` must be between 0 and 100
  - `startDate` must not be in past
  - `endDate` must be after `startDate`

2. `PATCH /api/coupon/updatecoupons/:id`
- Content-Type: `application/json`
- Path param: `id` = Coupon ObjectId
- Body (any fields):
```json
{
  "code": "NEW20",
  "discount": 20,
  "startDate": "2026-06-01",
  "endDate": "2026-06-30"
}
```

3. `DELETE /api/coupon/deletecoupons/:id`
- Path param: `id` = Coupon ObjectId
- Body: none

### 5.11 `/api/notification` admin endpoint

1. `DELETE /api/notification/delete/:id`
- Path param: `id` = Notification ObjectId
- Body: none

---

## 6) Quick End-to-End Example

### Login -> Get Profile -> Change Password

```bash
# 1) Login
curl -X POST http://localhost:3000/api/appAdmin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}'

# 2) Get profile
curl -X GET http://localhost:3000/api/appAdmin/getadminprofile \
  -H "Authorization: Bearer <token>"

# 3) Change password
curl -X PUT http://localhost:3000/api/appAdmin/changepassword \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"oldPassword":"admin123","newPassword":"Admin@1234"}'
```

---

## 7) Important Implementation Notes

1. Current login compares plaintext password (`password !== user.password`).
2. Change password uses bcrypt compare/hash.
3. If older admin data is stored plaintext in DB, change-password can fail with `Old password is incorrect`.
4. Recommended: store admin passwords hashed with bcrypt in DB for consistent behavior.

---

## 8) Environment Variables Required

```env
PORT=3000
MONGODB_URL=<your_mongodb_connection_string>
JWT_ADMIN_SECRET=<your_admin_jwt_secret>
```
