import express from "express";
import multer from "multer";
import { uploadController } from "../controllers/uploadController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/", upload.single("file"), uploadController);

export default router;
