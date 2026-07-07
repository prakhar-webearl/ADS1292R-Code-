import ImageKit from "@imagekit/nodejs";

const buildImageKitClient = () => {
  const IMAGEKIT_PUBLIC_KEY = "public_fKuyXtgsH0vx9PQKCcow7rxi4Iw=";
  const IMAGEKIT_PRIVATE_KEY = "private_Xzj8KioOPxuMkDxF7JehUzHRUbI=";
  const IMAGEKIT_URL_ENDPOINT = "https://ik.imagekit.io/kmrgue4u6/";

  if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_URL_ENDPOINT) {
    return null;
  }

  return new ImageKit({
    publicKey: IMAGEKIT_PUBLIC_KEY,
    privateKey: IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: IMAGEKIT_URL_ENDPOINT,
  });
};

const uploadImageToImageKit = async ({ fileBuffer, fileName, folder = "/products" }) => {
  const imageKit = buildImageKitClient();

  if (!imageKit) {
    throw new Error(
      "ImageKit credentials are missing on server. Set IMAGEKIT_PUBLIC_KEY_1, IMAGEKIT_PRIVATE_KEY_1, and IMAGE_BASE_URL_1."
    );
  }

  if (!fileBuffer) {
    throw new Error("Image file buffer is missing");
  }

  const normalizedFile = Buffer.isBuffer(fileBuffer)
    ? fileBuffer.toString("base64")
    : fileBuffer;

  console.log("[imagekit] Upload started", {
    fileName,
    folder,
    fileSize: fileBuffer.length,
    bufferType: Buffer.isBuffer(fileBuffer) ? "Buffer" : typeof fileBuffer,
  });

  try {
    const uploaded = await imageKit.files.upload({
      file: normalizedFile,
      fileName,
      folder,
      useUniqueFileName: true,
    });

    console.log("[imagekit] Upload success", {
      fileName,
      folder,
      url: uploaded.url,
      fileId: uploaded.fileId,
    });

    return uploaded.url;
  } catch (error) {
    console.error("[imagekit] Upload failed", {
      fileName,
      folder,
      message: error.message,
      statusCode: error.statusCode,
      help: error.help,
    });
    throw error;
  }
};

export { uploadImageToImageKit };
