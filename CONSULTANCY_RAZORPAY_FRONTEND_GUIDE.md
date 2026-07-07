# Consultancy Razorpay Frontend Integration Guide

This guide explains how frontend should integrate Razorpay for consultancy booking using existing backend APIs.

## Base URL

- Local: `http://localhost:3000`
- Production: your deployed API URL

## Authentication

For protected routes, send token in header:

- `Authorization: Bearer <JWT_TOKEN>`

## Environment Variables Required On Backend

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `JWT_SECRET`

## Booking Flow (Frontend + API)

1. User selects date and time.
2. Frontend calls create-order API with required fields.
3. Backend checks the active plan policy:
  - **All plans enforce `consultancyCount` quota** (both free and paid).
  - If quota available:
    - Free plan (`price = 0`): booking confirmed immediately, amount = 0.
    - Paid plan (`price > 0`): returns Razorpay order for payment.
  - If quota exhausted: returns 403 with hint to use `payIfNoFree: true` for per-consultancy payment.
4. For paid plans with quota available, frontend opens Razorpay checkout.
5. On payment success, frontend calls verify-payment API to confirm booking.
6. For quota-exhausted fallback, send `payIfNoFree: true` + amount to create a one-off paid booking.

---

## 1) Create Razorpay Order (Creates Pending Booking Record)

Endpoint:

- `POST /api/consultancy/create-order`
- Protected route

Request Body:

```json
{
  "consultationDate": "2026-04-15",
  "timeSlot": "10:00 AM - 10:30 AM",
  "consultationLanguage": "English",
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

Success Response (important fields):

Paid plan response:

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

Free plan response:

```json
{
  "success": true,
  "message": "Free plan consultancy booked successfully",
  "booking": {
    "_id": "BOOKING_ID",
    "paymentStatus": "paid",
    "bookingStatus": "booked",
    "amount": 0
  },
  "planUsage": {
    "isUnlimited": false,
    "limit": 10,
    "used": 3,
    "remaining": 7
  }
}

---

## Free plan — Quick Example

If the user has an active free plan (plan `price = 0`) and remaining `consultancyCount` > 0, the booking is created immediately without payment.

1. Ensure user has an active free plan: call `GET /api/plan/my-current` (protected) to view `consultancyUsage.remaining`.
2. Call `POST /api/consultancy/create-order` with required fields (no `amount` is necessary for free bookings).

Sample Request (free booking):

```json
{
  "consultationDate": "2026-05-10",
  "timeSlot": "10:00 AM - 10:30 AM",
  "consultationLanguage": "English",
  "monitorId": "ESP_ECG_123",
  "full_name": "Alice User",
  "email": "alice@example.com",
  "phoneNumber": "9999999999",
  "notes": "Follow-up",
  "memberId": "",
  "memberName": "",
  "memberRelation": ""
}
```

Successful free booking response (trimmed):

```json
{
  "success": true,
  "message": "Free plan consultancy booked successfully",
  "booking": {
    "_id": "BOOKING_ID",
    "paymentStatus": "paid",
    "bookingStatus": "booked",
    "planPurchaseId": "PLAN_PURCHASE_ID",
    "amount": 0
  },
  "planUsage": {
    "isUnlimited": false,
    "limit": 5,
    "used": 1,
    "remaining": 4
  } 
}
```

If the free plan quota is exhausted the API responds with HTTP 403 and a hint. To pay for a single consultancy when free quota is exhausted, send `payIfNoFree: true` and include a valid `amount` in the request to create a paid Razorpay order (handled by backend). Example hint response when quota exhausted:

```json
{
  "success": false,
  "message": "Your current plan consultancy limit has been reached.",
  "planLimit": 5,
  "usedConsultancies": 5,
  "remainingConsultancies": 0,
  "hint": "Set `payIfNoFree=true` and provide an `amount` to pay for this single consultancy."
}
```

---

## 2) Verify Payment (Paid Plan Only)

Endpoint:

- `POST /api/consultancy/verify-payment`
- Protected route

Request Body:

```json
{
  "bookingId": "BOOKING_ID",
  "razorpay_order_id": "order_Q2abc123",
  "razorpay_payment_id": "pay_Q2xyz456",
  "razorpay_signature": "generated_signature_from_razorpay"
}
```

Success Response:

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

Important:

- Booking is considered final only when `verify-payment` succeeds.
- Do not trust payment on frontend alone.
- `userId` is read from the auth token, not from the request body.
- The backend rejects `create-order` if the user has no active plan.
- Free plans are quota-limited (`consultancyCount`) and do not charge per consultancy.
- Paid plans are unlimited and require Razorpay payment for each consultancy booking.

---

## 3) Get My Bookings

Endpoint:

- `GET /api/consultancy/my-bookings`
- Protected route

Success Response:

```json
{
  "success": true,
  "totalBookings": 2,
  "bookings": [
    {
      "_id": "BOOKING_ID",
      "consultationDate": "2026-04-15T00:00:00.000Z",
      "timeSlot": "10:00 AM - 10:30 AM",
      "paymentStatus": "paid",
      "bookingStatus": "booked"
    }
  ]
}
```

---

## Frontend Razorpay Sample (JavaScript)

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
    },
  };

  const rzp = new window.Razorpay(options);
  rzp.open();
}
```

## Razorpay Checkout Script In Frontend

Include in frontend page/app: 

```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

## Notes

- Amount sent to `create-order` is in rupees (example: `499`).
- Backend converts to paise for Razorpay.
- Date format must be `YYYY-MM-DD`.
- `timeSlot` is open text from frontend (no fixed predefined slot list validation).
- `monitorId` is required and is stored with the consultancy booking.
- If booking for a family member, send `memberId` or `memberName`/`memberRelation` and the backend will store the member details.
