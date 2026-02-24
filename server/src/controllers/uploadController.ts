import { GoogleGenAI } from "@google/genai";
import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Pinecone } from "@pinecone-database/pinecone";
import { Request, Response } from "express";
import pdfParse from "pdf-parse-fork";

interface UploadRequest extends Request {
  file?: Express.Multer.File;
}

const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("Missing required env: GOOGLE_API_KEY (or GEMINI_API_KEY)");
}

const ai = new GoogleGenAI({ apiKey });

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_OUTPUT_DIMENSION = Number.parseInt(
  process.env.EMBEDDING_OUTPUT_DIMENSION || "768",
  10
);
const CHUNK_SIZE = Number.parseInt(process.env.CHUNK_SIZE || "1800", 10);
const CHUNK_OVERLAP = Number.parseInt(process.env.CHUNK_OVERLAP || "100", 10);
const MAX_CHUNKS_PER_PDF = Number.parseInt(process.env.MAX_CHUNKS_PER_PDF || "60", 10);

const parseRetryAfterSeconds = (message: string): number | undefined => {
  const retryIn = message.match(/retry in\s+([\d.]+)s/i);
  if (retryIn?.[1]) {
    return Math.max(1, Math.ceil(Number.parseFloat(retryIn[1])));
  }

  const retryDelay = message.match(/"retryDelay":"(\d+)s"/i);
  if (retryDelay?.[1]) {
    return Number.parseInt(retryDelay[1], 10);
  }

  return undefined;
};

export const uploadController = async (req: UploadRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) {
      res.status(500).json({ error: "Missing Pinecone configuration" });
      return;
    }

    const documentId =
      (req.body?.documentId as string | undefined)?.trim() || `doc-${Date.now()}`;

    const pdfData = await pdfParse(req.file.buffer);
    const rawDocs = [
      new Document({
        pageContent: pdfData.text,
        metadata: { source: req.file.originalname || "uploaded.pdf" },
      }),
    ];

    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });

    const chunkedDocs = await textSplitter.splitDocuments(rawDocs);
    const chunksBeforeLimit = chunkedDocs.length;
    const limitedChunks = chunkedDocs.slice(0, MAX_CHUNKS_PER_PDF);
    const chunkLimitApplied = chunksBeforeLimit > limitedChunks.length;

    if (!limitedChunks.length) {
      res.status(400).json({ error: "No readable text found in PDF" });
      return;
    }

    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);
    const namespace = process.env.PINECONE_NAMESPACE;
    const indexClient = namespace ? pineconeIndex.namespace(namespace) : pineconeIndex;

    const vectors: Array<{
      id: string;
      values: number[];
      metadata: { text: string; source: string; documentId: string };
    }> = [];

    // Sequential embedding avoids free-tier burst limits.
    for (const [i, doc] of limitedChunks.entries()) {
      const result = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: doc.pageContent,
        config: {
          outputDimensionality: EMBEDDING_OUTPUT_DIMENSION,
        },
      });

      const values = result.embeddings?.[0]?.values;
      if (!values?.length) {
        continue;
      }

      vectors.push({
        id: `${documentId}-${i}`,
        values,
        metadata: {
          text: doc.pageContent,
          source: (doc.metadata.source as string) ?? "unknown",
          documentId,
        },
      });
    }

    if (!vectors.length) {
      res.status(400).json({ error: "Failed to generate embeddings for PDF content" });
      return;
    }

    await indexClient.upsert(vectors);

    res.json({
      success: true,
      pages: pdfData.numpages,
      documentId,
      chunksBeforeLimit,
      chunksStored: vectors.length,
      chunkLimitApplied,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lowerMessage = message.toLowerCase();

    if (
      message.includes("429") ||
      lowerMessage.includes("quota") ||
      lowerMessage.includes("resource_exhausted") ||
      lowerMessage.includes("rate limit")
    ) {
      const retryAfterSeconds = parseRetryAfterSeconds(message);
      res.status(429).json({
        error: retryAfterSeconds
          ? `Embedding quota exceeded. Retry after ${retryAfterSeconds}s.`
          : "Embedding quota exceeded. Please retry shortly.",
        code: "EMBEDDING_QUOTA_EXCEEDED",
        retryAfterSeconds,
      });
      return;
    }

    console.error("Upload error:", message);
    res.status(500).json({ error: message });
  }
};
