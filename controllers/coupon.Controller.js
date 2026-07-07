import Coupon from "../models/couponModel.js";

const createCoupon = async (req, res) => {
  try {
    const { code, discount, startDate, endDate } = req.body;

    if (!code || !discount || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    if (discount < 0 || discount > 100) {
      return res.status(400).json({
        success: false,
        message: "Discount must be between 0 and 100",
      });
    }

    const formatDate = (date) => {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      return d;
    };

    const parsedStart = formatDate(startDate);
    const parsedEnd = formatDate(endDate);
    const now = formatDate(new Date());

    if (parsedStart < now) {
      return res.status(400).json({
        success: false,
        message: "Start date must be in the future",
      });
    }

    if (parsedEnd <= parsedStart) {
      return res.status(400).json({
        success: false,
        message: "End date must be after start date",
      });
    }

    const coupon = await Coupon.create({
      code: code.toUpperCase(),
      discount,
      startDate: parsedStart,
      endDate: parsedEnd,
    });

    res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      coupon: {
        ...coupon.toObject(),
        startDate: parsedStart.toLocaleDateString(),
        endDate: parsedEnd.toLocaleDateString(),
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Coupon code already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Error creating coupon",
      error: error.message,
    });
  }
};

const getAllCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();

    res.status(200).json({
      success: true,
      message: "Coupons fetched successfully",
      totalCoupons: coupons.length,
      coupons,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching coupons",
      error: error.message,
    });
  }
};

const getCouponById = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      coupon,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching coupon",
      error: error.message,
    });
  }
};

const updateCoupon = async (req, res) => {
  try {
    const { code, discount, startDate, endDate } = req.body;
    const { id } = req.params;

    const existingCoupon = await Coupon.findById(id);
    if (!existingCoupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    if (discount && (discount < 0 || discount > 100)) {
      return res.status(400).json({
        success: false,
        message: "Discount must be between 0 and 100",
      });
    }

    if (startDate || endDate) {
      const formatDate = (date) => {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const parsedStart = startDate
        ? formatDate(startDate)
        : existingCoupon.startDate;
      const parsedEnd = endDate ? formatDate(endDate) : existingCoupon.endDate;
      const now = formatDate(new Date());

      // Allow today's date by using <= instead of <
      if (parsedStart < now) {
        return res.status(400).json({
          success: false,
          message: "Start date cannot be in the past",
        });
      }

      if (parsedEnd <= parsedStart) {
        return res.status(400).json({
          success: false,
          message: "End date must be after start date",
        });
      }
    }

    const updatedCoupon = await Coupon.findByIdAndUpdate(
      id,
      {
        code: code?.toUpperCase(),
        discount,
        startDate: startDate ? new Date(startDate) : existingCoupon.startDate,
        endDate: endDate ? new Date(endDate) : existingCoupon.endDate,
      },
      {
        returnDocument: 'after',
        runValidators: true,
      }
    );

    res.status(200).json({
      success: true,
      message: "Coupon updated successfully",
      coupon: updatedCoupon,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Coupon code already exists",
      });
    }
    res.status(500).json({
      success: false,
      message: "Error updating coupon",
      error: error.message,
    });
  }
};

const deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting coupon",
      error: error.message,
    });
  }
};

export {
  createCoupon,
  getAllCoupons,
  getCouponById,
  updateCoupon,
  deleteCoupon,
};
