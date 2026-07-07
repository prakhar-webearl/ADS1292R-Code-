import Help from "../models/helpModel.js";

const createHelp = async (req, res) => {
  try {
    const { question, answer } = req.body;
    const help = new Help({
      question,
      answer,
    });

    await help.save();
    res.status(201).json({
      message: "Help & Support craeted successfully",
      help,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error craeting Help & Support",
      error: error.message,
    });
  }
};

const getAllHelp = async (req, res) => {
    try {
      const helps = await Help.find()
        .sort({ createdAt: -1 })
        .lean(); // Use lean() for better performance
  
      res.status(200).json({
        success: true,
        message: "Help & Support fetched successfully",
        totalHelps: helps.length,
        helps,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching Help & Support",
        error: error.message,
      });
    }
  };
  

const getHelpById = async (req, res) => {
  try {
    const { id } = req.params;
    const getAllHelpById = await Help.findById(id);
    if (!getAllHelpById) {
      return res.status(404).json({
        message: "Help & Support not found",
      });
    }
    res.status(200).json({
      message: "Help & Support fetched successsfully",
      getAllHelpById,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching article",
      error: error.message,
    });
  }
};

const updateHelp = async (req, res) => {
  try {
    const { id } = req.params;
    const { question, answer } = req.body;

    const updateHelp = await Help.findByIdAndUpdate(
      id,
      {
        question,
        answer,
      },
      {
        returnDocument: 'after',
        runValidators: true,
      }
    );

    if (!updateHelp) {
      return res.status(404).json({ message: "Help & Support not found" });
    }

    res.status(200).json({
      message: "Help & Support updated successfully",
      updateHelp,
    });
  } catch (error) {
    console.error("Error updating article:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const deleteHelp = async (req, res) => {
  try {
    const deletedHelp = await Help.findByIdAndDelete(req.params.id);
    if (!deletedHelp)
      return res.status(404).json({ message: "Help & Support not found" });
    res.json({ message: "Help & Support deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Delete failed", error: error.message });
  }
};

export { createHelp, getAllHelp, getHelpById, updateHelp, deleteHelp };
