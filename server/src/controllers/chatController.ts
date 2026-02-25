import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { Pinecone } from "@pinecone-database/pinecone";
import { Request, Response } from "express";
import Groq from "groq-sdk";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY as string });
const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME as string);
const embeddings = new HuggingFaceInferenceEmbeddings({
  apiKey: process.env.HUGGINGFACE_API_KEY,
  model: "sentence-transformers/all-MiniLM-L6-v2",
});

export const sessions = new Map<string, ChatCompletionMessageParam[]>();

const getParamValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export const chatController = async (req: Request, res: Response): Promise<void> => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question : undefined;
    const documentId = typeof req.body?.documentId === "string" ? req.body.documentId : undefined;

    if (!question || !documentId) {
      res.status(400).json({ error: "question and documentId are required" });
      return;
    }

    if (!sessions.has(documentId)) {
      sessions.set(documentId, []);
    }
    const history = sessions.get(documentId)!;

    const questionVector = await embeddings.embedQuery(question);
    const results = await pineconeIndex.query({
      topK: 5,
      vector: questionVector,
      includeMetadata: true,
      filter: { documentId: { $eq: documentId } },
    });

    const context = results.matches
      .map((match) => match.metadata?.text)
      .join("\n\n---\n\n");

    history.push({ role: "user", content: question });

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are a helpful expert. Answer based ONLY on the context below.
          If answer is not in context, say "I could not find the answer in the document."
          Context: ${context}`,
        },
        ...history,
      ],
    });

    const answer = response.choices[0].message.content ?? "No response generated.";
    history.push({ role: "assistant", content: answer });

    const sources = results.matches.map((match) => ({
      id: match.id,
      score: match.score,
      text: match.metadata?.text as string,
      documentId: match.metadata?.documentId as string,
      fileName: match.metadata?.source as string,
    }));

    res.json({ success: true, answer, sources });

  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
};

// ✅ Delete session history + Pinecone data
export const deleteSessionController = async (req: Request, res: Response): Promise<void> => {
  try {
    const documentId = getParamValue(req.params.documentId);

    if (!documentId) {
      res.status(400).json({ error: "documentId is required" });
      return;
    }

    // Delete from memory
    sessions.delete(documentId);
    console.log(`Session deleted for documentId: ${documentId}`);

    // Delete from Pinecone
    await pineconeIndex.deleteMany({ documentId: { $eq: documentId } });
    console.log(`Pinecone data deleted for documentId: ${documentId}`);

    res.json({ success: true, message: "Session and Pinecone data deleted" });

  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
};

// ✅ Check if session exists
export const checkSessionController = async (req: Request, res: Response): Promise<void> => {
  const documentId = getParamValue(req.params.documentId);
  if (!documentId) {
    res.status(400).json({ error: "documentId is required" });
    return;
  }
  const exists = sessions.has(documentId);
  res.json({ exists });
};
