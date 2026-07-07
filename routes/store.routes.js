import express from "express";
import { protect, AppAdminprotect } from "../middleware/authMiddleware.js";
import productUpload from "../middleware/productmulter.js";
import {
  createProduct,
  getAllProducts,
  getProductById,
  updateProductStatus,
  createDirectOrder,
  verifyDirectOrderPayment,
  getMyDirectOrders,
  updateDirectOrderStatus,
  updateDirectOrderShippingStatus,
} from "../controllers/store.Controller.js";

const router = express.Router();

router.post("/product/create", AppAdminprotect, productUpload.single("image"), createProduct);
router.get("/product/list", getAllProducts);
router.get("/product/:productId", getProductById);
router.patch("/product/:productId/status", AppAdminprotect, updateProductStatus);

router.post("/order/create-order", protect, createDirectOrder);
router.post("/order/verify-payment", protect, verifyDirectOrderPayment);
router.get("/order/my-orders", protect, getMyDirectOrders);
router.patch("/order/:orderId/status", AppAdminprotect, updateDirectOrderStatus);
router.patch("/order/:orderId/shipping-status", AppAdminprotect, updateDirectOrderShippingStatus);

export default router;
