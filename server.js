import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
// Webhook Stripe doit recevoir le body RAW — doit être AVANT express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  // Preserve query string (e.g. ?profile=UUID for public profiles)
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect("/pok%C3%A9grade_prototype.html" + qs);
});

// Clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FREE_GRADES_PER_MONTH = 3;

// ── Auth middleware ──────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Non authentifié" });
  }
  const token = auth.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: "Token invalide" });
  }
  req.user = user;
  next();
}

// ── Get current user + profile ───────────────────────────────────
app.get("/api/user", requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", req.user.id)
    .single();
  res.json({ user: req.user, profile });
});

// ── Grade history ────────────────────────────────────────────────
app.get("/api/grades", requireAuth, async (req, res) => {
  const { data: grades } = await supabase
    .from("grades")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  res.json({ grades: grades || [] });
});

// ── Grading ──────────────────────────────────────────────────────
const GRADING_PROMPT = `Tu es un expert en grading et identification de cartes Pokémon, formé aux standards PSA officiels.

ÉTAPE 1 — IDENTIFICATION DE LA CARTE :

Lis directement le texte imprimé sur la carte :
- Nom de la carte : utilise TOUJOURS le nom officiel anglais (ex : "Charizard" et non "Dracaufeu", "Gengar" et non "Ectoplasma", "Pikachu" reste "Pikachu"). C'est OBLIGATOIRE même si la carte est en français, espagnol, allemand, etc.
- Set : lis le nom du set tel qu'il est imprimé sur la carte (ex: "Scarlet & Violet", "Base Set", "Obsidian Flames"). Si non lisible, mets "Unknown".
- Numéro : lis le numéro de la carte imprimé en bas (ex: "006/165").
- Année : lis l'année du copyright imprimée en bas de la carte.
- Rareté : identifie le symbole de rareté (Common, Uncommon, Rare, Holo Rare, Ultra Rare, etc.).
- Langue : identifie la langue de la carte (Français, Anglais, Espagnol, etc.).

IMPORTANT : Ne devine jamais le set visuellement — lis uniquement ce qui est écrit sur la carte. Si le texte n'est pas lisible, mets "Unknown".

ÉTAPE 2 — GRADING : Analyse selon les 4 critères PSA (notes de 1 à 10 avec demi-points).
ÉTAPE 3 — ESTIMATION DE PRIX : Estime la valeur marchande selon le grade PSA obtenu.

Critères de grading :
1. CENTERING : Ratio des bords. 50/50 = 10, 60/40 = 8, 65/35 = 6.
2. CORNERS : Coins parfaits = 10, légère usure = 8, usure visible = 6, abîmés = 4.
3. EDGES : Bords parfaits = 10, légères marques = 8, effilochage = 6, endommagés = 4.
4. SURFACE : Aucune rayure = 10, légères marques = 8, rayures visibles = 6, dommages = 4.

Pour l'estimation de prix, base-toi sur les prix réels du marché PSA (eBay, TCGPlayer) pour cette carte ET ce set spécifique à ce grade. Donne une fourchette réaliste en euros. Si le set est "Inconnu", mets low:0 et high:0.

ÉTAPE 4 — DÉTECTION DE CONTREFAÇON : Analyse si la carte présente des signes de faux.
Indices à vérifier : qualité d'impression (pixels visibles, couleurs ternes), texture du dos (motif Pokéball flou ou déformé), police de caractères (différente de l'officielle), hologramme (absent, mal positionné ou de mauvaise qualité), bords (trop épais, trop fins ou irréguliers), brillance anormale.
Sois conservateur : ne marque is_suspect à true que si tu vois des indices clairs et multiples. En cas de doute, mets false.

Réponds UNIQUEMENT avec ce JSON (rien d'autre, pas de markdown) :
{
  "card": {
    "name": "Charizard",
    "set": "Base Set",
    "number": "4/102",
    "year": "1999",
    "rarity": "Holographic Rare",
    "language": "Anglais"
  },
  "centering": { "score": 8.5, "observation": "...", "confidence": "élevée" },
  "corners":   { "score": 7.5, "observation": "...", "confidence": "moyenne" },
  "edges":     { "score": 8.0, "observation": "...", "confidence": "élevée" },
  "surface":   { "score": 9.0, "observation": "...", "confidence": "élevée" },
  "global":    8.4,
  "psa_label": "PSA 8 — Near Mint / Mint",
  "psa_equiv": "Très bon état, légères marques d'usure non significatives.",
  "price": {
    "low": 150,
    "high": 250,
    "currency": "EUR",
    "note": "Estimation basée sur les ventes récentes PSA 8 sur eBay"
  },
  "fake_detection": {
    "is_suspect": false,
    "verdict": "Authentique",
    "confidence": "élevée",
    "indicators": []
  }
}

Pour psa_label, utilise exactement :
- 9.5-10 → "PSA 10 — Gem Mint"
- 8.5-9  → "PSA 9 — Mint"
- 7.5-8  → "PSA 8 — Near Mint / Mint"
- 6.5-7  → "PSA 7 — Near Mint"
- 5.5-6  → "PSA 6 — Excellent / Mint"
- moins  → "PSA 5 — Excellent"

Le global est la moyenne des 4 scores, arrondie au demi-point.
Si tu ne peux pas identifier la carte avec certitude, mets "Inconnue" pour name et 0 pour les prix.`;

// ── Traduction noms FR→EN (cas les plus courants) ───────────────
const FR_TO_EN = {
  'dracaufeu': 'charizard', 'salamèche': 'charmander', 'reptincel': 'charmeleon',
  'bulbizarre': 'bulbasaur', 'herbizarre': 'ivysaur', 'florizarre': 'venusaur',
  'carapuce': 'squirtle', 'carabaffe': 'wartortle', 'tortank': 'blastoise',
  'pikachu': 'pikachu', 'raichu': 'raichu', 'ronflex': 'snorlax',
  'mewtwo': 'mewtwo', 'mew': 'mew', 'evoli': 'eevee',
  'ectoplasma': 'gengar', 'spectrum': 'haunter', 'fantominus': 'gastly',
  'lokhlass': 'lapras', 'noctali': 'umbreon', 'mentali': 'espeon',
  'pyroli': 'flareon', 'aquali': 'vaporeon', 'voltali': 'jolteon',
  'sylveon': 'sylveon', 'phyllali': 'leafeon', 'givrali': 'glaceon',
  'dracolosse': 'dragonite', 'dragonair': 'dragonair', 'minidraco': 'dratini',
  'leviator': 'gyarados', 'magicarpe': 'magikarp', 'artikodin': 'articuno',
  'électhor': 'zapdos', 'sulfura': 'moltres', 'lugia': 'lugia', 'ho-oh': 'ho-oh',
  'rayquaza': 'rayquaza', 'lucario': 'lucario', 'gardevoir': 'gardevoir',
  'metagross': 'metagross', 'absol': 'absol', 'darkrai': 'darkrai',
  'cresselia': 'cresselia', 'giratina': 'giratina', 'zoroark': 'zoroark',
  'reshiram': 'reshiram', 'zekrom': 'zekrom', 'kyurem': 'kyurem',
  'grenousse': 'greninja', 'méga-dracaufeu': 'mega charizard',
  'talonflame': 'talonflame', 'tyranitar': 'tyranitar',
};

function normalizeCardName(name) {
  if (!name) return name;
  // Retire les suffixes de type " ex", " EX", " V", " VMAX", " VSTAR", " GX"
  // pour avoir le nom de base du Pokémon
  const base = name.toLowerCase()
    .replace(/\s+(ex|gx|v|vmax|vstar|mega|m\b)$/i, '')
    .trim();
  return FR_TO_EN[base] || base;
}

// ── Prix réel via Pokemon TCG API (Cardmarket EUR) ───────────────
async function fetchRealPrice(cardName, setName, psaScore) {
  try {
    // Normalise le nom : traduit FR→EN si nécessaire, retire suffixes
    const baseName = normalizeCardName(cardName);
    // Reconstruit le nom avec le suffixe d'origine (ex, VMAX, etc.)
    const suffix = cardName.match(/\s+(ex|EX|GX|V|VMAX|VSTAR|MEGA)$/i)?.[1] || '';
    const englishName = suffix
      ? `${baseName.charAt(0).toUpperCase() + baseName.slice(1)} ${suffix}`
      : (FR_TO_EN[cardName.toLowerCase()] || cardName);

    console.log(`[Price] Recherche "${cardName}" → normalisé "${englishName}"`);

    // Stratégies de recherche par ordre de précision décroissante
    const firstWord = baseName.split(' ')[0];
    const queries = [
      `name:"${englishName}"`,           // Nom anglais exact
      `name:"${cardName}"`,              // Nom original (fonctionne si déjà EN)
      `name:${englishName}`,             // Nom anglais sans guillemets
      `name:${firstWord}`,               // Premier mot seulement
    ].filter((q, i, arr) => arr.indexOf(q) === i); // Déduplication

    let card = null;
    for (const q of queries) {
      const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=30&select=name,set,cardmarket,tcgplayer,rarity`;
      const headers = {};
      if (process.env.POKEMON_TCG_KEY) headers['X-Api-Key'] = process.env.POKEMON_TCG_KEY;
      try {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (!data.data?.length) continue;

        // Trouver la meilleure correspondance
        let candidates = data.data;

        // Filtrer par set si disponible et fiable
        if (setName && setName !== 'Inconnu' && setName !== 'Unknown' && setName !== 'Inconnue') {
          const sLow = setName.toLowerCase().replace(/[^a-z0-9\s]/g, '');
          const setMatch = candidates.filter(c => {
            const cSet = (c.set?.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '');
            return cSet.includes(sLow) || sLow.includes(cSet);
          });
          if (setMatch.length > 0) candidates = setMatch;
        }

        // Préférer les cartes avec prix Cardmarket disponibles
        const withCmPrice = candidates.filter(c => {
          const cm = c.cardmarket?.prices;
          return cm && (cm.avg30 || cm.trendPrice || cm.avg7 || cm.averageSellPrice);
        });
        if (withCmPrice.length > 0) candidates = withCmPrice;

        // Préférer les cartes avec le bon suffixe (ex, VMAX, etc.)
        if (suffix) {
          const suffixMatch = candidates.filter(c =>
            c.name?.toLowerCase().includes(suffix.toLowerCase())
          );
          if (suffixMatch.length > 0) candidates = suffixMatch;
        }

        card = candidates[0];
        if (card) {
          console.log(`[Price] Trouvé via "${q}": ${card.name} (${card.set?.name})`);
          break;
        }
      } catch (fetchErr) {
        console.error(`[Price] Erreur requête "${q}":`, fetchErr.message);
        continue;
      }
    }

    if (!card) return null;

    // Prix Cardmarket en EUR (source prioritaire)
    const cm = card.cardmarket?.prices;
    let rawEur = null;
    if (cm) {
      // avg30 > trendPrice > avg7 > averageSellPrice (par ordre de fiabilité)
      rawEur = cm.avg30 || cm.trendPrice || cm.avg7 || cm.averageSellPrice;
    }

    // Fallback TCGPlayer USD → EUR (×0.92 approx)
    if (!rawEur || rawEur <= 0) {
      const tcp = card.tcgplayer?.prices || {};
      const usd = tcp.holofoil?.market || tcp.reverseHolofoil?.market ||
                  tcp.normal?.market  || tcp['1stEditionHolofoil']?.market;
      if (usd) rawEur = usd * 0.92;
    }

    if (!rawEur || rawEur <= 0) return null;

    // Coefficients PSA par grade (basés sur les données marchés réels)
    const psaNum = psaScore >= 9.5 ? 10 : psaScore >= 8.5 ? 9 : psaScore >= 7.5 ? 8 :
                   psaScore >= 6.5 ? 7  : psaScore >= 5.5 ? 6 : 5;
    const coeffs = {
      10: { low: 3.5, high: 7.0 },
      9:  { low: 1.8, high: 3.5 },
      8:  { low: 1.3, high: 2.0 },
      7:  { low: 1.0, high: 1.5 },
      6:  { low: 0.8, high: 1.1 },
      5:  { low: 0.6, high: 0.9 },
    };
    const c = coeffs[psaNum] || coeffs[5];

    // Calcul sans plancher artificiel — on respecte le vrai prix de marché
    const rawLow  = rawEur * c.low;
    const rawHigh = rawEur * c.high;

    // Formater avec la bonne précision selon la valeur
    function fmtEur(v) {
      if (v < 0.1)  return parseFloat(v.toFixed(3));
      if (v < 1)    return parseFloat(v.toFixed(2));
      if (v < 10)   return parseFloat(v.toFixed(1));
      return Math.round(v);
    }
    const low  = fmtEur(rawLow);
    const high = fmtEur(Math.max(rawHigh, rawLow * 1.1)); // high toujours > low

    const source = cm ? 'Cardmarket' : 'TCGPlayer';
    // Avertissement si la carte vaut moins d'1€ (grading non rentable)
    const worthNote = rawEur < 1
      ? ` ⚠️ Carte peu valorisée — grading PSA (~25€) non rentable`
      : '';
    const note = `Source : ${source} (${rawEur.toFixed(2)}€) × coeff. PSA ${psaNum}${worthNote}`;
    console.log(`[Price] ${cardName} → ${rawEur.toFixed(3)}€ brut → PSA${psaNum}: ${low}–${high}€`);

    return { low, high, currency: 'EUR', note, source: source.toLowerCase() };
  } catch (e) {
    console.error('fetchRealPrice error:', e.message);
    return null;
  }
}

app.post("/api/grade", requireAuth, upload.fields([{ name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }]), async (req, res) => {
  const files = req.files || {};
  const frontFile = files.front?.[0];
  const backFile  = files.back?.[0];

  const cleanup = () => {
    if (frontFile && fs.existsSync(frontFile.path)) fs.unlinkSync(frontFile.path);
    if (backFile  && fs.existsSync(backFile.path))  fs.unlinkSync(backFile.path);
  };

  try {
    // Récupérer le profil
    let { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single();

    // Reset mensuel
    const lastReset = new Date(profile.last_reset_date);
    const now = new Date();
    const isNewMonth =
      lastReset.getMonth() !== now.getMonth() ||
      lastReset.getFullYear() !== now.getFullYear();

    if (isNewMonth) {
      await supabase
        .from("profiles")
        .update({ grades_this_month: 0, last_reset_date: now.toISOString().split("T")[0] })
        .eq("id", req.user.id);
      profile.grades_this_month = 0;
    }

    // Vérifier quota
    if (!profile.is_premium && profile.grades_this_month >= FREE_GRADES_PER_MONTH) {
      cleanup();
      return res.status(402).json({ error: "Limite atteinte", upgrade: true });
    }

    if (!frontFile) { cleanup(); return res.status(400).json({ error: "Photo recto manquante" }); }

    // Construire le contenu : recto obligatoire, verso optionnel
    const imageContent = [
      { type: "image", source: { type: "base64", media_type: frontFile.mimetype || "image/jpeg", data: fs.readFileSync(frontFile.path).toString("base64") } },
    ];
    if (backFile) {
      imageContent.push({ type: "image", source: { type: "base64", media_type: backFile.mimetype || "image/jpeg", data: fs.readFileSync(backFile.path).toString("base64") } });
    }
    const prompt = backFile
      ? "La première image est le RECTO de la carte, la deuxième est le VERSO. " + GRADING_PROMPT
      : GRADING_PROMPT;

    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: [...imageContent, { type: "text", text: prompt }] }],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      cleanup();
      console.error("Réponse brute:", text.slice(0, 300));
      throw new Error("Réponse IA invalide — réessaie");
    }

    // Upload de la photo recto dans Supabase Storage (avant cleanup)
    let imageUrl = null;
    try {
      const imgBuffer = fs.readFileSync(frontFile.path);
      const ext = (frontFile.mimetype || "").includes("png") ? "png" : "jpg";
      const fileName = `${req.user.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("card-images")
        .upload(fileName, imgBuffer, { contentType: frontFile.mimetype || "image/jpeg" });
      if (!upErr) {
        const { data: urlData } = supabase.storage.from("card-images").getPublicUrl(fileName);
        imageUrl = urlData?.publicUrl || null;
        console.log(`Photo stockée : ${imageUrl}`);
      } else {
        console.error("Storage upload error:", upErr.message);
      }
    } catch (upEx) {
      console.error("Storage exception:", upEx.message);
    }

    cleanup();

    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error("JSON invalide:", jsonMatch[0].slice(0, 300));
      throw new Error("Réponse IA mal formée — réessaie");
    }

    // ── Remplacer l'estimation IA par les vrais prix Cardmarket ──
    const cardName = result.card?.name;
    const setName  = result.card?.set;
    if (cardName && cardName !== 'Inconnue' && cardName !== 'Unknown') {
      const realPrice = await fetchRealPrice(cardName, setName, result.global || 0);
      if (realPrice) {
        result.price = realPrice;
        console.log(`[Price] Remplacement IA → Cardmarket: ${realPrice.low}–${realPrice.high}€`);
      } else {
        console.log(`[Price] Cardmarket introuvable pour "${cardName}", conservation estimation IA`);
      }
    }

    // Incrémenter le quota (le grade est consommé même sans sauvegarde)
    const newCount = profile.grades_this_month + 1;
    await supabase.from("profiles").update({ grades_this_month: newCount }).eq("id", req.user.id);
    // NOTE : on ne sauvegarde PAS dans grades ici — l'utilisateur choisit via /api/grade/save

    res.json({
      success: true,
      result,
      image_url: imageUrl,
      grades_used: newCount,
      grades_remaining: profile.is_premium ? "∞" : Math.max(0, FREE_GRADES_PER_MONTH - newCount),
      is_premium: profile.is_premium,
    });
  } catch (err) {
    console.error("Erreur analyse:", err.message);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ── Sauvegarde optionnelle dans la collection ────────────────────
app.post("/api/grade/save", requireAuth, async (req, res) => {
  const { result, image_url } = req.body;
  if (!result) return res.status(400).json({ error: "Résultat manquant" });
  try {
    await supabase.from("grades").insert({
      user_id: req.user.id,
      result,
      image_url: image_url || null,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Erreur save:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Suppression d'une carte de la collection ─────────────────────
app.delete("/api/grade/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Vérifier que la carte appartient bien à l'utilisateur, et récupérer l'image_url
    const { data: grade, error: fetchErr } = await supabase
      .from("grades")
      .select("id, user_id, image_url")
      .eq("id", id)
      .eq("user_id", req.user.id)
      .single();

    if (fetchErr || !grade) {
      return res.status(404).json({ error: "Carte introuvable ou accès refusé" });
    }

    // Supprimer l'image dans Supabase Storage si elle existe
    if (grade.image_url) {
      try {
        // L'URL publique ressemble à : .../storage/v1/object/public/card-images/USER_ID/FILENAME
        const match = grade.image_url.match(/card-images\/(.+)$/);
        if (match) {
          await supabase.storage.from("card-images").remove([match[1]]);
        }
      } catch (imgErr) {
        console.error("Erreur suppression image Storage:", imgErr.message);
        // Non bloquant — on continue la suppression DB
      }
    }

    // Supprimer la ligne dans grades
    const { error: delErr } = await supabase
      .from("grades")
      .delete()
      .eq("id", id)
      .eq("user_id", req.user.id);

    if (delErr) throw delErr;

    res.json({ success: true });
  } catch (err) {
    console.error("Erreur suppression grade:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Set profile (username / public toggle) ───────────────────────
app.post("/api/set-profile", requireAuth, async (req, res) => {
  const { username, is_collection_public } = req.body;
  const updates = {};
  if (typeof username === "string") {
    const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (clean.length < 3 || clean.length > 20) {
      return res.status(400).json({ error: "Pseudo invalide (3–20 caractères, lettres et chiffres)" });
    }
    updates.username = clean;
  }
  if (typeof is_collection_public === "boolean") {
    updates.is_collection_public = is_collection_public;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Aucune donnée à mettre à jour" });
  }
  const { error } = await supabase.from("profiles").update(updates).eq("id", req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Public collection profile ────────────────────────────────────
app.get("/api/public/:userId", async (req, res) => {
  const { userId } = req.params;
  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("username, is_collection_public")
    .eq("id", userId)
    .single();
  if (pErr || !profile?.is_collection_public) {
    return res.status(403).json({ error: "Ce profil n'est pas public" });
  }
  const { data: grades } = await supabase
    .from("grades")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  res.json({ username: profile.username || null, grades: grades || [] });
});

// ── Stripe checkout ──────────────────────────────────────────────
app.post("/api/create-checkout", requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", req.user.id)
      .single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { user_id: req.user.id },
      });
      customerId = customer.id;
      await supabase.from("profiles").update({ stripe_customer_id: customerId }).eq("id", req.user.id);
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/pok%C3%A9grade_prototype.html?success=true`,
      cancel_url: `${origin}/pok%C3%A9grade_prototype.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur checkout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe webhook ───────────────────────────────────────────────
app.post("/api/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Webhook reçu:", event.type);

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    const isActive = sub.status === "active";
    console.log(`Mise à jour premium: customer=${sub.customer}, active=${isActive}`);
    const { error } = await supabase.from("profiles")
      .update({ is_premium: isActive, stripe_subscription_id: sub.id })
      .eq("stripe_customer_id", sub.customer);
    if (error) console.error("Supabase update error:", error.message);
  }

  if (event.type === "customer.subscription.deleted") {
    const { error } = await supabase.from("profiles")
      .update({ is_premium: false, stripe_subscription_id: null })
      .eq("stripe_customer_id", event.data.object.customer);
    if (error) console.error("Supabase update error:", error.message);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Serveur PokeGrade démarré`);
  console.log(`👉 Ouvre http://localhost:${PORT}/pokégrade_prototype.html\n`);
});
