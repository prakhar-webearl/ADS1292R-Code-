import multer from "multer";

const allowedMimeTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
    return;
  }

  cb(new Error("Only image files (jpg, jpeg, png, webp) are allowed"));
};

const productUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

export default productUpload;
