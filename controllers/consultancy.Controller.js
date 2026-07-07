import crypto from "crypto";
import Razorpay from "razorpay";
import Consultancy from "../models/consultancyModel.js";
import Doctor from "../models/doctorModel.js";
import AppAdmin from "../models/appAdminModel.js";
import PlanPurchase from "../models/planPurchaseModel.js";
import Notification from "../models/notificationModel.js";
import { emitNewNotification } from "../services/notificationSocket.js";
import { createAdminNotification } from "./adminNotification.Controller.js";
import AddedUser from "../models/userAddModel.js";

const parseDateOnly = (dateStr) => {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }

  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
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

const sendConsultancyNotification = async ({
  userId,
  title,
  notification,
  details,
}) => {
  try {
    const createdNotification = await Notification.create({
      title,
      notification,
      details,
      targetUserId: String(userId),
    });

    emitNewNotification(createdNotification);

    // Also notify admin
    await createAdminNotification({
      title: `Consultancy Event: ${title}`,
      desc: notification,
      type: "ALERT",
      category: title.toLowerCase().includes("failed") ? "CRITICAL" : "SUCCESS",
      metadata: { userId, details }
    });
  } catch (notificationError) {
    console.error("Error sending consultancy notification:", notificationError.message);
  }
};

const getActiveConsultancyPlanForUser = async (userId) => {
  const currentPurchase = await PlanPurchase.findOne({
    userId,
    isCurrent: true,
    purchaseStatus: { $in: ["pending", "active"] },
  })
    .populate("planId", "consultancyCount billingCycle title planType isActive price")
    .sort({ createdAt: -1 });

  if (!currentPurchase) {
    return null;
  }

  const planLimit = Number(
    currentPurchase?.planSnapshot?.consultancyCount ?? currentPurchase?.planId?.consultancyCount ?? 0,
  );
  const planPrice = Number(
    currentPurchase?.planSnapshot?.price ?? currentPurchase?.planId?.price ?? 0,
  );

  // All plans enforce consultancyCount quota
  const isUnlimitedPlan = planLimit <= 0;
  const isFreeplan = planPrice === 0;

  const usedConsultancies = await Consultancy.countDocuments({
    userId,
    planPurchaseId: currentPurchase._id,
    bookingStatus: { $in: ["pending", "booked"] },
    paymentStatus: { $ne: "failed" },
  });

  return {
    purchase: currentPurchase,
    planLimit,
    isUnlimitedPlan,
    isFreeplan,
    planPrice,
    usedConsultancies,
    remainingConsultancies: isUnlimitedPlan ? null : Math.max(planLimit - usedConsultancies, 0),
  };
};

const createConsultancyOrder = async (req, res) => {
  try {
    const {
      consultationDate,
      timeSlot,
      consultationDurationMinutes = 15,
      consultationLanguage,
      monitorId,
      amount,
      currency = "INR",
      full_name,
      email,
      phoneNumber,
      notes,
      memberId,
      memberName,
      memberRelation,
      payIfNoFree = false,
    } = req.body;

    const bookingUserId = req.user?._id;

    if (
      !bookingUserId ||
      !consultationDate ||
      !timeSlot ||
      !consultationLanguage ||
      !monitorId ||
      !full_name ||
      !email ||
      !phoneNumber
    ) {
      return res.status(400).json({
        success: false,
        message:
          "consultationDate, timeSlot, consultationLanguage, monitorId, full_name, email and phoneNumber are required",
      });
    }

    const parsedDuration = Number(consultationDurationMinutes);

    const planQuota = await getActiveConsultancyPlanForUser(bookingUserId);
    if (!planQuota || !planQuota.purchase) {
      return res.status(403).json({
        success: false,
        message: "No active plan found. Please purchase a plan before booking consultancy.",
      });
    }

    if (!planQuota.isUnlimitedPlan && planQuota.planLimit <= 0) {
      return res.status(403).json({
        success: false,
        message: "Your current plan does not allow consultancy bookings.",
      });
    }

    let planPurchaseIdToAttach = planQuota.purchase?._id || null;
    let isPaidFallback = false;

    if (!planQuota.isUnlimitedPlan && planQuota.remainingConsultancies <= 0) {
      if (!payIfNoFree) {
        return res.status(403).json({
          success: false,
          message: "Your current plan consultancy limit has been reached.",
          planLimit: planQuota.planLimit,
          usedConsultancies: planQuota.usedConsultancies,
          remainingConsultancies: planQuota.remainingConsultancies,
          hint: planQuota.isFreeplan ? "Set `payIfNoFree=true` and provide an `amount` to pay for this single consultancy." : "Please purchase more consultancies or upgrade your plan.",
        });
      }

      // User opted to pay for this consultancy despite quota exhaustion.
      isPaidFallback = true;
      planPurchaseIdToAttach = null;
    }

    // If a memberId is provided, verify it belongs to the booking user
    let resolvedMemberId = null;
    let resolvedMemberName = String(memberName || "").trim();
    let resolvedMemberRelation = String(memberRelation || "").trim();

    if (memberId) {
      const member = await AddedUser.findById(memberId).lean();
      if (!member) {
        return res.status(400).json({
          success: false,
          message: "Provided memberId does not exist",
        });
      }

      // Only allow booking a member that was added by the booking user
      if (String(member.createdBy) !== String(bookingUserId)) {
        return res.status(403).json({
          success: false,
          message: "Member does not belong to the booking user",
        });
      }

      resolvedMemberId = member._id;
      resolvedMemberName = member.full_name || resolvedMemberName;
      resolvedMemberRelation = member.relation || resolvedMemberRelation;
    }

    const selectedDate = parseDateOnly(consultationDate);
    if (!selectedDate) {
      return res.status(400).json({
        success: false,
        message: "consultationDate must be in YYYY-MM-DD format",
      });
    }

    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    if (selectedDate < todayUtc) {
      return res.status(400).json({
        success: false,
        message: "consultationDate cannot be in the past",
      });
    }

    const nextDate = new Date(selectedDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);

    const isBooked = await Consultancy.findOne({
      consultationDate: { $gte: selectedDate, $lt: nextDate },
      timeSlot,
      bookingStatus: "booked",
    }).lean();

    if (isBooked) {
      return res.status(409).json({
        success: false,
        message: "Selected slot is already booked",
      });
    }

    const planUsage = {
      isUnlimited: planQuota.isUnlimitedPlan,
      limit: planQuota.isUnlimitedPlan ? null : planQuota.planLimit,
      used: planQuota.usedConsultancies,
      remaining: planQuota.isUnlimitedPlan ? null : planQuota.remainingConsultancies,
    };

    // Any booking within quota is free. Only quota-exhausted payIfNoFree requests use Razorpay.
    if (!isPaidFallback) {
      const freeReference = `free_consult_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

      const booking = await Consultancy.create({
        userId: bookingUserId,
        full_name,
        email,
        phoneNumber,
        consultationDate: selectedDate,
        timeSlot,
        consultationDurationMinutes: parsedDuration,
        consultationLanguage,
        monitorId: String(monitorId).trim(),
        planPurchaseId: planQuota.purchase._id,
        amount: 0,
        currency,
        razorpayOrderId: freeReference,
        paymentStatus: "paid",
        bookingStatus: "booked",
        orderExpiresAt: new Date(),
        bookedAt: new Date(),
        notes: notes || "",
        memberId: resolvedMemberId,
        memberName: resolvedMemberName,
        memberRelation: resolvedMemberRelation,
      });

      await sendConsultancyNotification({
        userId: bookingUserId,
        title: "Consultancy Booked Successfully",
        notification: `Free consultancy booked for ${timeSlot}`,
        details: `Date: ${consultationDate}, Duration: ${parsedDuration} minutes`,
      });

      return res.status(201).json({
        success: true,
        message: "Free plan consultancy booked successfully",
        booking,
        planUsage,
      });
    }

    // Paid fallback: require a positive amount from the client.
    const finalAmount = Number(amount);

    const amountInPaise = Math.round(finalAmount * 100);
    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a valid positive number for paid plans",
      });
    }

    const razorpay = buildRazorpayClient();
    if (!razorpay) {
      return res.status(500).json({
        success: false,
        message: "Razorpay credentials are missing on server",
      });
    }

    const receipt = `consult_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency,
      receipt,
      notes: {
        consultationDate,
        timeSlot,
        consultationDurationMinutes: String(parsedDuration),
        consultationLanguage,
        monitorId,
        userId: String(bookingUserId || ""),
        planPurchaseId: String(planPurchaseIdToAttach || ""),
        memberName: resolvedMemberName,
        memberId: String(resolvedMemberId || ""),
      },
    });

    const orderExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const booking = await Consultancy.create({
      userId: bookingUserId,
      full_name,
      email,
      phoneNumber,
      consultationDate: selectedDate,
      timeSlot,
      consultationDurationMinutes: parsedDuration,
      consultationLanguage,
      monitorId: String(monitorId).trim(),
      planPurchaseId: planPurchaseIdToAttach,
      amount: finalAmount,
      currency,
      razorpayOrderId: order.id,
      paymentStatus: "pending",
      bookingStatus: "pending",
      orderExpiresAt,
      notes: notes || "",
      memberId: resolvedMemberId,
      memberName: resolvedMemberName,
      memberRelation: resolvedMemberRelation,
    });

    return res.status(201).json({
      success: true,
      message: "Razorpay order created. Complete payment to confirm booking",
      key: process.env.RAZORPAY_KEY_ID,
      booking,
      order,
      planUsage,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const verifyConsultancyPayment = async (req, res) => {
  try {
    const {
      bookingId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    const authenticatedUserId = req.user?._id;

    if (
      !bookingId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !authenticatedUserId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "bookingId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
      });
    }

    const booking = await Consultancy.findOne({
      _id: bookingId,
      userId: authenticatedUserId,
      razorpayOrderId: razorpay_order_id,
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found for this order",
      });
    }

    if (booking.bookingStatus === "booked" && booking.paymentStatus === "paid") {
      await sendConsultancyNotification({
        userId: authenticatedUserId,
        title: "Consultancy Already Confirmed",
        notification: `Booking already confirmed for ${booking.timeSlot}`,
        details: `Date: ${booking.consultationDate.toISOString().slice(0, 10)}`,
      });

      return res.status(200).json({
        success: true,
        message: "Booking already confirmed",
        booking,
      });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      booking.paymentStatus = "failed";
      booking.razorpayPaymentId = razorpay_payment_id;
      booking.razorpaySignature = razorpay_signature;
      await booking.save();

      await sendConsultancyNotification({
        userId: req.user._id,
        title: "Consultancy Payment Failed",
        notification: `Payment verification failed for ${booking.timeSlot}`,
        details: `Order ID: ${razorpay_order_id}`,
      });

      return res.status(400).json({
        success: false,
        message: "Payment signature verification failed",
      });
    }

    const nextDate = new Date(booking.consultationDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);

    const conflictBooking = await Consultancy.findOne({
      _id: { $ne: booking._id },
      consultationDate: { $gte: booking.consultationDate, $lt: nextDate },
      timeSlot: booking.timeSlot,
      bookingStatus: "booked",
    }).lean();

    if (conflictBooking) {
      booking.paymentStatus = "paid";
      booking.bookingStatus = "cancelled";
      booking.razorpayPaymentId = razorpay_payment_id;
      booking.razorpaySignature = razorpay_signature;
      await booking.save();

      await sendConsultancyNotification({
        userId: authenticatedUserId,
        title: "Consultancy Slot Unavailable",
        notification: "Payment received but selected slot became unavailable",
        details: "Please contact support/admin for refund processing",
      });

      return res.status(409).json({
        success: false,
        message:
          "Payment captured but slot became unavailable. Please initiate refund from admin side.",
        booking,
      });
    }

    booking.paymentStatus = "paid";
    booking.bookingStatus = "booked";
    booking.razorpayPaymentId = razorpay_payment_id;
    booking.razorpaySignature = razorpay_signature;
    booking.bookedAt = new Date();
    await booking.save();

    await sendConsultancyNotification({
      userId: req.user._id,
      title: "Consultancy Booked Successfully",
      notification: `Payment verified for ${booking.timeSlot}`,
      details: `Your booking for ${booking.consultationDate.toISOString().slice(0, 10)} is confirmed`,
    });

    return res.status(200).json({
      success: true,
      message: "Payment verified and consultancy booked successfully",
      booking,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getMyConsultancyBookings = async (req, res) => {
  try {
    const bookings = await Consultancy.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      totalBookings: bookings.length,
      bookings,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getConsultancyDetailsById = async (req, res) => {
  try {
    const consultancyId = req.params.consultancyId || req.params.id;

    if (!consultancyId) {
      return res.status(400).json({
        success: false,
        message: "consultancyId is required",
      });
    }

    const booking = await Consultancy.findById(consultancyId)
      .populate("userId", "full_name email phoneNumber dob gender weight height status")
      .populate("memberId", "full_name relation age gender weight height createdBy")
      .populate("doctorId", "full_name email phoneNumber specialization experienceYears qualification clinicAddress bio status approvalStatus")
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Consultancy booking not found",
      });
    }

    const isAdmin = Boolean(req.user?._id && await AppAdmin.findById(req.user._id).lean());
    const isDoctor = Boolean(req.doctor?._id);
    const isUser = Boolean(req.user?._id) && !isAdmin;

    if (isDoctor && String(booking.doctorId?._id || booking.doctorId) !== String(req.doctor._id)) {
      return res.status(403).json({
        success: false,
        message: "You can view only your assigned consultancy details",
      });
    }

    if (isUser && String(booking.userId?._id || booking.userId) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: "You can view only your own consultancy details",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Consultancy details fetched successfully",
      consultancy: booking,
      summary: {
        consultancyId: booking._id,
        user: booking.userId,
        member: booking.memberId || {
          _id: booking.memberId,
          full_name: booking.memberName,
          relation: booking.memberRelation,
        },
        doctor: booking.doctorId,
        consultationDate: booking.consultationDate,
        timeSlot: booking.timeSlot,
        consultationLanguage: booking.consultationLanguage,
        monitorId: booking.monitorId,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        doctorAssignmentStatus: booking.doctorAssignmentStatus,
        doctorAssignedAt: booking.doctorAssignedAt,
        doctorRespondedAt: booking.doctorRespondedAt,
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

const getAllConsultancyBookingsForAdmin = async (req, res) => {
  try {
    const bookings = await Consultancy.find({})
      .populate("userId", "full_name email phoneNumber status")
      .populate("memberId", "full_name relation age gender weight height")
      .populate("doctorId", "full_name email specialization")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "All consultancy bookings fetched successfully",
      totalBookings: bookings.length,
      bookings,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const assignDoctorToConsultancy = async (req, res) => {
  try {
    const { consultancyId, doctorId } = req.body;

    if (!consultancyId || !doctorId) {
      return res.status(400).json({
        success: false,
        message: "consultancyId and doctorId are required",
      });
    }

    const booking = await Consultancy.findById(consultancyId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Consultancy booking not found",
      });
    }

    if (booking.bookingStatus !== "booked" || booking.paymentStatus !== "paid") {
      return res.status(400).json({
        success: false,
        message: "Can only assign doctor to confirmed bookings (paid and booked status)",
      });
    }

    if (booking.doctorAssignmentStatus === "approved") {
      return res.status(400).json({
        success: false,
        message: "Doctor already approved this consultancy. Reassignment is not allowed.",
      });
    }

    const doctor = await Doctor.findOne({
      _id: doctorId,
      status: "active",
      approvalStatus: "approved",
    }).lean();

    if (!doctor) {
      return res.status(404).json({
        success: false,
        message: "Doctor not found or doctor is not active/approved",
      });
    }

    booking.doctorId = doctorId;
    booking.doctorAssignedAt = new Date();
    booking.doctorAssignmentStatus = "pending";
    booking.doctorRespondedAt = null;
    booking.doctorRejectionReason = "";
    await booking.save();

    const updatedBooking = await Consultancy.findById(consultancyId)
      .populate("userId", "full_name email phoneNumber")
      .populate("memberId", "full_name relation age gender weight height")
      .populate("doctorId", "full_name email specialization")
      .lean();

    return res.status(200).json({
      success: true,
      message: "Doctor assigned successfully",
      booking: updatedBooking,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getDoctorConsultancies = async (req, res) => {
  try {
    if (!req.doctor || !req.doctor._id) {
      return res.status(401).json({
        success: false,
        message: "Doctor not authenticated",
      });
    }

    const doctorId = req.doctor._id;
    const assignmentStatus = String(req.query.assignmentStatus || "all").trim().toLowerCase();

    const query = {
      doctorId,
      bookingStatus: "booked",
      paymentStatus: "paid",
    };

    if (assignmentStatus === "approved") {
      query.doctorAssignmentStatus = "approved";
    } else if (assignmentStatus === "rejected") {
      query.doctorAssignmentStatus = "rejected";
    } else if (assignmentStatus === "pending") {
      query.doctorAssignmentStatus = "pending";
    }

    const consultancies = await Consultancy.find(query)
      .populate("userId", "full_name email phoneNumber dob gender weight height")
      .populate("memberId", "full_name relation age gender weight height")
      .sort({ consultationDate: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Doctor consultancies fetched successfully",
      assignmentStatus,
      totalConsultancies: consultancies.length,
      consultancies,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const getUnassignedConsultancies = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit || "10", 10) || 10);
    const skip = (page - 1) * limit;
    const assignmentStatus = String(req.query.assignmentStatus || "all").trim().toLowerCase();
    const search = String(req.query.search || "").trim();

    const query = {
      bookingStatus: "booked",
      paymentStatus: "paid",
    };

    if (assignmentStatus === "unassigned") {
      query.doctorId = null;
      query.$or = [
        { doctorAssignmentStatus: "unassigned" },
        { doctorAssignmentStatus: { $exists: false } },
        { doctorAssignmentStatus: null },
      ];
    } else if (assignmentStatus === "rejected") {
      query.doctorAssignmentStatus = "rejected";
    } else if (assignmentStatus === "pending") {
      query.doctorAssignmentStatus = "pending";
    } else if (assignmentStatus === "approved") {
      query.doctorAssignmentStatus = "approved";
    } else {
      query.$or = [
        { doctorId: null },
        { doctorAssignmentStatus: "rejected" },
      ];
    }

    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchClause = {
        $or: [
          { full_name: { $regex: escapedSearch, $options: "i" } },
          { email: { $regex: escapedSearch, $options: "i" } },
          { phoneNumber: { $regex: escapedSearch, $options: "i" } },
          { timeSlot: { $regex: escapedSearch, $options: "i" } },
        ],
      };

      if (query.$or) {
        query.$and = [{ $or: query.$or }, searchClause];
        delete query.$or;
      } else {
        query.$and = [searchClause];
      }
    }

    const [totalUnassigned, totalRejectedCount, consultancies] = await Promise.all([
      Consultancy.countDocuments(query),
      Consultancy.countDocuments({
        doctorAssignmentStatus: "rejected",
        bookingStatus: "booked",
        paymentStatus: "paid",
      }),
      Consultancy.find(query)
        .populate("userId", "full_name email phoneNumber dob gender weight height")
        .populate("memberId", "full_name relation age gender weight height")
        .populate("doctorId", "full_name email specialization")
        .sort({ consultationDate: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      message: "Unassigned consultancies fetched successfully",
      page,
      limit,
      totalUnassigned,
      totalRejectedCount,
      totalPages: Math.ceil(totalUnassigned / limit),
      consultancies,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

const respondToConsultancyAssignment = async (req, res) => {
  try {
    if (!req.doctor || !req.doctor._id) {
      return res.status(401).json({
        success: false,
        message: "Doctor not authenticated",
      });
    }

    const { consultancyId, decision, rejectionReason = "" } = req.body;

    if (!consultancyId || !decision) {
      return res.status(400).json({
        success: false,
        message: "consultancyId and decision are required",
      });
    }

    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "decision must be either approved or rejected",
      });
    }

    if (decision === "rejected" && !String(rejectionReason).trim()) {
      return res.status(400).json({
        success: false,
        message: "rejectionReason is required when decision is rejected",
      });
    }

    const booking = await Consultancy.findById(consultancyId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Consultancy booking not found",
      });
    }

    if (String(booking.doctorId) !== String(req.doctor._id)) {
      return res.status(403).json({
        success: false,
        message: "You can respond only to your assigned consultancies",
      });
    }

    if (booking.bookingStatus !== "booked" || booking.paymentStatus !== "paid") {
      return res.status(400).json({
        success: false,
        message: "Only confirmed bookings can be approved/rejected",
      });
    }

    if (["approved", "rejected"].includes(booking.doctorAssignmentStatus)) {
      return res.status(400).json({
        success: false,
        message: "Doctor decision already submitted for this consultancy",
      });
    }

    booking.doctorAssignmentStatus = decision;
    booking.doctorRespondedAt = new Date();
    booking.doctorRejectionReason = decision === "rejected" ? String(rejectionReason).trim() : "";
    await booking.save();

    const updatedBooking = await Consultancy.findById(consultancyId)
      .populate("userId", "full_name email phoneNumber dob gender weight height")
      .populate("memberId", "full_name relation age gender weight height")
      .populate("doctorId", "full_name email specialization")
      .lean();

    return res.status(200).json({
      success: true,
      message: `Consultancy ${decision} successfully`,
      booking: updatedBooking,
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
  createConsultancyOrder,
  verifyConsultancyPayment,
  getMyConsultancyBookings,
  getConsultancyDetailsById,
  getAllConsultancyBookingsForAdmin,
  assignDoctorToConsultancy,
  getDoctorConsultancies,
  getUnassignedConsultancies,
  respondToConsultancyAssignment,
};