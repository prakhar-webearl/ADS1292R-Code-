import AddedUser from "../models/userAddModel.js";


const addMember = async (req, res) => {
  const { full_name, email, relation, age, gender, weight, height } = req.body;

  try {
    const user = await AddedUser.create({
      full_name,
      email,
      relation,
      age,
      gender,
      weight,
      height,
      createdBy: req.user.id,
    });

    res.status(201).json({
      _id: user._id,
      full_name: user.full_name,
      email: user.email,
      relation: user.relation,
      age: user.age,
      weight: user.weight,
      height: user.height,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error registering while adding user" });
  }
};

const updateFamilyMember = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updatedMember = await AddedUser.findOneAndUpdate(
      { _id: id, createdBy: req.user.id },
      updates,
      { returnDocument: 'after' }
    );

    if (!updatedMember) {
      return res.status(404).json({
        success: false,
        message: "Family member not found or unauthorized",
      });
    }

    // Structure the response data in desired order
    const responseData = {
      _id: updatedMember._id,
      full_name: updatedMember.full_name,
      email: updatedMember.email,
      relation: updatedMember.relation,
      age: updatedMember.age,
      gender: updatedMember.gender,
      weight: updatedMember.weight,
      height: updatedMember.height,
      createdBy: updatedMember.createdBy,
      createdAt: updatedMember.createdAt,
      updatedAt: updatedMember.updatedAt,
    };

    res.status(200).json({
      success: true,
      message: "Family member updated successfully",
      data: responseData,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const deleteFamilyMember = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedMember = await AddedUser.findOneAndDelete({
      _id: id,
      createdBy: req.user.id,
    });

    if (!deletedMember) {
      return res
        .status(404)
        .json({ message: "Family member not found or unauthorized" });
    }

    res.status(200).json({ message: "Family member deleted successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
};

const getFamilyMemberById = async (req, res) => {
  try {
    const { id } = req.params;

    const familyMember = await AddedUser.findOne({
      _id: id,
      createdBy: req.user.id,
    });

    if (!familyMember) {
      return res
        .status(404)
        .json({ message: "Family member not found or unauthorized" });
    }

    res
      .status(200)
      .json({
        message: "Family member fetched successfully",
        data: familyMember,
      });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
};

const getAllFamilyMembers = async (req, res) => {
  try {
    const familyMembers = await AddedUser.find({ createdBy: req.user.id });

    res
      .status(200)
      .json({
        message: "Family members fetched successfully",
        data: familyMembers,
      });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
};

export {
  addMember,
  updateFamilyMember,
  deleteFamilyMember,
  getAllFamilyMembers,
  getFamilyMemberById,
};
