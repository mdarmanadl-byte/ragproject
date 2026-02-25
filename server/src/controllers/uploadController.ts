import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Pinecone } from "@pinecone-database/pinecone";
import { Request, Response } from "express";
import pdfParse from "pdf-parse-fork";
import { sessions } from "./chatController.js";
interface UploadRequest extends Request {
  file?: Express.Multer.File;
}

export const uploadController = async (req: UploadRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    // Step 1: Parse PDF
    const pdfData = await pdfParse(req.file.buffer);
    const rawDocs = [
      new Document({
        pageContent: pdfData.text,
        metadata: { source: req.file.originalname },
      }),
    ];
    console.log("PDF loaded");

    // Step 2: Chunk documents
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const chunkedDocs = await textSplitter.splitDocuments(rawDocs);
    console.log("Chunking Completed, count:", chunkedDocs.length);
    const documentId = `doc-${Date.now()}`;

    // Step 3: Embeddings
    const embeddings = new HuggingFaceInferenceEmbeddings({
      apiKey: process.env.HUGGINGFACE_API_KEY,
      model: "sentence-transformers/all-MiniLM-L6-v2",
    });

    // Step 4: Pinecone
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY as string });
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME as string);
    console.log("Pinecone configured");

    // Step 5: Embed all chunks
    const vectors = [];
    for (let i = 0; i < chunkedDocs.length; i++) {
      console.log(`Embedding chunk ${i + 1}/${chunkedDocs.length}...`);
      const vector = await embeddings.embedQuery(chunkedDocs[i].pageContent);
      vectors.push({
        id: `${documentId}-${i}`,
        values: vector,
        metadata: {
          text: chunkedDocs[i].pageContent,
          source: (chunkedDocs[i].metadata.source as string) ?? "unknown",
          documentId,
        },
      });
    }

    // Step 6: Upsert in batches of 50
    const batchSize = 50;
    for (let i = 0; i < vectors.length; i += batchSize) {
      const batch = vectors.slice(i, i + batchSize);
      console.log(`Upserting batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vectors.length / batchSize)}...`);
      await pineconeIndex.upsert(batch);
    }
    
    sessions.set(documentId, []); // initialize empty session
    console.log(`Session initialized for documentId: ${documentId}`);
    console.log("Data stored successfully");
    res.json({ success: true, pages: pdfData.numpages, documentId });

  } catch (err) {
    const error = err as Error;
    console.error("Upload error:", error.message);
    res.status(500).json({ error: error.message });
  }
};
