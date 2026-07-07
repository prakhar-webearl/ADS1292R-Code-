import express from "express";
import {
  addDevice,
  updateDevice,
  getAllDevices,
  getDeviceById,
  deleteDevice,
} from "../controllers/device.Controller.js";

const router = express.Router();

// Device routes
router.post("/add", addDevice);
router.put("/update/:id", updateDevice);
router.get("/getall", getAllDevices);
router.get("/getById/:id", getDeviceById);
router.delete("/delete/:id", deleteDevice);

export default router;