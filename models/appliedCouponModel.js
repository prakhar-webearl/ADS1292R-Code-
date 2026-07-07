import mongoose from 'mongoose';

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC +5:30
  const now = new Date();
  const istTime = new Date(now.getTime() + istOffset);
  return istTime;
}

const appliedCouponSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  coupon: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Coupon',
    required: true
  },
  discount: {
    type: Number,
    required: true
  }
}, 
{
  timestamps: {
      currentTime: () => getISTTime()
  }
});
const AppliedCoupon = mongoose.model('AppliedCoupon', appliedCouponSchema);
export default AppliedCoupon;
