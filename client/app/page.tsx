"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import './globals.css';
type ChatSource = {
  id: string;
  score?: number;
  text: string;
  documentId?: string;
  fileName?: string;
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:5000";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [question, setQuestion] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [sessionActive, setSessionActive] = useState(false); // ✅ track session

  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [uploadMessage, setUploadMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<ChatSource[]>([]);

  const canUpload = useMemo(() => Boolean(file) && !uploading, [file, uploading]);
  const canAsk = useMemo(
    () => Boolean(question.trim()) && Boolean(documentId.trim()) && !asking && sessionActive,
    [question, documentId, asking, sessionActive]
  );

  // ✅ Restore documentId from localStorage on page load
  useEffect(() => {
    const savedDocumentId = localStorage.getItem("documentId");
    if (savedDocumentId) {
      setDocumentId(savedDocumentId);
      checkSession(savedDocumentId);
    }
  }, []);

  // ✅ Check if session exists on server
  const checkSession = async (docId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/chat/session/${docId}`);
      const data = await response.json();
      setSessionActive(data.exists);
      if (!data.exists) {
        // session gone (server restarted) - clear localStorage
        localStorage.removeItem("documentId");
        setDocumentId("");
        setUploadMessage("Previous session expired. Please upload your PDF again.");
      }
    } catch {
      setSessionActive(false);
    }
  };

  const getErrorMessage = (data: unknown, fallback: string) => {
    if (!data || typeof data !== "object") return fallback;
    const payload = data as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
    return fallback;
  };

  const handleUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      setErrorMessage("Please select a PDF file first.");
      return;
    }

    setUploading(true);
    setErrorMessage("");
    setUploadMessage("");
    setAnswer("");
    setSources([]);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE_URL}/api/upload`, {
        method: "POST",
        body: formData,
      });

      let data: unknown = null;
      try { data = await response.json(); } catch { data = null; }

      if (!response.ok) throw new Error(getErrorMessage(data, "Upload failed"));

      const responseDocumentId =
        data && typeof data === "object" && typeof (data as { documentId?: unknown }).documentId === "string"
          ? (data as { documentId: string }).documentId
          : "";

      const chunksStored =
        data && typeof data === "object" && typeof (data as { chunksStored?: unknown }).chunksStored === "number"
          ? (data as { chunksStored: number }).chunksStored
          : 0;

      if (responseDocumentId) {
        setDocumentId(responseDocumentId);
        setSessionActive(true); // ✅ session is now active
        localStorage.setItem("documentId", responseDocumentId); // ✅ save to localStorage
      }

      setUploadMessage(
        `Uploaded successfully. Chunks stored: ${chunksStored}${responseDocumentId ? ` | documentId: ${responseDocumentId}` : ""}`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  // ✅ Delete session and Pinecone data
  const handleDeleteSession = async () => {
    if (!documentId) return;

    setDeleting(true);
    try {
      await fetch(`${API_BASE_URL}/api/chat/session/${documentId}`, {
        method: "DELETE",
      });

      // Clear everything
      setDocumentId("");
      setSessionActive(false);
      setAnswer("");
      setSources([]);
      setUploadMessage("");
      setFile(null);
      localStorage.removeItem("documentId"); // ✅ clear localStorage
      setUploadMessage("Session and PDF data deleted successfully.");
    } catch {
      setErrorMessage("Failed to delete session.");
    } finally {
      setDeleting(false);
    }
  };

  const handleAsk = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) { setErrorMessage("Please enter a question."); return; }
    if (!documentId.trim()) { setErrorMessage("Please upload a PDF first."); return; }

    setAsking(true);
    setErrorMessage("");
    setAnswer("");
    setSources([]);

    try {
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim(), documentId: documentId.trim() }),
      });

      let data: unknown = null;
      try { data = await response.json(); } catch { data = null; }

      if (!response.ok) throw new Error(getErrorMessage(data, "Request failed"));

      const answerText =
        data && typeof data === "object" && typeof (data as { answer?: unknown }).answer === "string"
          ? (data as { answer: string }).answer
          : "No answer returned.";
      const sourceItems =
        data && typeof data === "object" && Array.isArray((data as { sources?: unknown }).sources)
          ? ((data as { sources: ChatSource[] }).sources ?? [])
          : [];

      setAnswer(answerText);
      setSources(sourceItems);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setAsking(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen max-w-3xl p-6 md:p-10">
      <h1 className="text-2xl font-bold">PDF RAG Assistant</h1>
      <p className="mt-2 text-sm opacity-80">
        1) Upload a reference PDF. 2) Ask questions against that document.
      </p>

      {/* ✅ Session status banner */}
      {documentId && (
        <div className={`mt-4 rounded-md p-3 text-sm flex justify-between items-center ${sessionActive ? "bg-green-50 text-green-700" : "bg-yellow-50 text-yellow-700"}`}>
          <span>
            {sessionActive ? `✅ Session active | documentId: ${documentId}` : "⚠️ Session expired. Please upload again."}
          </span>
          {sessionActive && (
            <button
              onClick={handleDeleteSession}
              disabled={deleting}
              className="ml-4 rounded-md bg-red-600 px-3 py-1 text-white text-xs disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete Session"}
            </button>
          )}
        </div>
      )}

      <section className="mt-8 rounded-xl border p-4 md:p-6">
        <h2 className="text-lg font-semibold">Step 1: Upload PDF</h2>
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleUpload}>
          <input
            className="rounded-md border p-2"
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="submit"
            disabled={!canUpload}
            className="w-fit rounded-md bg-black px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Upload PDF"}
          </button>
        </form>
        {uploadMessage ? <p className="mt-4 text-sm text-green-700">{uploadMessage}</p> : null}
      </section>

      <section className="mt-6 rounded-xl border p-4 md:p-6">
        <h2 className="text-lg font-semibold">Step 2: Ask Question</h2>

        {/* ✅ Show warning if session not active */}
        {!sessionActive && documentId && (
          <p className="mt-2 text-sm text-yellow-600">⚠️ Session expired. Please upload your PDF again.</p>
        )}

        <form className="mt-4 flex flex-col gap-3" onSubmit={handleAsk}>
          <textarea
            className="min-h-24 rounded-md border p-2"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask something about your PDF..."
          />
          <button
            type="submit"
            disabled={!canAsk}
            className="w-fit rounded-md bg-blue-700 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {asking ? "Thinking..." : "Ask"}
          </button>
        </form>

        {errorMessage ? <p className="mt-4 text-sm text-red-700">{errorMessage}</p> : null}

        {answer ? (
          <div className="mt-6 rounded-md border border-indigo-900 bg-black p-4">
            <h3 className="font-semibold">Answer</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm">{answer}</p>
          </div>
        ) : null}

        {/* {sources.length > 0 ? (
          <div className="mt-4">
            <h3 className="font-semibold">Sources</h3>
            <ul className="scroll-blue mt-2 max-h-80 space-y-2 overflow-y-auto pr-1 text-sm">
              {sources.map((source, index) => (
                <li key={`${source.id}-${index}`} className="rounded-md border p-3">
                  <p className="font-medium">
                    Source {index + 1}
                    {typeof source.score === "number" ? ` | score: ${source.score.toFixed(4)}` : ""}
                  </p>
                  <p className="scroll-blue mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap pr-1 opacity-90">
                    {source.text}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null} */}
      </section>
    </main>
  );
}
