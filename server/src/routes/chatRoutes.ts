import express from "express";
import {
    chatController,
    checkSessionController,
    deleteSessionController,
} from "../controllers/chatController.js";

const router = express.Router();

router.post("/", chatController);
router.get("/session/:documentId", checkSessionController);   // ✅ check session
router.delete("/session/:documentId", deleteSessionController); // ✅ delete session

export default router;