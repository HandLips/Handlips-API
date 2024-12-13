import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json()); // Untuk menangani JSON body

// Inisialisasi Google Generative AI Client
const genAI = new GoogleGenerativeAI("YOUR_API_KEY");

// Endpoint untuk mengakses Google Generative AI
app.post("/generate", async (req, res) => {
  const { topic } = req.body; // Ambil data dari request body

  // Validasi input
  if (!topic) {
    return res.status(400).json({
      error: "The 'topic' field is required",
    });
  }

  // Buat prompt tetap dengan variabel dari request body
  const prompt = `Saya membutuhkan informasi berdasarkan topik "${topic}".`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Gunakan model
    const result = await model.generateContent(prompt); // Kirim prompt ke Google Generative AI

    res.json({ response: result.response.text() }); // Kirim hasilnya
  } catch (error) {
    console.error("Error generating content:", error);
    res.status(500).json({ error: "Failed to generate content" });
  }
});

// Jalankan server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
