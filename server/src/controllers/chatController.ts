import { GoogleGenAI } from "@google/genai";
import { Pinecone } from "@pinecone-database/pinecone";
import env from "dotenv";
import { Request, Response } from "express";

env.config();

const googleApiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
if (!googleApiKey) {
  throw new Error("Missing required env: GOOGLE_API_KEY (or GEMINI_API_KEY)");
}

const pineconeApiKey = process.env.PINECONE_API_KEY;
const pineconeIndexName = process.env.PINECONE_INDEX_NAME;
if (!pineconeApiKey || !pineconeIndexName) {
  throw new Error("Missing required env: PINECONE_API_KEY or PINECONE_INDEX_NAME");
}

const ai = new GoogleGenAI({ apiKey: googleApiKey });
const pinecone = new Pinecone({ apiKey: pineconeApiKey });

const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-2.0-flash";
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_OUTPUT_DIMENSION = Number.parseInt(
  process.env.EMBEDDING_OUTPUT_DIMENSION || "768",
  10
);

const parseRetryAfterSeconds = (message: string): number | undefined => {
  const retryInMatch = message.match(/retry in\s+([\d.]+)s/i);
  if (retryInMatch?.[1]) {
    return Math.max(1, Math.ceil(Number.parseFloat(retryInMatch[1])));
  }

  const retryDelayMatch = message.match(/"retryDelay":"(\d+)s"/i);
  if (retryDelayMatch?.[1]) {
    return Number.parseInt(retryDelayMatch[1], 10);
  }

  return undefined;
};

const isQuotaError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    message.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate limit")
  );
};

export const chatController = async (req: Request, res: Response): Promise<void> => {
  try {
    const question = String(req.body?.question ?? "").trim();
    const documentId =
      typeof req.body?.documentId === "string" && req.body.documentId.trim()
        ? req.body.documentId.trim()
        : undefined;

    if (!question) {
      res.status(400).json({ error: "Question is required" });
      return;
    }

    const embedResponse = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: question,
      config: {
        outputDimensionality: EMBEDDING_OUTPUT_DIMENSION,
      },
    });

    const queryVector = embedResponse.embeddings?.[0]?.values;
    if (!queryVector?.length) {
      res.status(500).json({ error: "Failed to generate query embedding" });
      return;
    }

    const indexBase = pinecone.Index(pineconeIndexName);
    const namespace = process.env.PINECONE_NAMESPACE;
    const index = namespace ? indexBase.namespace(namespace) : indexBase;

    const searchResults = await index.query({
      topK: 5,
      vector: queryVector,
      includeMetadata: true,
      ...(documentId ? ({ filter: { documentId: { $eq: documentId } } } as const) : {}),
    } as any);

    const context = (searchResults.matches ?? [])
      .map((match) => String(match.metadata?.text ?? ""))
      .filter(Boolean)
      .join("\n\n---\n\n");

    if (!context) {
      res.status(200).json({
        success: true,
        answer: "I could not find the answer in the provided document.",
        sources: [],
      });
      return;
    }

    const prompt = `You have to behave like a Data Structure and Algorithm Expert.
You will be given a context of relevant information and a user question.
Answer the user's question based ONLY on the context.
If the answer is not in the context, say exactly: "I could not find the answer in the provided document."
Keep answers clear and concise.

Question: ${question}

Context:
${context}`;

    const response = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents: prompt,
    });

    res.json({
      success: true,
      answer: response.text ?? "I could not find the answer in the provided document.",
      sources: (searchResults.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score,
        text: String(m.metadata?.text ?? ""),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (isQuotaError(message)) {
      const retryAfterSeconds = parseRetryAfterSeconds(message);
      if (typeof retryAfterSeconds === "number") {
        res.setHeader("Retry-After", retryAfterSeconds.toString());
      }
      res.status(429).json({
        error: retryAfterSeconds
          ? `Chat quota exceeded. Retry after ${retryAfterSeconds}s.`
          : "Chat quota exceeded. Please retry shortly.",
        code: "CHAT_QUOTA_EXCEEDED",
        retryAfterSeconds,
      });
      return;
    }

    res.status(500).json({ error: message });
  }
};
