import Article from "../models/articlesModel.js";
import User from "../models/userModel.js";
import Notification from "../models/notificationModel.js";
import { emitNewNotification } from "../services/notificationSocket.js";
import { createAdminNotification } from "./adminNotification.Controller.js";
import { uploadImageToImageKit } from "../services/imagekitService.js";
const BASE_URL = "https://ecg-wv62.onrender.com/uploads/article/";
// const BASE_URL = "http://localhost:5000/uploads/article/"

const TEMPORARY_BLOGS = [
  {
    _id: "temp-blog-1",
    blog_title: "Understanding ECG Basics",
    description: "A quick beginner guide to ECG waves, intervals, and what they mean.",
    read_time: "3 min",
    photo: "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1000&q=80",
    isTemporary: true,
    createdAt: "2026-04-11T09:00:00.000Z",
  },
  {
    _id: "temp-blog-2",
    blog_title: "How to Place ECG Leads Correctly",
    description: "Lead placement tips to reduce noise and improve heart rhythm accuracy.",
    read_time: "4 min",
    photo: "https://images.unsplash.com/photo-1538108149393-fbbd81895907?auto=format&fit=crop&w=1000&q=80",
    isTemporary: true,
    createdAt: "2026-04-11T08:00:00.000Z",
  },
  {
    _id: "temp-blog-3",
    blog_title: "What Is Normal Sinus Rhythm",
    description: "Learn how normal sinus rhythm appears and when to consult a doctor.",
    read_time: "5 min",
    photo: "https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=1000&q=80",
    isTemporary: true,
    createdAt: "2026-04-11T07:00:00.000Z",
  },
  {
    _id: "temp-blog-4",
    blog_title: "ECG Artifacts and Noise Removal",
    description: "Common ECG artifacts and practical ways to avoid false waveform readings.",
    read_time: "4 min",
    photo: "https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=1000&q=80",
    isTemporary: true,
    createdAt: "2026-04-11T06:00:00.000Z",
  },
  {
    _id: "temp-blog-5",
    blog_title: "Reading Heart Rate from ECG",
    description: "A simple method to estimate heart rate using ECG paper and digital traces.",
    read_time: "3 min",
    photo: "https://images.unsplash.com/photo-1504813184591-01572f98c85f?auto=format&fit=crop&w=1000&q=80",
    isTemporary: true,
    createdAt: "2026-04-11T05:00:00.000Z",
  },
];

const toPublicArticle = (article) => {
  const articleObj = article.toObject ? article.toObject() : article;

  if (articleObj.photo) {
    const isAbsoluteUrl = /^https?:\/\//i.test(articleObj.photo);
    if (!isAbsoluteUrl) {
      const filename = articleObj.photo.split("\\").pop().split("/").pop();
      articleObj.photo = BASE_URL + filename;
    }
  }

  return articleObj;
};

const createArticle = async (req, res) => {
  try {
    const { blog_title, description, read_time } = req.body;
    console.log("[article/create] Request received", {
      blog_title,
      read_time,
      hasDescription: Boolean(description),
      contentType: req.headers["content-type"],
      file: req.file
        ? {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          }
        : null,
    });

    if (!blog_title || !description || !read_time) {
      return res.status(400).json({
        success: false,
        message: "blog_title, description and read_time are required",
      });
    }

    if (!req.file) {
      console.error("[article/create] Missing photo file in request");
      return res.status(400).json({
        success: false,
        message: "photo is required",
      });
    }

    const photo = await uploadImageToImageKit({
      fileBuffer: req.file.buffer,
      fileName: req.file.originalname,
      folder: "/articles",
    });
    console.log("[article/create] Image uploaded successfully", { photo });

    const article = new Article({
      blog_title,
      description,
      read_time,
      photo,
      createdBy: "admin",
      approvalStatus: "approved",
      approvedBy: req.user?._id || null,
      approvedAt: new Date(),
      rejectionReason: "",
    });

    await article.save();

    try {
      const allUsers = await User.find({ status: { $ne: "blocked" } })
        .select("_id")
        .lean();

      if (allUsers.length > 0) {
        const notificationDocs = allUsers.map((user) => ({
          title: "New Blog Published",
          notification: `New blog available: ${blog_title}`,
          details: `A new blog has been published. Read time: ${read_time}`,
          targetUserId: String(user._id),
        }));

        const createdNotifications = await Notification.insertMany(notificationDocs);
        createdNotifications.forEach((notificationDoc) => {
          emitNewNotification(notificationDoc);
        });
      }

      // Also notify admin
      await createAdminNotification({
        title: "New Blog Published",
        desc: `New blog "${blog_title}" has been published and users notified.`,
        type: "SYSTEM",
        category: "SUCCESS",
        metadata: { articleId: article._id }
      });
    } catch (notificationError) {
      console.error("Error sending blog notifications:", notificationError.message);
    }

    res.status(201).json({
      success: true,
      message: "Article created successfully",
      article: toPublicArticle(article),
    });
  } catch (error) {
    console.error("[article/create] Failed", {
      message: error.message,
      stack: error.stack,
      hasFile: Boolean(req.file),
      fileName: req.file?.originalname,
      fileMimeType: req.file?.mimetype,
      fileSize: req.file?.size,
    });
    res.status(500).json({
      success: false,
      message: "Error creating article",
      error: error.message,
    });
  }
};

const getAllArticles = async (req, res) => {
  try {
    let articles = await Article.find({
      $or: [
        { createdBy: "admin" },
        { createdBy: "doctor", approvalStatus: "approved" },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();

    if (articles.length === 0) {
      const temporaryBlogs = TEMPORARY_BLOGS.map((blog) => toPublicArticle(blog));
      return res.status(200).json({
        success: true,
        message: "Temporary blogs fetched successfully",
        totalArticles: temporaryBlogs.length,
        articles: temporaryBlogs,
      });
    }

    articles = articles.map((article) => toPublicArticle(article));

    res.status(200).json({
      success: true,
      message: "Articles fetched successfully",
      totalArticles: articles.length,
      articles,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching articles",
      error: error.message,
    });
  }
};


const getArticleById = async (req, res) => {
  try {
    const { id } = req.params;
    const article = await Article.findById(id);

    if (!article) {
      const temporaryBlog = TEMPORARY_BLOGS.find((blog) => blog._id === id);
      if (temporaryBlog) {
        return res.status(200).json({
          success: true,
          message: "Article fetched successfully",
          article: toPublicArticle(temporaryBlog),
        });
      }

      return res.status(404).json({
        success: false,
        message: "Article not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Article fetched successfully",
      article: toPublicArticle(article),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching article",
      error: error.message,
    });
  }
};
// const getAllArticles = async (req, res) => {
//     try {
//       const page = parseInt(req.query.page) || 1; // Default page = 1
//       const limit = parseInt(req.query.limit) || 10; // Default limit = 10
//       const skip = (page - 1) * limit;

//       const totalArticles = await Article.countDocuments();
//       const articles = await Article.find({})
//         .sort({ createdAt: -1 })
//         .skip(skip)
//         .limit(limit);

//       res.status(200).json({
//         message: "Articles fetched successfully",
//         page,
//         totalPages: Math.ceil(totalArticles / limit),
//         totalArticles,
//         articles
//       });
//     } catch (error) {
//       res.status(500).json({
//         message: "Error fetching articles",
//         error: error.message,
//       });
//     }
// }

// const getArticleById = async (req, res) => {
//     try {
//         const { id } = req.params;
//         const article = await Article.findById(id);
//         if (!article){
//             return res.status(404).json({
//                 message: "Article not found"
//             })
//         }
//         res.status(200).json({
//             message : "Article fetched successsfully",
//             article
//         })
//     } catch (error) {
//         res.status(500).json({
//             message: "Error fetching article",
//             error: error.message,
//         })
//     }
// }

const updateArticle = async (req, res) => {
  try {
    const { id } = req.params;
    const { blog_title, description, read_time } = req.body;

    console.log("[article/update] Request received", {
      id,
      blog_title,
      read_time,
      hasDescription: Boolean(description),
      contentType: req.headers["content-type"],
      file: req.file
        ? {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          }
        : null,
      photoInBody: Boolean(req.body.photo),
    });

    const updatePayload = {
      blog_title,
      description,
      read_time,
    };

    if (req.file?.buffer) {
      updatePayload.photo = await uploadImageToImageKit({
        fileBuffer: req.file.buffer,
        fileName: req.file.originalname,
        folder: "/articles",
      });
    } else if (req.body.photo) {
      updatePayload.photo = req.body.photo;
    }

    Object.keys(updatePayload).forEach((key) => {
      if (
        updatePayload[key] === undefined ||
        updatePayload[key] === null ||
        updatePayload[key] === ""
      ) {
        delete updatePayload[key];
      }
    });

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update",
      });
    }

    const updatedArticle = await Article.findByIdAndUpdate(
      id,
      updatePayload,
      {
        returnDocument: 'after',
        runValidators: true,
      }
    );

    if (!updatedArticle) {
      return res.status(404).json({ success: false, message: "Article not found" });
    }

    res.status(200).json({
      success: true,
      message: "Article updated successfully",
      article: toPublicArticle(updatedArticle),
    });
  } catch (error) {
    console.error("[article/update] Failed", {
      message: error.message,
      stack: error.stack,
      id: req.params?.id,
      hasFile: Boolean(req.file),
    });
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

const deleteArticle = async (req, res) => {
  try {
    const deletedArticle = await Article.findByIdAndDelete(req.params.id);
    if (!deletedArticle)
      return res.status(404).json({ success: false, message: "Article not found" });
    res.json({ success: true, message: "Article deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Delete failed", error: error.message });
  }
};

const getHomeTopBlogs = async (req, res) => {
  try {
    const limit = Math.max(parseInt(req.query.limit, 10) || 5, 1);

    const articles = await Article.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    if (articles.length === 0) {
      const temporaryBlogs = TEMPORARY_BLOGS.slice(0, limit).map((blog) => toPublicArticle(blog));
      return res.status(200).json({
        success: true,
        message: "Home temporary blogs fetched successfully",
        totalBlogs: temporaryBlogs.length,
        blogs: temporaryBlogs,
      });
    }

    res.status(200).json({
      success: true,
      message: "Home blogs fetched successfully",
      totalBlogs: articles.length,
      blogs: articles.map((article) => toPublicArticle(article)),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching home blogs",
      error: error.message,
    });
  }
};

export {
  createArticle,
  getAllArticles,
  getArticleById,
  updateArticle,
  deleteArticle,
  getHomeTopBlogs,
};
