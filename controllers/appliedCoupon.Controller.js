import AppliedCoupon from '../models/appliedCouponModel.js';
import Coupon from '../models/couponModel.js';

const applyCoupon = async (req, res) => {
  try {
    const { code } = req.body;
    const user = req.user;

    const coupon = await Coupon.findOne({ code: code.toUpperCase() });

    if (!coupon) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }

    const now = new Date();

    if (now < coupon.startDate || now > coupon.endDate) {
      return res.status(400).json({ success: false, message: 'Coupon is not valid at this time' });
    }

    const alreadyUsed = await AppliedCoupon.findOne({ user: user._id, coupon: coupon._id });

    if (alreadyUsed) {
      return res.status(400).json({ success: false, message: 'Coupon already applied by this user' });
    }

    const appliedCoupon = await AppliedCoupon.create({
      user: user._id,
      coupon: coupon._id,
      discount: coupon.discount
    });

    res.status(201).json({
      success: true,
      message: 'Coupon applied successfully',
      appliedCoupon
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error applying coupon',
      error: error.message
    });
  }
};

const getAppliedCoupons = async (req, res) => {
  try {
    const applied = await AppliedCoupon.find()
      .populate('user', 'name email')
      .populate('coupon', 'code discount');

    res.status(200).json({
      success: true,
      count: applied.length,
      data: applied
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching applied coupons',
      error: error.message
    });
  }
};

export {
  applyCoupon,
  getAppliedCoupons
};
