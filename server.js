/**
 * CashAI Backend
 * Node.js + Express + Pluggy Open Finance + Supabase + Claude AI
 * Deploy: Railway
 */

require("dotenv").config();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
console.log("SUPABASE_URL:", SUPABASE_URL ? "OK" : "MISSING");
const express      = require("express");
const cors         = require("cors");
const axios        = require("axios");
const { createClient } = require("@supabase/supabase-js");
const Anthropic    = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Config ───────────────────────────────────────────────────────────────────
const PLUGGY_CLIENT_ID     = process.env.PLUGGY_CLIENT_ID;
const PLUGGY_CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;
const PLUGGY_BASE_URL      = "https://api.pluggy.ai";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
// Valida o JWT do Supabase enviado pelo frontend e popula req.user
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Token ausente" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Token inválido" });

  req.user = data.user;
  next();
}

// ─── Pluggy API Key Cache ─────────────────────────────────────────────────────
let pluggyApiKey       = null;
let pluggyApiKeyExpiry = 0;

async function getPluggyApiKey() {
  if (pluggyApiKey && Date.now() < pluggyApiKeyExpiry) return pluggyApiKey;
  const res = await axios.post(`${PLUGGY_BASE_URL}/auth`, {
    clientId:     PLUGGY_CLIENT_ID,
    clientSecret: PLUGGY_CLIENT_SECRET,
  });
  pluggyApiKey       = res.data.apiKey;
  pluggyApiKeyExpiry = Date.now() + 1.5 * 60 * 60 * 1000;
  return pluggyApiKey;
}

const pluggyHeaders = (apiKey) => ({
  "X-API-KEY": apiKey,
  "Content-Type": "application/json",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function mapCategory(pluggyCategory) {
  if (!pluggyCategory) return "outros";
  const c = pluggyCategory.toLowerCase();
  if (c.includes("supermercado") || c.includes("mercado")) return "mercado";
  if (c.includes("combusti") || c.includes("posto") || c.includes("gasolina")) return "combustivel";
  if (c.includes("restaurante") || c.includes("lanchonete") || c.includes("cafe") || c.includes("alimenta")) return "alimentacao";
  if (c.includes("delivery") || c.includes("ifood") || c.includes("rappi")) return "delivery";
  if (c.includes("farmácia") || c.includes("farmacia") || c.includes("drogaria") || c.includes("saúde")) return "farmacia";
  if (c.includes("uber") || c.includes("taxi") || c.includes("transporte") || c.includes("ônibus") || c.includes("metro")) return "transporte";
  if (c.includes("salário") || c.includes("salario") || c.includes("folha") || c.includes("pagamento recebido")) return "salario";
  if (c.includes("transfer") || c.includes("pix")) return "pix";
  if (c.includes("academia") || c.includes("esporte")) return "academia";
  if (c.includes("assinatura") || c.includes("streaming") || c.includes("netflix") || c.includes("spotify")) return "assinatura";
  if (c.includes("lazer") || c.includes("entretenimento") || c.includes("cinema")) return "lazer";
  return "outros";
}

function normalizeTx(pluggyTx, userId, itemId, bankName) {
  return {
    user_id:        userId,
    pluggy_tx_id:   pluggyTx.id,
    pluggy_item_id: itemId,
    type:           pluggyTx.type === "CREDIT" ? "income" : "expense",
    description:    pluggyTx.description || pluggyTx.descriptionRaw || "Transação",
    category:       mapCategory(pluggyTx.category),
    value:          Math.abs(pluggyTx.amount),
    transaction_date: pluggyTx.date,
    bank_name:      bankName || null,
    source:         "pluggy",
    raw_data:       pluggyTx,
  };
}

// ─── Rotas Públicas ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", app: "CashAI Backend v1.0" }));

// ════════════════════════════════════════════════════════════════════════════
// ROTAS AUTENTICADAS - Todas exigem JWT do Supabase
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /pluggy/connect-token
 * Gera token temporário para abrir o Pluggy Widget no frontend
 */
app.post("/pluggy/connect-token", authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.body;
    const apiKey = await getPluggyApiKey();
    const payload = itemId ? { itemId } : {};
    const response = await axios.post(
      `${PLUGGY_BASE_URL}/connect_token`,
      payload,
      { headers: pluggyHeaders(apiKey) }
    );
    res.json({ connectToken: response.data.accessToken });
  } catch (err) {
    console.error("Erro connect-token:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao gerar token" });
  }
});

/**
 * POST /pluggy/save-item
 * Salva o item (conexão bancária) no banco após o usuário conectar pelo widget
 */
app.post("/pluggy/save-item", authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "itemId obrigatório" });

    const apiKey = await getPluggyApiKey();
    const itemRes = await axios.get(
      `${PLUGGY_BASE_URL}/items/${itemId}`,
      { headers: pluggyHeaders(apiKey) }
    );

    const item = itemRes.data;
    const bankName = item.connector?.name || "Banco";

    const { data, error } = await supabase
      .from("bank_connections")
      .upsert({
        user_id:        req.user.id,
        pluggy_item_id: itemId,
        bank_name:      bankName,
        status:         item.status,
        connector_id:   item.connector?.id,
        connector_data: item.connector,
      }, { onConflict: "pluggy_item_id" })
      .select()
      .single();

    if (error) throw error;

    // Sincroniza transações imediatamente
    syncUserTransactions(req.user.id, itemId).catch(console.error);

    res.json({ connection: data, bankName });
  } catch (err) {
    console.error("Erro save-item:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao salvar conexão" });
  }
});

/**
 * GET /pluggy/connections
 * Lista bancos conectados do usuário
 */
app.get("/pluggy/connections", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("bank_connections")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Erro connections:", err.message);
    res.status(500).json({ error: "Erro ao listar conexões" });
  }
});

/**
 * POST /pluggy/sync/:itemId
 * Sincroniza transações de um banco específico
 */
app.post("/pluggy/sync/:itemId", authMiddleware, async (req, res) => {
  try {
    const result = await syncUserTransactions(req.user.id, req.params.itemId);
    res.json(result);
  } catch (err) {
    console.error("Erro sync:", err.message);
    res.status(500).json({ error: "Erro ao sincronizar" });
  }
});

/**
 * DELETE /pluggy/connection/:itemId
 * Desconecta um banco
 */
app.delete("/pluggy/connection/:itemId", authMiddleware, async (req, res) => {
  try {
    const apiKey = await getPluggyApiKey();
    await axios.delete(
      `${PLUGGY_BASE_URL}/items/${req.params.itemId}`,
      { headers: pluggyHeaders(apiKey) }
    ).catch(() => {}); // Ignora erro se item já foi removido

    await supabase
      .from("bank_connections")
      .delete()
      .eq("user_id", req.user.id)
      .eq("pluggy_item_id", req.params.itemId);

    res.json({ success: true });
  } catch (err) {
    console.error("Erro delete connection:", err.message);
    res.status(500).json({ error: "Erro ao desconectar" });
  }
});

// ─── Função interna de sincronização ─────────────────────────────────────────
async function syncUserTransactions(userId, itemId, days = 90) {
  const apiKey = await getPluggyApiKey();

  // 1. Busca contas
  const accountsRes = await axios.get(
    `${PLUGGY_BASE_URL}/accounts?itemId=${itemId}`,
    { headers: pluggyHeaders(apiKey) }
  );
  const accounts = accountsRes.data.results || [];

  if (accounts.length === 0) return { transactions: 0, message: "Nenhuma conta encontrada" };

  // 2. Pega nome do banco
  const { data: conn } = await supabase
    .from("bank_connections")
    .select("bank_name")
    .eq("pluggy_item_id", itemId)
    .single();
  const bankName = conn?.bank_name || "Banco";

  // 3. Período
  const toDate   = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const from = fromDate.toISOString().split("T")[0];
  const to   = toDate.toISOString().split("T")[0];

  // 4. Busca transações em paralelo
  const txPromises = accounts.map(acc =>
    axios.get(
      `${PLUGGY_BASE_URL}/transactions?accountId=${acc.id}&from=${from}&to=${to}&pageSize=500`,
      { headers: pluggyHeaders(apiKey) }
    ).then(r => (r.data.results || [])).catch(() => [])
  );

  const allTxs = (await Promise.all(txPromises)).flat();
  const normalized = allTxs.map(tx => normalizeTx(tx, userId, itemId, bankName));

  // 5. Upsert no banco (evita duplicatas via pluggy_tx_id)
  let inserted = 0;
  if (normalized.length > 0) {
    const { error, count } = await supabase
      .from("transactions")
      .upsert(normalized, { onConflict: "pluggy_tx_id", count: "exact" });
    if (error) throw error;
    inserted = count || normalized.length;
  }

  // 6. Atualiza last_sync
  await supabase
    .from("bank_connections")
    .update({ last_sync: new Date().toISOString() })
    .eq("pluggy_item_id", itemId);

  return {
    success: true,
    transactions: inserted,
    accounts: accounts.length,
    period: { from, to },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TRANSAÇÕES
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /transactions
 * Lista transações do usuário (com filtros)
 */
app.get("/transactions", authMiddleware, async (req, res) => {
  try {
    const { type, category, search, limit = 200 } = req.query;
    let query = supabase
      .from("transactions")
      .select("*")
      .eq("user_id", req.user.id)
      .order("transaction_date", { ascending: false })
      .limit(parseInt(limit));

    if (type)     query = query.eq("type", type);
    if (category) query = query.eq("category", category);
    if (search)   query = query.ilike("description", `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /transactions
 * Cria transação manual (do chat ou scanner)
 */
app.post("/transactions", authMiddleware, async (req, res) => {
  try {
    const { type, description, category, value, payment_method, bank_name } = req.body;
    const { data, error } = await supabase
      .from("transactions")
      .insert({
        user_id:          req.user.id,
        type,
        description,
        category:         category || "outros",
        value:            parseFloat(value),
        payment_method,
        bank_name,
        transaction_date: new Date().toISOString(),
        source:           "manual",
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /transactions/:id
 */
app.delete("/transactions/:id", authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from("transactions")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// IA - CLAUDE
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /ai/parse
 * Interpreta texto livre do chat e estrutura como transação
 */
app.post("/ai/parse", authMiddleware, async (req, res) => {
  try {
    const { text, mode } = req.body;
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `Você interpreta mensagens financeiras em português brasileiro. Retorne APENAS JSON válido (sem markdown):
{"type":"expense ou income","description":"descrição curta capitalizada","category":"mercado|combustivel|delivery|farmacia|transporte|lazer|salario|pix|academia|assinatura|alimentacao|outros","value":numero,"payment_method":"credito|debito|pix|dinheiro|boleto ou null","bank_name":"Nubank|Santander|Bradesco|Itaú|Inter|C6|Caixa|BB|BTG|XP|PicPay ou null","reply":"mensagem amigável confirmando registro com emoji"}
Regras: modo atual="${mode}". Salário/freelance/pix recebido = income. Reconheça bancos e formas de pagamento.`,
      messages: [{ role: "user", content: text }],
    });
    const raw = response.content[0].text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    // Salva automaticamente
    if (parsed.value > 0) {
      const { data } = await supabase.from("transactions").insert({
        user_id:          req.user.id,
        type:             parsed.type,
        description:      parsed.description,
        category:         parsed.category,
        value:            parsed.value,
        payment_method:   parsed.payment_method,
        bank_name:        parsed.bank_name,
        transaction_date: new Date().toISOString(),
        source:           "chat",
      }).select().single();
      parsed.transaction = data;
    }

    res.json(parsed);
  } catch (err) {
    console.error("Erro AI parse:", err.message);
    res.status(500).json({ error: "Erro ao processar mensagem" });
  }
});

/**
 * POST /ai/scan
 * Analisa imagem de nota fiscal/comprovante
 */
app.post("/ai/scan", authMiddleware, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `Analise a imagem (nota fiscal, comprovante, recibo, pix). Retorne APENAS JSON válido:
{"description":"estabelecimento","value":numero,"category":"categoria","transaction_date":"YYYY-MM-DD ou null","payment_method":"credito|debito|pix|dinheiro ou null","reply":"confirmação amigável"}`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 }},
          { type: "text",  text: "Extraia os dados financeiros desta imagem." }
        ],
      }],
    });
    const parsed = JSON.parse(response.content[0].text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (err) {
    console.error("Erro AI scan:", err.message);
    res.status(500).json({ error: "Erro ao analisar imagem" });
  }
});

/**
 * GET /ai/insights
 * Gera insights inteligentes sobre as finanças do usuário
 */
app.get("/ai/insights", authMiddleware, async (req, res) => {
  try {
    const { data: txs } = await supabase
      .from("transactions")
      .select("type, description, category, value, transaction_date")
      .eq("user_id", req.user.id)
      .order("transaction_date", { ascending: false })
      .limit(100);

    if (!txs || txs.length === 0) {
      return res.json({ insights: [{ icon: "👋", title: "Comece agora", body: "Adicione transações ou conecte um banco para receber insights personalizados.", type: "neutral" }] });
    }

    const summary = txs.map(t => `${t.type}: ${t.description} R$${t.value} (${t.category}) ${t.transaction_date?.split("T")[0]}`).join("\n");

    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: `Você é um consultor financeiro pessoal. Analise as transações e retorne APENAS JSON válido:
{"insights":[{"icon":"emoji","title":"título curto","body":"análise em 1-2 frases com dados reais","type":"warning|tip|positive|neutral"}]}
Gere 5-6 insights ESPECÍFICOS e ACIONÁVEIS com valores reais das transações.`,
      messages: [{ role: "user", content: `Transações dos últimos 90 dias:\n${summary}` }],
    });

    const parsed = JSON.parse(response.content[0].text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (err) {
    console.error("Erro AI insights:", err.message);
    res.status(500).json({ error: "Erro ao gerar insights" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ CashAI Backend rodando na porta ${PORT}`);
  console.log(`📊 Supabase: ${process.env.SUPABASE_URL ? "OK" : "❌"}`);
  console.log(`🔗 Pluggy:   ${PLUGGY_CLIENT_ID ? "OK" : "❌"}`);
  console.log(`🤖 Claude:   ${process.env.ANTHROPIC_API_KEY ? "OK" : "❌"}`);
});
