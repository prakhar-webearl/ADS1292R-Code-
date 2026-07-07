# Plan And Plan Purchase API

Base URL: `http://localhost:3000`

This module provides:
- Admin plan CRUD APIs
- User plan listing APIs
- User plan purchase APIs
- Admin purchase management APIs

## Specific Routes (Route Prefixes)

Primary specific routes for this module:

- Admin routes: `/api/plan/admin/*`
- User routes: `/api/plan/user/*`

User-facing legacy compatibility routes (same functionality):

- `/api/user/plan/getallplans` -> `GET /api/plan/user/list`
- `/api/user/plan/getplan/:id` -> `GET /api/plan/user/:id`
- `/api/user/plan/create-order` -> `POST /api/plan/user/create-order`
- `/api/user/plan/verify-payment` -> `POST /api/plan/user/verify-payment`
- `/api/user/plan/purchase` -> `POST /api/plan/user/purchase`
- `/api/user/plan/my-purchases` -> `GET /api/plan/user/my-purchases`
- `/api/user/plan/current` -> `GET /api/plan/user/current-plan`

## Authentication

Use JWT token in header:

- User token: `Authorization: Bearer <USER_TOKEN>`
- Admin token: `Authorization: Bearer <ADMIN_TOKEN>`

## Plan Object (Key Fields)

- `title` (string, required)
- `description` (string, required)
- `planType` (enum: `basic`, `premium`, `clinical_lite`, `clinical`)
- `iconType` (enum: `heart`, `crown`, `sparkle`, `custom`)
- `price` (number)
- `currency` (string, default `INR`)
- `billingCycle` (enum: `monthly`, `yearly`, `lifetime`)
- `consultancyCount` (number, default `10`)
- `features` (string array)
- `isActive` (boolean)
- `sortOrder` (number)

## Consultancy Policy Rule

- **All plans** enforce `consultancyCount` as a quota limit (both free and paid).
- Free plans (`price = 0`): each booking is **free** (amount = 0) and deducts from quota.
- Paid plans (`price > 0`): each booking **requires payment** (Razorpay) and deducts from quota.
- When quota exhausted: user can opt-in to pay per-consultancy via `payIfNoFree: true` + `amount`.

**Booking Behavior:**
- Plan with available quota: create booking immediately (free) or via Razorpay (paid).
- Quota exhausted: return 403 with hint to use `payIfNoFree: true` for one-off paid booking.

## Purchase Object (Key Fields)

- `userId`
- `planId`
- `amount`
- `currency`
- `paymentMethod`
- `razorpayOrderId`
- `razorpayPaymentId`
- `razorpaySignature`
- `transactionId`
- `purchaseStatus` (`pending`, `active`, `expired`, `cancelled`, `failed`)
- `isCurrent`
- `startsAt`
- `expiresAt`
- `consultancyUsage` (computed in API response)
  - `isUnlimited`
  - `limit`
  - `used`
  - `remaining`
- `validity` (computed in API response)
  - `purchasedAt`
  - `expiresAt`
  - `validDays`
  - `remainingDays`
  - `isLifetime`
  - `isExpired`
  - `purchaseStatus`

## Razorpay Environment Variables

Set these variables in `.env`:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`

---

## 1. Admin Plan CRUD APIs

### 1.1 Create Plan

`POST /api/plan/admin/create`

Example:

```bash
curl -X POST http://localhost:3000/api/plan/admin/create \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Clinical Lite Plan",
    "description": "For medical professionals",
    "planType": "clinical_lite",
    "iconType": "sparkle",
    "price": 249,
    "currency": "INR",
    "billingCycle": "monthly",
    "consultancyCount": 10,
    "features": ["All basic plan features", "Cloud storage", "Priority support"],
    "isActive": true,
    "sortOrder": 1
  }'
```

### 1.2 List Plans (Admin)

`GET /api/plan/admin/list?planType=clinical_lite&isActive=true`

```bash
curl http://localhost:3000/api/plan/admin/list \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 1.3 Get Plan By ID (Admin)

`GET /api/plan/admin/:id`

```bash
curl http://localhost:3000/api/plan/admin/PLAN_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 1.4 Update Plan

`PUT /api/plan/admin/:id`

```bash
curl -X PUT http://localhost:3000/api/plan/admin/PLAN_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Clinical Lite Plan",
    "description": "Updated plan description",
    "planType": "clinical_lite",
    "iconType": "sparkle",
    "price": 299,
    "consultancyCount": 20,
    "features": ["Custom clinic", "Custom ECG reports", "Priority support"],
    "isActive": true
  }'
```

### 1.5 Update Plan Active Flag

`PATCH /api/plan/admin/:id/status`

```bash
curl -X PATCH http://localhost:3000/api/plan/admin/PLAN_ID/status \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": true
  }'
```

### 1.6 Delete Plan

`DELETE /api/plan/admin/:id`

```bash
curl -X DELETE http://localhost:3000/api/plan/admin/PLAN_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## 2. User Plan APIs

### 2.1 List Active Plans

`GET /api/plan/user/list`

```bash
curl http://localhost:3000/api/plan/user/list \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

### 2.2 Get Active Plan By ID

`GET /api/plan/user/:id`

```bash
curl http://localhost:3000/api/plan/user/PLAN_ID \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

---

## 3. User Plan Purchase APIs (Razorpay)

### 3.1 Create Razorpay Order

`POST /api/plan/user/create-order`

```bash
curl -X POST http://localhost:3000/api/plan/user/create-order \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "planId": "PLAN_ID",
    "currency": "INR",
    "notes": "Checkout from mobile app"
  }'
```

Response includes:
- `key` (Razorpay key id)
- `order` (Razorpay order object)
- `purchase` (pending purchase entry)

### 3.2 Verify Razorpay Payment

`POST /api/plan/user/verify-payment`

```bash
curl -X POST http://localhost:3000/api/plan/user/verify-payment \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "purchaseId": "PURCHASE_ID",
    "razorpay_order_id": "order_xxx",
    "razorpay_payment_id": "pay_xxx",
    "razorpay_signature": "generated_signature"
  }'
```

Plan is activated only after successful signature verification.

The purchase response also includes `consultancyUsage` with `limit`, `used`, and `remaining` so the UI can show how many consultancy bookings are available in the active plan.

Plan purchase responses now also include `consultancyUsage` so the app can show how many consultancy bookings are included in the current plan.

### 3.3 Direct Purchase (Manual/Free)

`POST /api/plan/user/purchase`

```bash
curl -X POST http://localhost:3000/api/plan/user/purchase \
  -H "Authorization: Bearer YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "planId": "PLAN_ID",
    "paymentMethod": "manual",
    "amount": 249,
    "currency": "INR",
    "transactionId": "MANUAL_TXN_123456",
    "notes": "Purchased from app checkout"
  }'
```

Note:
- For paid plans, preferred flow is `create-order` + `verify-payment`.
- Direct purchase is primarily for admin/manual/offline cases and free plans.

### 3.4 My Purchased Plans

`GET /api/plan/user/my-purchases`

```bash
curl http://localhost:3000/api/plan/user/my-purchases \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

### 3.5 My Current Plan

`GET /api/plan/user/current-plan`

```bash
curl http://localhost:3000/api/plan/user/current-plan \
  -H "Authorization: Bearer YOUR_USER_TOKEN"
```

---

## 4. Admin Purchase Management APIs

### 4.1 List All Purchases

`GET /api/plan/admin/purchases?purchaseStatus=active&isCurrent=true`

```bash
curl http://localhost:3000/api/plan/admin/purchases \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 4.2 Get Purchase By ID

`GET /api/plan/admin/purchases/:id`

```bash
curl http://localhost:3000/api/plan/admin/purchases/PURCHASE_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 4.3 Update Purchase Status

`PATCH /api/plan/admin/purchases/:id/status`

```bash
curl -X PATCH http://localhost:3000/api/plan/admin/purchases/PURCHASE_ID/status \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "purchaseStatus": "expired",
    "isCurrent": false,
    "notes": "Manually expired by admin"
  }'
```

---

## Backward Compatibility

Legacy admin plan APIs are still available:
- `POST /api/plan/add`
- `GET /api/plan/getAllPlan`
- `GET /api/plan/getById/:id`
- `PUT /api/plan/update/:id`
- `DELETE /api/plan/delete/:id`
- `PATCH /api/plan/statusUpdate/:id`

Legacy user plan routes are still available under `/api/user/plan/*`.
