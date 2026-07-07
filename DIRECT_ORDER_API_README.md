# Direct Order + Razorpay APIs (No Cart Flow)

This module implements a **direct order flow**:
- User selects a single `productId` and `quantity`
- Backend creates Razorpay order
- User pays on frontend
- Backend verifies signature and marks order as `booked`

Reference used: consultancy payment flow.

## Base Path

`/api/store`

## 1) Create Product (Admin)

- Method: `POST`
- Path: `/api/store/product/create`
- Auth: `Bearer <admin_token>`
- Content-Type: `multipart/form-data`

Form-data fields:

- `image` (file) - required, image only
- `title` (text) - required
- `description` (text) - optional
- `packageDetails` (text) - optional (JSON array string or comma-separated text)
- `price` (text/number) - required
- `currency` (text) - optional, default `INR`
- `isActive` (text/boolean) - optional, default `true`

Example JSON equivalent:

```json
{
  "title": "ECG Premium Package",
  "image": "<upload file>",
  "description": "12-month access with priority support",
  "packageDetails": ["Priority doctor review", "Detailed PDF reports", "Monthly follow-up"],
  "price": 1999,
  "currency": "INR",
  "isActive": true
}
```

## 2) List Products

- Method: `GET`
- Path: `/api/store/product/list`
- Query (optional): `onlyActive=true|false`

Example:

`GET /api/store/product/list?onlyActive=true`

## 3) Update Product Status (Admin)

- Method: `PATCH`
- Path: `/api/store/product/:productId/status`
- Auth: `Bearer <admin_token>`

Request body:

```json
{
  "isActive": false
}
```

## 4) Product Details

- Method: `GET`
- Path: `/api/store/product/:productId`
- Query (optional): `includeInactive=true|false`

Example:

`GET /api/store/product/661a2f7d2f2f2f2f2f2f2f2f`

## 5) Create Direct Order (User)

- Method: `POST`
- Path: `/api/store/order/create-order`
- Auth: `Bearer <user_token>`

Request body:

```json
{
  "productId": "661a2f7d2f2f2f2f2f2f2f2f",
  "quantity": 2,
  "customerName": "Rahul Shah",
  "customerEmail": "rahul@example.com",
  "customerPhone": "9876543210",
  "address": {
    "street": "123 Main Street, Apt 5",
    "city": "Mumbai",
    "state": "Maharashtra",
    "zipcode": "400001",
    "country": "India"
  }
}
```

Success response includes:
- `key` (Razorpay key id)
- `order` (DB direct order document)
- `razorpayOrder` (Razorpay order object)

Use `razorpayOrder.id` on frontend checkout.

## 6) Verify Payment (User)

- Method: `POST`
- Path: `/api/store/order/verify-payment`
- Auth: `Bearer <user_token>`

Request body:

```json
{
  "orderId": "661b3f8e3f3f3f3f3f3f3f3f",
  "razorpay_order_id": "order_ABC123",
  "razorpay_payment_id": "pay_XYZ123",
  "razorpay_signature": "signature_from_razorpay"
}
```

Payment method is fetched from Razorpay on the backend using `razorpay_payment_id`.
Razorpay aliases like `upi_intent` and `upi_collect` are normalized to `upi`, and card/netbanking variants are mapped to user-friendly values.

If signature is valid:
- `paymentStatus = "paid"`
- `paymentMethod` is saved in order
- `orderStatus = "booked"`

Returned response includes `paymentMethod`.

## 7) My Direct Orders (User)

- Method: `GET`
- Path: `/api/store/order/my-orders`
- Auth: `Bearer <user_token>`

## 8) Update Order Status (Admin)

- Method: `PATCH`
- Path: `/api/store/order/:orderId/status`
- Auth: `Bearer <admin_token>`

Request body:

```json
{
  "orderStatus": "cancelled",
  "note": "Cancelled by admin after customer request"
}
```

Allowed `orderStatus`: `pending`, `booked`, `cancelled`

Response includes:
- `order.orderStatusUpdatedAt` (date-time when status changed)
- `order.statusHistory` (full status change history with timestamp)
- `statusChange.changedAt`

## 9) Update Shipping Status (Admin)

- Method: `PATCH`
- Path: `/api/store/order/:orderId/shipping-status`
- Auth: `Bearer <admin_token>`

Request body:

```json
{
  "shippingStatus": "shipped",
  "note": "Dispatched via BlueDart AWB 123456789"
}
```

Allowed `shippingStatus`:
- `not_required`
- `pending`
- `packed`
- `shipped`
- `out_for_delivery`
- `delivered`
- `returned`
- `cancelled`

Response includes:
- `order.shippingStatusUpdatedAt` (date-time when shipping status changed)
- `order.shippingHistory` (full shipping status history with timestamp)
- `shippingStatusChange.changedAt`

## Required ENV

```env
RAZORPAY_KEY_ID=your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
IMAGEKIT_PUBLIC_KEY=your_imagekit_public_key
IMAGEKIT_PRIVATE_KEY=your_imagekit_private_key
IMAGEKIT_URL_ENDPOINT=https://ik.imagekit.io/your_imagekit_id
```

## Frontend Checkout Flow

1. Call create order API with `productId` + `quantity`
2. Open Razorpay Checkout using returned `key` and `razorpayOrder.id`
3. On payment success callback, call verify payment API
4. Show order booking success when verify API returns success
