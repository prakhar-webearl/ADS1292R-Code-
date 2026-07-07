import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const productSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    packageDetails: {
      type: [String],
      default: [],
    },
    price: {
      type: Number,
      required: true,
      min: 1,
    },
    currency: {
      type: String,
      default: "INR",
      uppercase: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  },
);

const Product = mongoose.model("Product", productSchema);

export default Product;
