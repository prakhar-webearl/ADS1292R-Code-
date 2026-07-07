import Faq from "../models/faqModel.js";

const createFaq = async (req, res) => {
  try {
    const { question, answer } = req.body;

    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        message: "question and answer are required",
      });
    }

    const faq = new Faq({
      question,
      answer,
    });

    await faq.save();

    res.status(201).json({
      success: true,
      message: "FAQ created successfully",
      faq,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error creating FAQ",
      error: error.message,
    });
  }
};

const getAllFaqs = async (req, res) => {
  try {
    const faqs = await Faq.find().sort({ createdAt: -1 }).lean();

    res.status(200).json({
      success: true,
      message: "FAQs fetched successfully",
      totalFaqs: faqs.length,
      faqs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching FAQs",
      error: error.message,
    });
  }
};

const getFaqById = async (req, res) => {
  try {
    const { id } = req.params;
    const faq = await Faq.findById(id);

    if (!faq) {
      return res.status(404).json({
        success: false,
        message: "FAQ not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "FAQ fetched successfully",
      faq,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching FAQ",
      error: error.message,
    });
  }
};

const updateFaq = async (req, res) => {
  try {
    const { id } = req.params;
    const { question, answer } = req.body;

    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        message: "question and answer are required",
      });
    }

    const updatedFaq = await Faq.findByIdAndUpdate(
      id,
      {
        question,
        answer,
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!updatedFaq) {
      return res.status(404).json({
        success: false,
        message: "FAQ not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "FAQ updated successfully",
      faq: updatedFaq,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating FAQ",
      error: error.message,
    });
  }
};

const deleteFaq = async (req, res) => {
  try {
    const deletedFaq = await Faq.findByIdAndDelete(req.params.id);

    if (!deletedFaq) {
      return res.status(404).json({
        success: false,
        message: "FAQ not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "FAQ deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting FAQ",
      error: error.message,
    });
  }
};

export { createFaq, getAllFaqs, getFaqById, updateFaq, deleteFaq };
