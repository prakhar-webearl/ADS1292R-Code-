import multer from "multer";
import path from "path";

const storage = multer.memoryStorage();

const allowedMimeTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];

// File filter for images
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase()
  );
  const mimetype = allowedMimeTypes.includes(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    console.error("[article upload] Rejected file", {
      originalname: file.originalname,
      mimetype: file.mimetype,
      ext: path.extname(file.originalname).toLowerCase(),
    });
    cb(new Error("Only image files are allowed!"));
  }
};

// Configure multer
const upload = multer({
  storage,
  limits: {
    fileSize: 3 * 1024 * 1024, // 3MB file size limit
  },
  fileFilter: fileFilter,
});

export default upload;
