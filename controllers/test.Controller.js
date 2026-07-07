import Test from "../models/testModel.js";
const BASE_URL = "https://ecg-wv62.onrender.com/uploads/test/";
// const BASE_URL = "http://localhost:5000/uploads/test/"

function combineAnswer(points) {
  const answer = [];

  if (Array.isArray(points)) {
    for (let i = 0; i < points.length; i++) {
      answer.push({
        point: points[i],
      });
    }
  } else if (typeof points === "string") {
    answer.push({
      point: points,
    });
  }
  return answer;
}

const testCreate = async (req, res) => {
  try {
    const { name, description_name, description, question_title, point } =
      req.body;

    const answer = combineAnswer(point);

    const newTest = new Test({
      name,
      description_name,
      photo: req.file?.filename,
      description,
      question_title,
      answer,
      point,
    });

    const savedTest = await newTest.save();
    res.status(201).json(savedTest);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Test Create failed", error: error.message });
  }
};

const updateTest = async (req, res) => {
  try {
    const { name, description_name, description, question_title, point } =
      req.body;

    const existingTest = await Test.findById(req.params.id);
    if (!existingTest) {
      return res.status(404).json({ message: "Test not found" });
    }

    const existingPoints = Array.isArray(existingTest.point)
      ? existingTest.point
      : [];
    const newPoints = Array.isArray(point) ? point : [point];
    const updatedPoints = [...existingPoints, ...newPoints];

    const existingAnswers = Array.isArray(existingTest.answer)
      ? existingTest.answer
      : [];
    const newAnswers = combineAnswer(newPoints);
    const updatedAnswers = [...existingAnswers, ...newAnswers];

    existingTest.name = name || existingTest.name;
    existingTest.description_name =
      description_name || existingTest.description_name;
    existingTest.description = description || existingTest.description;
    existingTest.question_title = question_title || existingTest.question_title;
    existingTest.point = updatedPoints;
    existingTest.answer = updatedAnswers;

    if (req.file?.filename) {
      existingTest.photo = req.file.filename;
    }

    const updatedTest = await existingTest.save();
    res.json(updatedTest);
  } catch (error) {
    res.status(500).json({ message: "Update failed", error: error.message });
  }
};

const getAllTest = async (req, res) => {
    try {
      let tests = await Test.find()
        .sort({ createdAt: -1 })
        .lean(); // Use lean() for better performance
  
      // Add base URL to photos
      tests = tests.map((test) => {
        if (test.photo) {
          const filename = test.photo.split("\\").pop().split("/").pop();
          test.photo = BASE_URL + filename;
        }
        return test;
      });
  
      res.status(200).json({
        success: true,
        message: "Tests fetched successfully",
        totalTests: tests.length,
        tests,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching tests",
        error: error.message,
      });
    }
}  

const getTestById = async (req, res) => {
  try {
    const test = await Test.findById(req.params.id);

    if (!test) {
      return res.status(404).json({ message: "Test not found" });
    }

    // Clean the photo URL
    if (test.photo) {
      // Only get the filename, even if test.photo has a path
      const filename = test.photo.split("\\").pop().split("/").pop();
      test.photo = BASE_URL + filename;
    }

    res.json(test);
  } catch (error) {
    res.status(500).json({ message: "Read one failed", error: error.message });
  }
};

const deleteTest = async (req, res) => {
  try {
    const deletedTest = await Test.findByIdAndDelete(req.params.id);
    if (!deletedTest)
      return res.status(404).json({ message: "Test not found" });
    res.json({ message: "Test deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Delete failed", error: error.message });
  }
};

export { testCreate, updateTest, getAllTest, getTestById, deleteTest };
