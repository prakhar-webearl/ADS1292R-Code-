import mongoose from "mongoose";

function getISTTime() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  return new Date(now.getTime() + istOffset);
}

const faqSchema = new mongoose.Schema(
  {
    question: {
      type: String,
      required: true,
      trim: true,
    },
    answer: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: {
      currentTime: () => getISTTime(),
    },
  },
);

const Faq = mongoose.model("Faq", faqSchema);

export default Faq;
