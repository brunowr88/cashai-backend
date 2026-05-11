require("dotenv").config();

const express      = require("express");
const cors         = require("cors");
const axios        = require("axios");
const { createClient } = require("@supabase/supabase-js");
const Anthropic    = require("@anthropic-ai/sdk");

const SUPABASE_URL         = process.env.SUPABASE_URL         || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const PLUGGY_CLIENT_ID     = process.env.PLUGGY_CLIENT_ID     || "";
const PLUGGY_CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET || "";
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY    || "";
const PLUGGY_BASE_URL      = "https://api.pluggy.ai";

console.log("=== CashAI Backend iniciando ===");
console.log("SUPABASE_URL:", SUPABASE_URL ? "OK (" + SUPABASE_URL.substring(0,30) + "...)" : "MISSING");
console.log("SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "OK" : "MISSING");
console.log("PLUGGY_CLIENT_ID:", PLUGGY_CLIENT_ID ? "OK" : "MISSING");
console.log("ANTHROPIC_API_KEY:", ANTHROPIC_API_KEY ? "OK" : "MISSING");

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("ERRO FATAL: Variáveis do Supabase ausentes!");
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const claude   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));
app.use(express.json({ limit: "10mb" }));

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Token ausente" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Token inválido" });
  req.user = data.user;
  next();
}

let pluggyApiKey = null;
let pluggyApiKeyExpiry = 0;

async function getPluggyApiKey() {
  if (pluggyApiKey && Date.now() < pluggyApiKeyExpiry) return pluggyApiKey;
  const res = await axios.post(`${PLUGGY_BASE_URL}/auth`, {
    clientId: PLUGGY_CLIENT_ID,
    clientSecret: PLUGGY_CLIENT_SECRET,
  });
  pluggyApiKey = res.data.apiKey;
  pluggyApiKeyExpiry = Date.now() + 1.5 * 60 * 60 * 1000;
  return pluggyApiKey;
}

const pluggyHeaders = (apiKey) => ({ "X-API-KEY": apiKey, "Content-Type": "application/json" });

function mapCategory(pluggyCategory) {
  if (!pluggyCategory) return "outros";
  const c = pluggyCategory.toLowerCase();
  if (c.includes("supermercado") || c.includes("mercado")) return "mercado";
  if (c.includes("combusti") || c.includes("posto") || c.includes("gasolina")) return "combustivel";
  if (c.includes("restaurante") || c.includes("lanchonete") || c.includes("cafe") || c.includes("alimenta")) return "alimentacao";
  if (c.includes("delivery") || c.includes("ifood") || c.includes("rappi")) return "delivery";
  if (c.includes("farmacia") || c.includes("drogaria") || c.includes("saude")) return "farmacia";
  if (c.includes("uber") || c.includes("taxi") || c.includes("transporte") || c.includes("metro")) return "transporte";
  if (c.includes("salario") || c.includes("folha") || c.includes("pagamento recebido")) return "salario";
  if (c.includes("transfer") || c.includes("pix")) return "pix";
  if (c.includes("academia") || c.includes("esporte")) return "academia";
  if (c.includes("assinatura") || c.includes("streaming") || c.includes("netflix") || c.includes("spotify")) return "assinatura";
  if (c.includes("lazer") || c.includes("entretenimento") || c.includes("cinema")) return "lazer";
  return "outros";
}

function normalizeTx(pluggyTx, userId, itemId, bankName) {
  return {
    user_id: userId,
    pluggy_tx_id: pluggyTx.id,
    pluggy_item_id: itemId,
    type: pluggyTx.type === "CREDIT" ? "income" : "expense",
    description: pluggyTx.description || pluggyTx.descriptionRaw || "Transação",
    category: mapCategory(pluggyTx.category),
    value: Math.abs(pluggyTx.amount),
    transaction_date: pluggyTx.date,
    bank_name: bankName || null,
    source: "pluggy",
    raw_data: pluggyTx,
  };
}

app.get("/", (req, res) => res.json({ status: "ok", app: "CashAI Backend v1.0" }));

app.post("/pluggy/connect-token", authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.body;
    const apiKey = await getPluggyApiKey();
    const payload = itemId ? { itemId } : {};
    const response = await axios.post(`${PLUGGY_BASE_URL}/connect_token`, payload, { headers: pluggyHeaders(apiKey) });
    res.json({ connectToken: response.data.accessToken });
  } catch (err) {
    console.error("Erro connect-token:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao gerar token" });
  }
});

app.post("/pluggy/save-item", authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "itemId obrigatório" });
    const apiKey = await getPluggyApiKey();
    const itemRes = await axios.get(`${PLUGGY_BASE_URL}/items/${itemId}`, { headers: pluggyHeaders(apiKey) });
    const item = itemRes.data;
    const bankName = item.connector?.name || "Banco";
    const { data, error } = await supabase.from("bank_connections").upsert({
      user_id: req.user.id, pluggy_item_id: itemId, bank_name: bankName,
      status: item.status, connector_id: item.connector?.id, connector_data: item.connector,
    }, { onConflict: "pluggy_item_id" }).select().single();
    if (error) throw error;
    syncUserTransactions(req.user.id, itemId).catch(console.error);
    res.json({ connection: data, bankName });
  } catch (err) {
    console.error("Erro save-item:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao salvar conexão" });
  }
});

app.get("/pluggy/connections", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("bank_connections").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: "Erro ao listar conexões" });
  }
});

app.post("/pluggy/sync/:itemId", authMiddleware, async (req, res) => {
  try {
    const result = await syncUserTransactions(req.user.id, req.params.itemId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Erro ao sincronizar" });
  }
});

app.delete("/pluggy/connection/:itemId", authMiddleware, async (req, res) => {
  try {
    const apiKey = await getPluggyApiKey();
    await axios.delete(`${PLUGGY_BASE_URL}/items/${req.params.itemId}`, { headers: pluggyHeaders(apiKey) }).catch(() => {});
    await supabase.from("bank_connections").delete().eq("user_id", req.user.id).eq("pluggy_item_id", req.params.itemId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao desconectar" });
  }
});

async function syncUserTransactions(userId, itemId, days = 90) {
  const apiKey = await getPluggyApiKey();
  const accountsRes = await axios.get(`${PLUGGY_BASE_URL}/accounts?itemId=${itemId}`, { headers: pluggyHeaders(apiKey) });
  const accounts = accountsRes.data.results || [];
  if (accounts.length === 0) return { transactions: 0, message: "Nenhuma conta encontrada" };
  const { data: conn } = await supabase.from("bank_connections").select("bank_name").eq("pluggy_item_id", itemId).single();
  const bankName = conn?.bank_name || "Banco";
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const from = fromDate.toISOString().split("T")[0];
  const to = toDate.toISOString().split("T")[0];
  const txPromises = accounts.map(acc =>
    axios.get(`${PLUGGY_BASE_URL}/transactions?accountId=${acc.id}&from=${from}&to=${to}&pageSize=500`, { headers: pluggyHeaders(apiKey) })
      .then(r => r.data.results || []).catch(() => [])
  );
  const allTxs = (await Promise.all(txPromises)).flat();
  const normalized = allTxs.map(tx => normalizeTx(tx, userId, itemId, bankName));
  let inserted = 0;
  if (normalized.length > 0) {
    const { error, count } = await supabase.from("transactions").upsert(normalized, { onConflict: "pluggy_tx_id", count: "exact" });
    if (error) throw error;
    inserted = count || normalized.length;
  }
  await supabase.from("bank_connections").update({ last_sync: new Date().toISOString() }).eq("pluggy_item_id", itemId);
  return { success: true, transactions: inserted, accounts: accounts.length, period: { from, to } };
}

app.get("/transactions", authMiddleware, async (req, res) => {
  try {
    const { type, category, search, limit = 200 } = req.query;
    let query = supabase.from("transactions").select("*").eq("user_id", req.user.id).order("transaction_date", { ascending: false }).limit(parseInt(limit));
    if (type) query = query.eq("type", type);
    if (category) query = query.eq("category", category);
    if (search) query = query.ilike("description", `%${search}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/transactions", authMiddleware, async (req, res) => {
  try {
    const { type, description, category, value, payment_method, bank_name } = req.body;
    const { data, error } = await supabase.from("transactions").insert({
      user_id: req.user.id, type, description, category: category || "outros",
      value: parseFloat(value), payment_method, bank_name,
      transaction_date: new Date().toISOString(), source: "manual",
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/transactions/:id", authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase.from("transactions").delete().eq("id", req.params.id).eq("user_id", req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/ai/parse", authMiddleware, async (req, res) => {
  try {
    const { text, mode } = req.body;
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `Você interpreta mensagens financeiras em português brasileiro. Retorne APENAS JSON válido (sem markdown):
{"type":"expense ou income","description":"descrição curta capitalizada","category":"mercado|combustivel|delivery|farmacia|transporte|lazer|salario|pix|academia|assinatura|alimentacao|outros","value":numero,"payment_method":"credito|debito|pix|dinheiro|boleto ou null","bank_name":"Nubank|Santander|Bradesco|Itaú|Inter|C6|Caixa|BB|BTG|XP|PicPay ou null","reply":"mensagem amigável confirmando registro com emoji"}
Regras: modo atual="${mode}". Salário/freelance/pix recebido = income.`,
      messages: [{ role: "user", content: text }],
    });
    const raw = response.content[0].text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    if (parsed.value > 0) {
      const { data } = await supabase.from("transactions").insert({
        user_id: req.user.id, type: parsed.type, description: parsed.description,
        category: parsed.category, value: parsed.value, payment_method: parsed.payment_method,
        bank_name: parsed.bank_name, transaction_date: new Date().toISOString(), source: "chat",
      }).select().single();
      parsed.transaction = data;
    }
    res.json(parsed);
  } catch (err) {
    console.error("Erro AI parse:", err.message);
    res.status(500).json({ error: "Erro ao processar mensagem" });
  }
});

app.post("/ai/scan", authMiddleware, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `Analise a imagem financeira. Retorne APENAS JSON válido:
{"description":"estabelecimento","value":numero,"category":"categoria","transaction_date":"YYYY-MM-DD ou null","payment_method":"credito|debito|pix|dinheiro ou null","reply":"confirmação amigável"}`,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 }},
        { type: "text", text: "Extraia os dados financeiros desta imagem." }
      ]}],
    });
    const parsed = JSON.parse(response.content[0].text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (err) {
    console.error("Erro AI scan:", err.message);
    res.status(500).json({ error: "Erro ao analisar imagem" });
  }
});

app.get("/ai/insights", authMiddleware, async (req, res) => {
  try {
    const { data: txs } = await supabase.from("transactions").select("type, description, category, value, transaction_date")
      .eq("user_id", req.user.id).order("transaction_date", { ascending: false }).limit(100);
    if (!txs || txs.length === 0) {
      return res.json({ insights: [{ icon: "👋", title: "Comece agora", body: "Adicione transações ou conecte um banco para receber insights.", type: "neutral" }] });
    }
    const summary = txs.map(t => `${t.type}: ${t.description} R$${t.value} (${t.category})`).join("\n");
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: `Analise as transações e retorne APENAS JSON válido:
{"insights":[{"icon":"emoji","title":"título curto","body":"análise em 1-2 frases","type":"warning|tip|positive|neutral"}]}
Gere 5 insights específicos e acionáveis.`,
      messages: [{ role: "user", content: `Transações:\n${summary}` }],
    });
    const parsed = JSON.parse(response.content[0].text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (err) {
    console.error("Erro AI insights:", err.message);
    res.status(500).json({ error: "Erro ao gerar insights" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ CashAI Backend rodando na porta ${PORT}`);
  console.log(`📊 Supabase: ${SUPABASE_URL ? "OK" : "❌"}`);
  console.log(`🔗 Pluggy:   ${PLUGGY_CLIENT_ID ? "OK" : "❌"}`);
  console.log(`🤖 Claude:   ${ANTHROPIC_API_KEY ? "OK" : "❌"}`);
});