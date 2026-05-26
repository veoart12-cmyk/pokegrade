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

ÉTAPE 1 — IDENTIFICATION DU SET PAR TRIANGULATION VISUELLE :

Pour identifier le set, croise PLUSIEURS indices visuels simultanément. Un seul indice peut suffire s'il est très clair ; sinon croise-en au moins deux avant de conclure.

INDICE A — MARQUE DE RÉGULATION (lettre dans un petit losange, imprimée en bas de la carte) :
  F → parmi : SV1, SV2
  G → parmi : SV3, SV3a, SV4, SV4a
  H → parmi : SV5, SV5K, SV6, SV7, SV8, SV8a

INDICE B — SYMBOLE DU SET (icône juste à gauche du numéro, coin bas droit) :
  SV1  : couronne simple, fine
  SV2  : spirale / tourbillon d'évolution
  SV3  : flamme sombre ou cristal obsidien
  SV3a : cadre doré rétro (les cartes affichent le numéro Pokédex classique 001–151)
  SV4  : faille / rift en deux parties
  SV4a : étoile shiny scintillante
  SV5  : sablier ou symbole de force temporelle
  SV5K : masque stylisé
  SV6  : couronne arc-en-ciel / chromatique
  SV7  : couronne stellaire (étoiles + cercle)
  SV8  : éclair / surge électrique
  SV8a : tourbillon Paldéen

INDICE C — ANNÉE DE COPYRIGHT (texte en bas de la carte) :
  2023 → SV1, SV2, SV3, SV3a
  2024 → SV4, SV4a, SV5, SV5K, SV6, SV7, SV8, SV8a

INDICE D — THÈME VISUEL DOMINANT (ambiance générale de la carte) :
  SV3a : design nostalgique, numéro Pokédex des 151 originals affiché sur la carte
  SV4a : fond très saturé, Pokémon en version shiny (couleurs inhabituelles)
  SV7  : ambiance cosmique/stellaire, fond étoilé, Terapagos, type Teracristal
  SV8  : ambiance électrique, éclairs dorés, Pikachu/Raichu mis en avant
  SV8a : tons Paldéens, version shiny des Pokémon de Paldea

INDICE E — ART DE LA CARTE (style graphique, couleurs dominantes, décor de fond) :
  SV1  : fonds naturels lumineux, paysages de Paldea (plaines, villes), palette fraîche et variée, style propre et moderne
  SV2  : fonds dynamiques liés aux évolutions, compositions centrées sur la transformation, tons chauds et froids alternés
  SV3  : fonds sombres, volcans, lave, cristaux noirs, teintes rouges/orange/noir très prononcées, atmosphère lourde
  SV3a : style rétro japonais, fonds pastel doux, coins arrondis dorés, illustrations proches des sets Base Set / Jungle, numéro Pokédex en bas à gauche
  SV4  : fonds avec distorsions temporelles, ruines paradoxales, ambiance science-fiction et fantasy mêlées, teintes violettes et bleues profondes
  SV4a : Pokémon aux couleurs shiny (colorations inhabituelles, souvent plus pâles ou dorés), fonds très contrastés noirs ou brillants, reflets métalliques
  SV5  : fonds déserts, dunes, ambiance brûlante ou glaciale, couleurs terreuses chaudes (ocre, sable) ou glacées (bleu arctique)
  SV5K : masques et costumes, fonds festifs ou mystérieux, ambiance carnaval/déguisement, couleurs vives et décoratives
  SV6  : fonds lumineux et irisés, couronnes arc-en-ciel, cristaux multicolores, palette très variée et brillante
  SV7  : fonds cosmiques profonds (noir étoilé, nébuleuses), Pokémon entourés d'étoiles ou de lumières stellaires, Terapagos sous ses formes, teintes bleues nuit et dorées
  SV8  : fonds électriques (éclairs, orages dorés), lumière jaune/dorée intense, Pikachu et Raichu très présents, énergie cinétique, compositions dynamiques
  SV8a : fonds typiques des régions de Paldea, Pokémon en version shiny avec colorations alternatives, tons doux mais saturés

Règle : si deux indices ou plus pointent vers le même set → c'est ce set. Si les indices se contredisent ou si tu n'es pas certain → set = "Inconnu".

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

    cleanup();

    const text = response.content[0].text.trim();
    // Extraire le JSON même si Claude ajoute du texte autour
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Réponse brute:", text.slice(0, 300));
      throw new Error("Réponse IA invalide — réessaie");
    }

    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error("JSON invalide:", jsonMatch[0].slice(0, 300));
      throw new Error("Réponse IA mal formée — réessaie");
    }

    // Sauvegarder + incrémenter
    const newCount = profile.grades_this_month + 1;
    await supabase.from("profiles").update({ grades_this_month: newCount }).eq("id", req.user.id);
    await supabase.from("grades").insert({ user_id: req.user.id, result });

    res.json({
      success: true,
      result,
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
