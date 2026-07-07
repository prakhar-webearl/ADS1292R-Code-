import crypto from "crypto";
import Razorpay from "razorpay";
import Plan from "../models/planModel.js";
import PlanPurchase from "../models/planPurchaseModel.js";
import Consultancy from "../models/consultancyModel.js";
import User from "../models/userModel.js";
import Notification from "../models/notificationModel.js";
import { emitNewNotification } from "../services/notificationSocket.js";
import { createAdminNotification } from "./adminNotification.Controller.js";

const parseNumber = (value, fallbackValue) => {
  if (value === undefined || value === null || value === "")
    return fallbackValue;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallbackValue : parsed;
};

const parseArrayInput = (value, fallbackValue = []) => {
  if (value === undefined || value === null || value === "")
    return fallbackValue;
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallbackValue;

    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : fallbackValue;
      } catch (error) {
        return fallbackValue;
      }
    }

    return trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return fallbackValue;
};

const calculateExpiry = (billingCycle, startsAt) => {
  if (billingCycle === "lifetime") return null;

  const expiry = new Date(startsAt);
  if (billingCycle === "yearly") {
    expiry.setFullYear(expiry.getFullYear() + 1);
  } else {
    expiry.setMonth(expiry.getMonth() + 1);
  }
  return expiry;
};

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

const generateReceipt = () =>
  `plan_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

const MS_IN_DAY = 1000 * 60 * 60 * 24;

const sendPlanNotification = async ({
  userId,
  title,
  notification,
  details,
}) => {
  try {
    const createdNotification = await Notification.create({
      title,
      notification,
      details: details || "",
      targetUserId: String(userId),
    });

    emitNewNotification(createdNotification);

    // Also notify admin about plan events
    await createAdminNotification({
      title: `Plan Event: ${title}`,
      desc: notification,
      type: "PAYMENT",
      category: title.toLowerCase().includes("failed") ? "CRITICAL" : "SUCCESS",
      metadata: { userId, details },
    });
  } catch (error) {
    console.error("Error sending plan notification:", error.message);
  }
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getDaysDiff = (startDate, endDate) => {
  if (!startDate || !endDate) return null;
  const diffMs = endDate.getTime() - startDate.getTime();
  return Math.max(0, Math.ceil(diffMs / MS_IN_DAY));
};

const addPurchaseValidityInfo = (purchase) => {
  const purchaseObj = purchase?.toObject ? purchase.toObject() : purchase;
  if (!purchaseObj) return purchaseObj;

  const now = new Date();
  const purchasedAt =
    toDateOrNull(purchaseObj.startsAt) ||
    toDateOrNull(purchaseObj.paymentVerifiedAt) ||
    toDateOrNull(purchaseObj.createdAt);
  const expiresAt = toDateOrNull(purchaseObj.expiresAt);
  const billingCycle =
    purchaseObj?.planSnapshot?.billingCycle ||
    purchaseObj?.planId?.billingCycle ||
    null;
  const isLifetime = !expiresAt && billingCycle === "lifetime";

  const validDays =
    expiresAt && purchasedAt ? getDaysDiff(purchasedAt, expiresAt) : null;
  const remainingDays = expiresAt ? getDaysDiff(now, expiresAt) : null;
  const isExpiredByDate = expiresAt
    ? now.getTime() > expiresAt.getTime()
    : false;
  const isExpiredByStatus = ["expired", "cancelled", "failed"].includes(
    purchaseObj.purchaseStatus,
  );

  purchaseObj.validity = {
    purchasedAt: purchasedAt ? purchasedAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    validDays,
    remainingDays,
    isLifetime,
    isExpired: isExpiredByDate || isExpiredByStatus,
    purchaseStatus: purchaseObj.purchaseStatus,
  };

  return purchaseObj;
};

const addConsultancyUsageInfo = async (purchase) => {
  const purchaseObj = addPurchaseValidityInfo(purchase);
  if (!purchaseObj) return purchaseObj;

  const userId = String(purchaseObj.userId?._id || purchaseObj.userId || "");

  const planLimit = Number(
    purchaseObj?.planSnapshot?.consultancyCount ??
      purchaseObj?.planId?.consultancyCount ??
      0,
  );

  const usedConsultancies = await Consultancy.countDocuments({
    userId,
    planPurchaseId: purchaseObj._id,
    bookingStatus: { $in: ["pending", "booked"] },
    paymentStatus: { $ne: "failed" },
  });

  const used = usedConsultancies;
  const remaining = planLimit > 0 ? Math.max(planLimit - usedConsultancies, 0) : null;

  purchaseObj.consultancyUsage = {
    limit: planLimit > 0 ? planLimit : null,
    used,
    remaining,
    isUnlimited: planLimit <= 0,
  };

  return purchaseObj;
};

const buildPlanPayload = (req, existingPlan = null) => {
  const body = req.body;
  const payload = {
    title: body.title ?? existingPlan?.title,
    category: body.category ?? existingPlan?.category,
    description: body.description ?? existingPlan?.description,
    duration_in_day: body.duration_in_day ?? existingPlan?.duration_in_day,
    planType: body.planType ?? existingPlan?.planType,
    iconType: body.iconType ?? existingPlan?.iconType,
    currency: body.currency ?? existingPlan?.currency,
    billingCycle: body.billingCycle ?? existingPlan?.billingCycle,
    consultancyCount: parseNumber(
      body.consultancyCount,
      existingPlan?.consultancyCount ?? 10,
    ),
  };

  payload.price = parseNumber(body.price, existingPlan?.price ?? 0);
  payload.sortOrder = parseNumber(body.sortOrder, existingPlan?.sortOrder ?? 0);

  if (body.features !== undefined) {
    payload.features = parseArrayInput(
      body.features,
      existingPlan?.features ?? [],
    );
  } else if (!existingPlan) {
    payload.features = [];
  }

  if (body.schedule !== undefined) {
    payload.schedule = parseArrayInput(
      body.schedule,
      existingPlan?.schedule ?? [],
    );
  } else if (!existingPlan) {
    payload.schedule = [];
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive === "string") {
      payload.isActive = body.isActive === "true";
    } else {
      payload.isActive = Boolean(body.isActive);
    }
  } else if (!existingPlan) {
    payload.isActive = true;
  }

  return payload;
};

const syncUserSubscription = async (userId, purchase = null) => {
  if (!purchase) {
    await User.findByIdAndUpdate(userId, {
      subscription: {
        planId: null,
        purchaseId: null,
        status: "inactive",
        startedAt: null,
        expiresAt: null,
      },
    });
    return;
  }

  const status = purchase.purchaseStatus === "pending" ? "inactive" : "active";

  await User.findByIdAndUpdate(userId, {
    subscription: {
      planId: purchase.planId,
      purchaseId: purchase._id,
      status,
      startedAt: purchase.startsAt,
      expiresAt: purchase.expiresAt,
    },
  });
};

const createPlan = async (req, res) => {
  try {
    const payload = buildPlanPayload(req);

    if (!payload.title || !payload.description) {
      return res.status(400).json({
        success: false,
        message: "title and description are required",
      });
    }

    const createdPlan = await Plan.create(payload);
    return res.status(201).json({
      success: true,
      message: "Plan created successfully",
      plan: createdPlan,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Create failed",
      error: error.message,
    });
  }
};

const updatePlan = async (req, res) => {
  try {
    const existingPlan = await Plan.findById(req.params.id);
    if (!existingPlan) {
      return res.status(404).json({
        success: false,
        message: "Plan not found",
      });
    }

    const updates = buildPlanPayload(req, existingPlan);

    const updatedPlan = await Plan.findByIdAndUpdate(req.params.id, updates, {
      returnDocument: "after",
      runValidators: true,
    });

    return res.status(200).json({
      success: true,
      message: "Plan updated successfully",
      plan: updatedPlan,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Update failed",
      error: error.message,
    });
  }
};

const getAdminPlans = async (req, res) => {
  try {
    const filter = {};

    if (req.query.planType) {
      filter.planType = req.query.planType;
    }

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === "true";
    }

    const plans = await Plan.find(filter).sort({ sortOrder: 1, createdAt: -1 });
    const mappedPlans = plans.map((planDoc) => {
      const plan = planDoc.toObject();
      const isUnlimited = Number(plan.price || 0) > 0;
      return {
        ...plan,
        consultancyPolicy: {
          isUnlimited,
          limit: isUnlimited ? null : Number(plan.consultancyCount || 0),
        },
      };
    });

    return res.status(200).json({
      success: true,
      message: "Plans fetched successfully",
      totalPlans: mappedPlans.length,
      plans: mappedPlans,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Read all failed",
      error: error.message,
    });
  }
};

const getUserPlans = async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.planType) {
      filter.planType = req.query.planType;
    }

    const plans = await Plan.find(filter).sort({ sortOrder: 1, createdAt: -1 });
    const mappedPlans = plans.map((planDoc) => {
      const plan = planDoc.toObject();
      const isUnlimited = Number(plan.price || 0) > 0;
      return {
        ...plan,
        consultancyPolicy: {
          isUnlimited,
          limit: isUnlimited ? null : Number(plan.consultancyCount || 0),
        },
      };
    });

    return res.status(200).json({
      success: true,
      message: "Active plans fetched successfully",
      totalPlans: mappedPlans.length,
      plans: mappedPlans,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Read all failed",
      error: error.message,
    });
  }
};

const getAdminPlanById = async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) {
      return res
        .status(404)
        .json({ success: false, message: "Plan not found" });
    }

    return res.status(200).json({
      success: true,
      plan,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Read one failed",
      error: error.message,
    });
  }
};

const getUserPlanById = async (req, res) => {
  try {
    const plan = await Plan.findOne({ _id: req.params.id, isActive: true });
    if (!plan) {
      return res
        .status(404)
        .json({ success: false, message: "Plan not found" });
    }

    return res.status(200).json({
      success: true,
      plan,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Read one failed",
      error: error.message,
    });
  }
};

const deletePlan = async (req, res) => {
  try {
    const deletedPlan = await Plan.findByIdAndDelete(req.params.id);
    if (!deletedPlan) {
      return res
        .status(404)
        .json({ success: false, message: "Plan not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Plan deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Delete failed",
      error: error.message,
    });
  }
};

const planStatusUpdate = async (req, res) => {
  try {
    const { isActive } = req.body;

    const updatePayload = {};

    if (isActive !== undefined) {
      updatePayload.isActive =
        typeof isActive === "string" ? isActive === "true" : Boolean(isActive);
    }

    const plan = await Plan.findByIdAndUpdate(req.params.id, updatePayload, {
      returnDocument: "after",
    });

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Plan not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Plan active status updated successfully",
      plan,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update plan status",
      error: error.message,
    });
  }
};

const purchasePlan = async (req, res) => {
  try {
    const {
      planId,
      amount,
      currency,
      paymentMethod,
      transactionId,
      startsAt,
      expiresAt,
      notes,
    } = req.body;

    if (!planId) {
      return res
        .status(400)
        .json({ success: false, message: "planId is required" });
    }

    const plan = await Plan.findById(planId);
    if (!plan || !plan.isActive) {
      return res
        .status(404)
        .json({ success: false, message: "Plan not found or inactive" });
    }

    const startDate = startsAt ? new Date(startsAt) : new Date();
    if (Number.isNaN(startDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid startsAt" });
    }

    const expiryDate = expiresAt
      ? new Date(expiresAt)
      : calculateExpiry(plan.billingCycle, startDate);

    if (expiryDate && Number.isNaN(expiryDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid expiresAt" });
    }

    const finalAmount = parseNumber(amount, plan.price || 0);
    if (finalAmount < 0) {
      return res
        .status(400)
        .json({ success: false, message: "amount cannot be negative" });
    }

    if (finalAmount > 0 && paymentMethod !== "manual") {
      return res.status(400).json({
        success: false,
        message: "For paid plans, use create-order and verify-payment APIs",
      });
    }

    await PlanPurchase.updateMany(
      { userId: req.user._id, isCurrent: true },
      { $set: { isCurrent: false, purchaseStatus: "inactive" } },
    );

    const purchase = await PlanPurchase.create({
      userId: req.user._id,
      planId: plan._id,
      planSnapshot: {
        title: plan.title,
        price: plan.price,
        currency: plan.currency,
        billingCycle: plan.billingCycle,
        features: plan.features,
        consultancyCount: plan.consultancyCount,
      },
      // Track remaining consultancy credits separately from the immutable snapshot
      amount: finalAmount,
      currency: currency || plan.currency || "INR",
      paymentMethod: paymentMethod || "none",
      transactionId: transactionId || "",
      purchaseStatus: "active",
      isCurrent: true,
      startsAt: startDate,
      expiresAt: expiryDate,
      notes: notes || "",
    });

    await syncUserSubscription(req.user._id, purchase);

    return res.status(201).json({
      success: true,
      message: "Plan purchased successfully",
      purchase: await addConsultancyUsageInfo(purchase),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Purchase failed",
      error: error.message,
    });
  }
};

const createPlanPurchaseOrder = async (req, res) => {
  try {
    const { planId, currency, notes } = req.body;

    if (!planId) {
      return res
        .status(400)
        .json({ success: false, message: "planId is required" });
    }

    const plan = await Plan.findById(planId);
    if (!plan || !plan.isActive) {
      return res
        .status(404)
        .json({ success: false, message: "Plan not found or inactive" });
    }

    const finalAmount = Number(plan.price || 0);
    if (!Number.isFinite(finalAmount) || finalAmount < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid plan price" });
    }

    const now = new Date();

    if (finalAmount === 0) {
      await PlanPurchase.updateMany(
        { userId: req.user._id, isCurrent: true },
        { $set: { isCurrent: false, purchaseStatus: "inactive" } },
      );

      const freePurchase = await PlanPurchase.create({
        userId: req.user._id,
        planId: plan._id,
        planSnapshot: {
          title: plan.title,
          price: plan.price,
          currency: plan.currency,
          billingCycle: plan.billingCycle,
          features: plan.features,
          consultancyCount: plan.consultancyCount,
        },
        amount: 0,
        currency: plan.currency || "INR",
        paymentMethod: "none",
        purchaseStatus: "active",
        isCurrent: true,
        startsAt: now,
        expiresAt: calculateExpiry(plan.billingCycle, now),
        notes: notes || "",
      });

      await syncUserSubscription(req.user._id, freePurchase);

      await sendPlanNotification({
        userId: req.user._id,
        title: "Plan Activated",
        notification: `${plan.title} has been activated successfully`,
        details: `Your free plan is now active${freePurchase.expiresAt ? ` until ${freePurchase.expiresAt.toISOString()}` : ""}`,
      });

      return res.status(201).json({
        success: true,
        message: "Free plan activated successfully",
        purchase: await addConsultancyUsageInfo(freePurchase),
      });
    }

    const razorpay = buildRazorpayClient();
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        message: "Razorpay credentials are missing on server",
      });
    }

    const selectedCurrency = (currency || plan.currency || "INR").toUpperCase();
    const amountInPaise = Math.round(finalAmount * 100);

    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment amount" });
    }

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: selectedCurrency,
      receipt: generateReceipt(),
      notes: {
        planId: String(plan._id),
        userId: String(req.user._id),
      },
    });

    const purchase = await PlanPurchase.create({
      userId: req.user._id,
      planId: plan._id,
      planSnapshot: {
        title: plan.title,
        price: plan.price,
        currency: plan.currency,
        billingCycle: plan.billingCycle,
        features: plan.features,
        consultancyCount: plan.consultancyCount,
      },
      amount: finalAmount,
      currency: selectedCurrency,
      paymentMethod: "razorpay",
      razorpayOrderId: order.id,
      purchaseStatus: "pending",
      isCurrent: false,
      startsAt: null,
      expiresAt: null,
      orderExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      notes: notes || "",
    });

    return res.status(201).json({
      success: true,
      message: "Razorpay order created. Complete payment to activate plan",
      key: process.env.RAZORPAY_KEY_ID,
      order,
      purchase,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create plan purchase order",
      error: error.message,
    });
  }
};

const verifyPlanPurchasePayment = async (req, res) => {
  try {
    const {
      purchaseId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !purchaseId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        message:
          "purchaseId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
      });
    }

    const purchase = await PlanPurchase.findOne({
      _id: purchaseId,
      userId: req.user._id,
      razorpayOrderId: razorpay_order_id,
    }).populate("planId");

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase order not found",
      });
    }

    if (
      purchase.purchaseStatus === "active" &&
      purchase.razorpayPaymentId === razorpay_payment_id
    ) {
      return res.status(200).json({
        success: true,
        message: "Payment already verified",
        purchase,
      });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      purchase.purchaseStatus = "failed";
      purchase.transactionId = razorpay_payment_id;
      purchase.razorpayPaymentId = razorpay_payment_id;
      purchase.razorpaySignature = razorpay_signature;
      await purchase.save();

      return res.status(400).json({
        success: false,
        message: "Payment signature verification failed",
      });
    }

    await PlanPurchase.updateMany(
      { userId: req.user._id, _id: { $ne: purchase._id }, isCurrent: true },
      { $set: { isCurrent: false, purchaseStatus: "inactive" } },
    );

    const now = new Date();
    const billingCycle =
      purchase?.planSnapshot?.billingCycle ||
      purchase?.planId?.billingCycle ||
      "monthly";

    purchase.purchaseStatus = "active";
    purchase.isCurrent = true;
    purchase.paymentMethod = "razorpay";
    purchase.transactionId = razorpay_payment_id;
    purchase.razorpayPaymentId = razorpay_payment_id;
    purchase.razorpaySignature = razorpay_signature;
    purchase.paymentVerifiedAt = now;
    purchase.startsAt = now;
    purchase.expiresAt = calculateExpiry(billingCycle, now);

    await purchase.save();
    await syncUserSubscription(req.user._id, purchase);

    await sendPlanNotification({
      userId: req.user._id,
      title: "Plan Purchased Successfully",
      notification: `${purchase.planSnapshot?.title || "Plan"} purchased successfully`,
      details: `Payment ID: ${razorpay_payment_id}`,
    });

    return res.status(200).json({
      success: true,
      message: "Payment verified and plan activated successfully",
      purchase: await addConsultancyUsageInfo(purchase),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to verify plan payment",
      error: error.message,
    });
  }
};

const getMyPlanPurchases = async (req, res) => {
  try {
    const purchases = await PlanPurchase.find({ userId: req.user._id })
      .populate(
        "planId",
        "title planType iconType price currency billingCycle features isActive",
      )
      .sort({ createdAt: -1 });

    const mappedPurchases = await Promise.all(
      purchases.map((purchase) => addConsultancyUsageInfo(purchase)),
    );

    return res.status(200).json({
      success: true,
      totalPurchases: mappedPurchases.length,
      purchases: mappedPurchases,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchases",
      error: error.message,
    });
  }
};

const getMyCurrentPlan = async (req, res) => {
  try {
    const currentPurchase = await PlanPurchase.findOne({
      userId: req.user._id,
      isCurrent: true,
      purchaseStatus: { $in: ["pending", "active"] },
    })
      .populate(
        "planId",
        "title planType iconType price currency billingCycle features isActive",
      )
      .sort({ createdAt: -1 });

    if (!currentPurchase) {
      return res.status(200).json({
        success: true,
        message: "No active plan found",
        currentPlan: null,
      });
    }

    const currentPlan = await addConsultancyUsageInfo(currentPurchase);

    return res.status(200).json({
      success: true,
      currentPlan,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch current plan",
      error: error.message,
    });
  }
};

const getAllPlanPurchases = async (req, res) => {
  try {
    const filter = {};

    if (req.query.userId) {
      filter.userId = req.query.userId;
    }
    if (req.query.planId) {
      filter.planId = req.query.planId;
    }
    if (req.query.purchaseStatus) {
      filter.purchaseStatus = req.query.purchaseStatus;
    }
    if (req.query.isCurrent !== undefined) {
      filter.isCurrent = req.query.isCurrent === "true";
    }

    const purchases = await PlanPurchase.find(filter)
      .populate("userId", "full_name email phoneNumber")
      .populate("planId", "title planType iconType price currency billingCycle")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      totalPurchases: purchases.length,
      purchases: await Promise.all(
        purchases.map((purchase) => addConsultancyUsageInfo(purchase)),
      ),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchases",
      error: error.message,
    });
  }
};

const getPlanPurchaseById = async (req, res) => {
  try {
    const purchase = await PlanPurchase.findById(req.params.id)
      .populate("userId", "full_name email phoneNumber")
      .populate(
        "planId",
        "title planType iconType price currency billingCycle features isActive",
      );

    if (!purchase) {
      return res
        .status(404)
        .json({ success: false, message: "Purchase not found" });
    }

    const purchaseObj = await addConsultancyUsageInfo(purchase);

    return res.status(200).json({ success: true, purchase: purchaseObj });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase",
      error: error.message,
    });
  }
};

const updatePlanPurchaseStatus = async (req, res) => {
  try {
    const { purchaseStatus, isCurrent, expiresAt, notes } = req.body;

    const purchase = await PlanPurchase.findById(req.params.id);
    if (!purchase) {
      return res
        .status(404)
        .json({ success: false, message: "Purchase not found" });
    }

    if (purchaseStatus !== undefined) {
      const allowedStatus = [
        "pending",
        "active",
        "expired",
        "cancelled",
        "failed",
      ];
      if (!allowedStatus.includes(purchaseStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid purchaseStatus",
        });
      }
      purchase.purchaseStatus = purchaseStatus;
    }

    if (isCurrent !== undefined) {
      purchase.isCurrent =
        typeof isCurrent === "string"
          ? isCurrent === "true"
          : Boolean(isCurrent);
    }

    if (expiresAt !== undefined) {
      if (!expiresAt) {
        purchase.expiresAt = null;
      } else {
        const parsedDate = new Date(expiresAt);
        if (Number.isNaN(parsedDate.getTime())) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid expiresAt" });
        }
        purchase.expiresAt = parsedDate;
      }
    }

    if (notes !== undefined) {
      purchase.notes = notes;
    }

    if (purchase.isCurrent) {
        await PlanPurchase.updateMany(
        {
          userId: purchase.userId,
          _id: { $ne: purchase._id },
          isCurrent: true,
        },
        { $set: { isCurrent: false, purchaseStatus: "inactive" } },
      );
    }

    if (["expired", "cancelled", "failed"].includes(purchase.purchaseStatus)) {
      purchase.isCurrent = false;
    }

    await purchase.save();

    const latestCurrent = await PlanPurchase.findOne({
      userId: purchase.userId,
      isCurrent: true,
      purchaseStatus: { $in: ["pending", "active"] },
    }).sort({ createdAt: -1 });

    if (latestCurrent) {
      await syncUserSubscription(purchase.userId, latestCurrent);
    } else {
      await syncUserSubscription(purchase.userId, null);
    }

    if (purchase.purchaseStatus === "cancelled") {
      await sendPlanNotification({
        userId: purchase.userId,
        title: "Plan Purchase Cancelled",
        notification: `${purchase.planSnapshot?.title || "Plan"} has been cancelled`,
        details: notes || "Your plan purchase has been cancelled by admin.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Purchase updated successfully",
      purchase: await addConsultancyUsageInfo(purchase),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update purchase",
      error: error.message,
    });
  }
};

const getAllPlans = getAdminPlans;
const getPlanById = getAdminPlanById;

const getDoctorPatientCurrentPlan = async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId query parameter is required",
      });
    }

    const currentPurchase = await PlanPurchase.findOne({
      userId,
      isCurrent: true,
      purchaseStatus: { $in: ["pending", "active"] },
    })
      .populate(
        "planId",
        "title planType iconType price currency billingCycle features consultancyCount isActive",
      )
      .sort({ createdAt: -1 });

    if (!currentPurchase) {
      return res.status(200).json({
        success: true,
        message: "No active plan found for this patient",
        currentPlan: null,
      });
    }

    const currentPlan = await addConsultancyUsageInfo(currentPurchase);

    return res.status(200).json({
      success: true,
      message: "Patient current plan fetched successfully",
      currentPlan,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch patient plan",
      error: error.message,
    });
  }
};

export {
  createPlan,
  updatePlan,
  deletePlan,
  planStatusUpdate,
  getAllPlans,
  getPlanById,
  getAdminPlans,
  getAdminPlanById,
  getUserPlans,
  getUserPlanById,
  purchasePlan,
  createPlanPurchaseOrder,
  verifyPlanPurchasePayment,
  getMyPlanPurchases,
  getMyCurrentPlan,
  getAllPlanPurchases,
  getPlanPurchaseById,
  updatePlanPurchaseStatus,
  getDoctorPatientCurrentPlan,
  addConsultancyUsageInfo,
};

