import crypto from "crypto";
import Razorpay from "razorpay";
import Product from "../models/productModel.js";
import DirectOrder from "../models/directOrderModel.js";
import Notification from "../models/notificationModel.js";
import { emitNewNotification } from "../services/notificationSocket.js";
import { uploadImageToImageKit } from "../services/imagekitService.js";
import { createAdminNotification } from "./adminNotification.Controller.js";

const buildRazorpayClient = () => {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return null;
  }

  return new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
};

const sendOrderNotification = async ({ userId, title, notification, details }) => {
  try {
    const createdNotification = await Notification.create({
      title,
      notification,
      details,
      targetUserId: String(userId),
    });

    emitNewNotification(createdNotification);

    // Also notify admin about order events
    await createAdminNotification({
      title: `Order Event: ${title}`,
      desc: notification,
      type: "PAYMENT",
      category: title.toLowerCase().includes("failed") ? "CRITICAL" : "SUCCESS",
      metadata: { userId, details }
    });
  } catch (notificationError) {
    console.error("Error sending order notification:", notificationError.message);
  }
};

const normalizePaymentMethod = (method) => {
  const normalizedMethod = String(method || "").toLowerCase().trim();
  if (!normalizedMethod) {
    return "other";
  }

  if (normalizedMethod.startsWith("upi")) {
    return "upi";
  }

  if (normalizedMethod.startsWith("card") || normalizedMethod.endsWith("card")) {
    return "card";
  }

  if (normalizedMethod.startsWith("netbank") || normalizedMethod.includes("net_bank")) {
    return "netbanking";
  }

  if (normalizedMethod.startsWith("wallet")) {
    return "wallet";
  }

  if (normalizedMethod.includes("emi") || normalizedMethod.startsWith("paylater")) {
    return "emi";
  }

  const allowedPaymentMethods = ["upi", "card", "netbanking", "wallet", "emi", "other"];
  return allowedPaymentMethods.includes(normalizedMethod) ? normalizedMethod : "other";
};

const createProduct = async (req, res) => {
  try {
    const { title, description, packageDetails = [], price, currency = "INR", isActive = true } = req.body;

    if (!title || !price) {
      return res.status(400).json({
        success: false,
        message: "title and price are required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "product image file is required",
      });
    }

    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "price must be a valid positive number",
      });
    }

    let normalizedPackageDetails = [];

    if (Array.isArray(packageDetails)) {
      normalizedPackageDetails = packageDetails.map((item) => String(item).trim()).filter(Boolean);
    } else if (typeof packageDetails === "string" && packageDetails.trim()) {
      try {
        const parsed = JSON.parse(packageDetails);
        if (Array.isArray(parsed)) {
          normalizedPackageDetails = parsed.map((item) => String(item).trim()).filter(Boolean);
        } else {
          normalizedPackageDetails = packageDetails
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        }
      } catch (parseError) {
        normalizedPackageDetails = packageDetails
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }

    const imageUrl = await uploadImageToImageKit({
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname,
      folder: "/products",
    });

    const normalizedIsActive =
      typeof isActive === "boolean"
        ? isActive
        : String(isActive).toLowerCase() !== "false";

    const product = await Product.create({
      title,
      description: description || "",
      imageUrl,
      packageDetails: normalizedPackageDetails,
      price: numericPrice,
      currency,
      isActive: normalizedIsActive,
    });

    return res.status(201).json({
      success: true,
      message: "Product created successfully",
      product,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getAllProducts = async (req, res) => {
  try {
    const onlyActive = String(req.query.onlyActive || "true") === "true";

    const filters = onlyActive ? { isActive: true } : {};

    const products = await Product.find(filters).sort({ createdAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      totalProducts: products.length,
      products,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getProductById = async (req, res) => {
  try {
    const { productId } = req.params;
    const includeInactive = String(req.query.includeInactive || "false") === "true";

    const filters = includeInactive
      ? { _id: productId }
      : { _id: productId, isActive: true };

    const product = await Product.findOne(filters).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      product,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const updateProductStatus = async (req, res) => {
  try {
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isActive must be boolean",
      });
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.productId,
      { isActive },
      { new: true, runValidators: true },
    );

    if (!updatedProduct) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product status updated successfully",
      product: updatedProduct,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const createDirectOrder = async (req, res) => {
  try {
    const razorpay = buildRazorpayClient();
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        message: "Razorpay credentials are missing on server",
      });
    }

    const { productId, quantity, customerName, customerEmail, customerPhone, address } = req.body;

    if (!productId || !quantity || !customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({
        success: false,
        message: "productId, quantity, customerName, customerEmail and customerPhone are required",
      });
    }

    if (!address || !address.street || !address.city || !address.state || !address.zipcode || !address.country) {
      return res.status(400).json({
        success: false,
        message: "address with street, city, state, zipcode, and country are required",
      });
    }

    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be a valid positive integer",
      });
    }

    const product = await Product.findOne({ _id: productId, isActive: true }).lean();
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Active product not found",
      });
    }

    const totalAmount = Number(product.price) * parsedQuantity;
    const amountInPaise = Math.round(totalAmount * 100);

    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      return res.status(400).json({
        success: false,
        message: "Unable to compute valid amount for order",
      });
    }

    const receipt = `order_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: product.currency || "INR",
      receipt,
      notes: {
        productId: String(product._id),
        quantity: String(parsedQuantity),
        userId: req.user?._id?.toString() || "",
      },
    });

    const orderExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const order = await DirectOrder.create({
      userId: req.user._id,
      productId: product._id,
      quantity: parsedQuantity,
      unitPrice: Number(product.price),
      amount: totalAmount,
      currency: product.currency || "INR",
      customerName,
      customerEmail,
      customerPhone,
      address: {
        street: String(address.street).trim(),
        city: String(address.city).trim(),
        state: String(address.state).trim(),
        zipcode: String(address.zipcode).trim(),
        country: String(address.country).trim(),
      },
      razorpayOrderId: razorpayOrder.id,
      paymentStatus: "pending",
      shippingStatus: "pending",
      shippingStatusUpdatedAt: new Date(),
      shippingHistory: [
        {
          status: "pending",
          changedAt: new Date(),
          changedByRole: "system",
          note: "Order created",
        },
      ],
      orderStatus: "pending",
      orderStatusUpdatedAt: new Date(),
      statusHistory: [
        {
          status: "pending",
          changedAt: new Date(),
          changedByRole: "system",
          note: "Order created",
        },
      ],
      orderExpiresAt,
    });

    // await sendOrderNotification({
    //   userId: req.user._id,
    //   title: "Order Successfully Created",
    //   notification: `Your order for ${product.title} x ${parsedQuantity} was created successfully`,
    //   details: `Order ID: ${order._id}. Pending payment. Razorpay Order ID: ${razorpayOrder.id}. Total: ${totalAmount}`,
    // });

    return res.status(201).json({
      success: true,
      message: "Direct order created. Complete payment to confirm booking",
      key: process.env.RAZORPAY_KEY_ID,
      product,
      order,
      razorpayOrder,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const verifyDirectOrderPayment = async (req, res) => {
  try {
    const razorpay = buildRazorpayClient();
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        message: "Razorpay credentials are missing on server",
      });
    }

    const {
      orderId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!orderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "orderId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
      });
    }

    const order = await DirectOrder.findOne({
      _id: orderId,
      userId: req.user._id,
      razorpayOrderId: razorpay_order_id,
    }).populate("productId", "title");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this user/orderId",
      });
    }

    if (order.orderStatus === "booked" && order.paymentStatus === "paid") {
      if ((!order.paymentMethod || order.paymentMethod === "other") && order.razorpayPaymentId) {
        try {
          const razorpayPayment = await razorpay.payments.fetch(order.razorpayPaymentId);
          const backfilledMethod = normalizePaymentMethod(
            razorpayPayment?.method || razorpayPayment?.vpa || razorpayPayment?.wallet,
          );
          if (backfilledMethod !== "other") {
            order.paymentMethod = backfilledMethod;
            await order.save();
          }
        } catch (error) {
          console.error("Error backfilling payment method:", error.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: "Order already confirmed",
        order,
      });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      order.paymentStatus = "failed";
      order.razorpayPaymentId = razorpay_payment_id;
      order.razorpaySignature = razorpay_signature;
      await order.save();

      await sendOrderNotification({
        userId: req.user._id,
        title: "Order Payment Failed",
        notification: `Payment verification failed for order ${order._id}`,
        details: `Razorpay Order ID: ${razorpay_order_id}`,
      });

      return res.status(400).json({
        success: false,
        message: "Payment signature verification failed",
      });
    }

    let paymentMethod = "other";
    try {
      const razorpayPayment = await razorpay.payments.fetch(razorpay_payment_id);
      paymentMethod = normalizePaymentMethod(
        razorpayPayment?.method || razorpayPayment?.vpa || razorpayPayment?.wallet,
      );
    } catch (paymentLookupError) {
      paymentMethod = "other";
      console.error("Error fetching Razorpay payment details:", paymentLookupError.message);
    }

    order.paymentStatus = "paid";
    order.paymentMethod = paymentMethod;
    order.orderStatus = "booked";
    order.orderStatusUpdatedAt = new Date();
    order.razorpayPaymentId = razorpay_payment_id;
    order.razorpaySignature = razorpay_signature;
    order.bookedAt = new Date();
    order.statusHistory.push({
      status: "booked",
      changedAt: new Date(),
      changedByRole: "user",
      changedById: String(req.user._id),
      note: "Payment verified successfully",
    });
    await order.save();

    await sendOrderNotification({
      userId: req.user._id,
      title: "Order Confirmed",
      notification: `Payment verified for order ${order._id}`,
      details: `Your order for ${order.productId?.title || "product"} is booked successfully. Payment method: ${order.paymentMethod}`,
    });

    return res.status(200).json({
      success: true,
      message: "Payment verified and order booked successfully",
      order,
      paymentMethod,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getMyDirectOrders = async (req, res) => {
  try {
    const orders = await DirectOrder.find({ userId: req.user._id })
      .populate("productId")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      totalOrders: orders.length,
      orders,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const updateDirectOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { orderStatus, note = "" } = req.body;

    const allowedStatuses = ["pending", "booked", "cancelled"];
    if (!allowedStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: "orderStatus must be one of pending, booked, cancelled",
      });
    }

    const order = await DirectOrder.findById(orderId).populate("productId", "title");
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const previousStatus = order.orderStatus;

    if (previousStatus !== orderStatus) {
      order.orderStatus = orderStatus;
      order.orderStatusUpdatedAt = new Date();
      order.statusHistory.push({
        status: orderStatus,
        changedAt: new Date(),
        changedByRole: "admin",
        changedById: String(req.user?._id || ""),
        note: String(note || "").trim(),
      });

      await order.save();
    }

    return res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      order,
      statusChange: {
        previousStatus,
        currentStatus: order.orderStatus,
        changedAt: order.orderStatusUpdatedAt,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const updateDirectOrderShippingStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { shippingStatus, note = "" } = req.body;

    const allowedShippingStatuses = [
      "not_required",
      "pending",
      "packed",
      "shipped",
      "out_for_delivery",
      "delivered",
      "returned",
      "cancelled",
    ];

    if (!allowedShippingStatuses.includes(shippingStatus)) {
      return res.status(400).json({
        success: false,
        message: "shippingStatus must be one of not_required, pending, packed, shipped, out_for_delivery, delivered, returned, cancelled",
      });
    }

    const order = await DirectOrder.findById(orderId).populate("productId", "title");
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const previousShippingStatus = order.shippingStatus;

    if (previousShippingStatus !== shippingStatus) {
      order.shippingStatus = shippingStatus;
      order.shippingStatusUpdatedAt = new Date();
      order.shippingHistory.push({
        status: shippingStatus,
        changedAt: new Date(),
        changedByRole: "admin",
        changedById: String(req.user?._id || ""),
        note: String(note || "").trim(),
      });

      await order.save();

      await sendOrderNotification({
        userId: order.userId,
        title: "Shipping Status Updated",
        notification: `Shipping status changed from ${previousShippingStatus} to ${shippingStatus}`,
        details: `Changed at: ${order.shippingStatusUpdatedAt.toISOString()}${note ? `. Note: ${note}` : ""}`,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Shipping status updated successfully",
      order,
      shippingStatusChange: {
        previousStatus: previousShippingStatus,
        currentStatus: order.shippingStatus,
        changedAt: order.shippingStatusUpdatedAt,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

export {
  createProduct,
  getAllProducts,
  getProductById,
  updateProductStatus,
  createDirectOrder,
  verifyDirectOrderPayment,
  getMyDirectOrders,
  updateDirectOrderStatus,
  updateDirectOrderShippingStatus,
};
