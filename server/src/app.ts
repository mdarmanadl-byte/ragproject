import "./config.js";

import cors from "cors";
import express, { Request, Response } from "express";
import chatRoutes from "./routes/chatRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";




const app = express();
const port = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

app.get("/", (_req: Request, res: Response) => {
  res.json({ message: "RAG server is running" });
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.use("/api/upload", uploadRoutes);
app.use("/api/chat", chatRoutes);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
