import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.redirect("/pokégrade_prototype.html");
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const GRADING_PROMPT = `Tu es un expert en grading de cartes Pokémon, formé aux standards PSA officiels. Analyse cette carte selon les 4 critères PSA.

Pour chaque critère, donne une note de 1 à 10 (avec des demi-points comme 7.5, 8.5, etc.) :

1. CENTERING : La carte est-elle bien centrée ? Mesure visuellement le ratio des bords gauche/droit et haut/bas. Un ratio 50/50 = 10, un ratio 60/40 = 8, un ratio 65/35 = 6.
2. CORNERS : État des 4 coins. Coins parfaitement nets = 10, légère usure = 8, usure visible = 6, coins abîmés = 4.
3. EDGES : État des 4 bords. Bords parfaits = 10, légères marques = 8, effilochage visible = 6, bords endommagés = 4.
4. SURFACE : État de la surface recto/verso. Aucune rayure = 10, légères marques = 8, rayures visibles = 6, dommages importants = 4.

Réponds UNIQUEMENT avec ce JSON (rien d'autre) :
{
  "centering": { "score": 8.5, "observation": "...", "confidence": "élevée" },
  "corners":   { "score": 7.5, "observation": "...", "confidence": "moyenne" },
  "edges":     { "score": 8.0, "observation": "...", "confidence": "élevée" },
  "surface":   { "score": 9.0, "observation": "...", "confidence": "élevée" },
  "global":    8.4,
  "psa_label": "PSA 8 — Near Mint / Mint",
  "psa_equiv": "Très bon état, légères marques d'usure non significatives."
}

Pour psa_label, utilise exactement :
- 9.5-10 → "PSA 10 — Gem Mint"
- 8.5-9  → "PSA 9 — Mint"
- 7.5-8  → "PSA 8 — Near Mint / Mint"
- 6.5-7  → "PSA 7 — Near Mint"
- 5.5-6  → "PSA 6 — Excellent / Mint"
- moins  → "PSA 5 — Excellent"

Le global est la moyenne des 4 scores, arrondie au demi-point.`;

app.post("/api/grade", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucune image reçue" });
    }

    const imageData = fs.readFileSync(req.file.path);
    const base64Image = imageData.toString("base64");
    const mimeType = req.file.mimetype || "image/jpeg";

    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: base64Image,
              },
            },
            {
              type: "text",
              text: GRADING_PROMPT,
            },
          ],
        },
      ],
    });

    // Cleanup uploaded file
    fs.unlinkSync(req.file.path);

    const text = response.content[0].text.trim();

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Réponse IA invalide");
    }

    const result = JSON.parse(jsonMatch[0]);
    res.json({ success: true, result });
  } catch (err) {
    console.error("Erreur analyse:", err.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Serveur PokeGrade démarré`);
  console.log(`👉 Ouvre http://localhost:${PORT}/pokégrade_prototype.html\n`);
});
