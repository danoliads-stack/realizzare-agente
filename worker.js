/**
 * Cloudflare Worker — Realizzare Agente IA
 * Variáveis de ambiente necessárias:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY,
 *   EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE
 */

const SYSTEM_PROMPT = `Você é a assistente virtual da Realizzare Planejados, empresa de móveis planejados de alto padrão em Curitiba/PR, com fabricação própria desde 2015.

PERSONALIDADE:
- Calorosa, profissional e objetiva
- Linguagem natural e humanizada, nunca robótica
- Mensagens curtas (máximo 3 linhas por vez no WhatsApp)
- Sempre termine com UMA única pergunta

FUNIL DE QUALIFICAÇÃO (siga nessa ordem):
1. Confirmar o ambiente de interesse (cozinha, closet, dormitório, sala, banheiro, área gourmet, projeto completo)
2. Obra nova ou reforma?
3. Faixa de investimento: até R$10k / R$10k–R$30k / R$30k–R$60k / acima de R$60k
4. Prazo desejado: 1 a 3 meses / 3 a 6 meses / sem pressa
5. Oferecer visita técnica gratuita e confirmar melhor horário

REGRAS:
- Se o lead já informou o ambiente, pule a pergunta 1
- Quando tiver todas as informações, confirme e diga que um consultor entrará em contato
- Nunca mencione que é IA a menos que perguntado diretamente
- Se perguntado se é robô: "Sou a assistente virtual da Realizzare! Nossa equipe acompanha tudo de perto. Posso te ajudar a agendar uma visita?"

Retorne sempre sua mensagem seguida de ---JSON--- e um JSON:
{
  "ambiente": "string ou null",
  "tipo_projeto": "obra nova | reforma | null",
  "orcamento_faixa": "ate-10k | 10k-30k | 30k-60k | acima-60k | null",
  "prazo_desejado": "1-3-meses | 3-6-meses | sem-pressa | null",
  "qualificado": true ou false
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function sb(env, path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...options.headers,
    },
  });
  const text = await res.text();
  return { ok: res.ok, data: text ? JSON.parse(text) : null };
}

async function buscarLeadPorTelefone(env, telefone) {
  const sufixo = telefone.replace(/\D/g, '').slice(-11);
  const { data } = await sb(env, `/leads?telefone=ilike.*${sufixo}&limit=1`);
  return data?.[0] || null;
}

async function buscarLeadPorId(env, id) {
  const { data } = await sb(env, `/leads?id=eq.${id}&limit=1`);
  return data?.[0] || null;
}

async function criarLead(env, payload) {
  const { data } = await sb(env, '/leads', { method: 'POST', body: JSON.stringify(payload) });
  return data?.[0] || null;
}

async function atualizarLead(env, id, campos) {
  await sb(env, `/leads?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(campos), prefer: 'return=minimal' });
}

async function buscarHistorico(env, leadId, limite = 20) {
  const { data } = await sb(env, `/conversas?lead_id=eq.${leadId}&order=created_at.asc&limit=${limite}`);
  return data || [];
}

async function salvarMensagem(env, leadId, role, mensagem) {
  await sb(env, '/conversas', {
    method: 'POST',
    body: JSON.stringify({ lead_id: leadId, role, mensagem }),
    prefer: 'return=minimal',
  });
}

// ─── Evolution API ────────────────────────────────────────────────────────────

async function enviarWhatsApp(env, telefone, mensagem) {
  const numero = telefone.replace(/\D/g, '');
  const com55 = numero.startsWith('55') ? numero : `55${numero}`;
  const res = await fetch(`${env.EVOLUTION_API_URL}/message/sendText/${env.EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: com55, text: mensagem }),
  });
  if (!res.ok) console.error('Evolution API error:', await res.text());
  return res.ok;
}

// ─── Claude ───────────────────────────────────────────────────────────────────

async function chamarClaude(env, historico, mensagemUsuario, lead) {
  const ctx = lead.ambiente ? `\n\nContexto: lead quer ${lead.ambiente}.` : '';
  const messages = [
    ...historico.map(h => ({ role: h.role === 'agent' ? 'assistant' : 'user', content: h.mensagem })),
    { role: 'user', content: mensagemUsuario },
  ];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: SYSTEM_PROMPT + ctx, messages }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).content[0].text;
}

function parseClaude(texto) {
  const idx = texto.indexOf('---JSON---');
  if (idx === -1) return { mensagem: texto.trim(), dados: null };
  try { return { mensagem: texto.slice(0, idx).trim(), dados: JSON.parse(texto.slice(idx + 10).trim()) }; }
  catch { return { mensagem: texto.slice(0, idx).trim(), dados: null }; }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleWebhookLead(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'JSON inválido' }, 400);
  const { nome, telefone, email, ambiente, mensagem } = body;
  if (!nome || !telefone) return json({ error: 'nome e telefone obrigatórios' }, 400);

  let lead = await buscarLeadPorTelefone(env, telefone);
  if (!lead) {
    lead = await criarLead(env, { nome, telefone, email: email || null, ambiente: ambiente || null, mensagem: mensagem || null, status: 'novo', agente_ativo: true, origem: 'site' });
  } else if (!lead.agente_ativo) {
    await atualizarLead(env, lead.id, { agente_ativo: true });
  }
  if (!lead) return json({ error: 'Erro ao criar lead' }, 500);

  if (mensagem) await salvarMensagem(env, lead.id, 'user', mensagem);

  const primeiraMsg = ambiente
    ? `Olá ${nome}! Vi que você tem interesse em ${ambiente}. Que ótima escolha! 😊 É para obra nova ou reforma?`
    : `Olá ${nome}! Sou a assistente virtual da Realizzare Planejados. Qual ambiente você quer transformar? (cozinha, closet, dormitório, sala...)`;

  await salvarMensagem(env, lead.id, 'agent', primeiraMsg);
  await enviarWhatsApp(env, telefone, primeiraMsg);
  return json({ ok: true, lead_id: lead.id });
}

async function handleWebhookWhatsApp(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'JSON inválido' }, 400);

  const data = body.data || body;
  if (data.key?.fromMe || data.fromMe) return json({ ok: true, skipped: 'própria' });

  const remoteJid = data.key?.remoteJid || data.remoteJid || '';
  const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  const texto = data.message?.conversation || data.message?.extendedTextMessage?.text || '';

  if (!texto || !telefone) return json({ ok: true, skipped: 'sem texto' });

  let lead = await buscarLeadPorTelefone(env, telefone);
  if (!lead) lead = await criarLead(env, { nome: data.pushName || 'Lead WhatsApp', telefone, status: 'novo', agente_ativo: true, origem: 'whatsapp' });
  if (!lead) return json({ error: 'Erro lead' }, 500);
  if (!lead.agente_ativo) return json({ ok: true, skipped: 'agente pausado' });

  const historico = await buscarHistorico(env, lead.id);
  await salvarMensagem(env, lead.id, 'user', texto);

  let respostaBruta;
  try { respostaBruta = await chamarClaude(env, historico, texto, lead); }
  catch (err) { console.error(err); return json({ error: 'Erro IA' }, 500); }

  const { mensagem, dados } = parseClaude(respostaBruta);
  await salvarMensagem(env, lead.id, 'agent', mensagem);

  if (dados) {
    const upd = {};
    if (dados.ambiente && !lead.ambiente) upd.ambiente = dados.ambiente;
    if (dados.tipo_projeto) upd.tipo_projeto = dados.tipo_projeto;
    if (dados.orcamento_faixa) upd.orcamento_faixa = dados.orcamento_faixa;
    if (dados.prazo_desejado) upd.prazo_desejado = dados.prazo_desejado;
    if (dados.qualificado === true) { upd.qualificado = true; upd.status = 'qualificado'; }
    if (Object.keys(upd).length) await atualizarLead(env, lead.id, upd);
  }

  await enviarWhatsApp(env, telefone, mensagem);
  return json({ ok: true });
}

// Consultor envia mensagem manual pelo painel
async function handleEnviarMensagem(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'JSON inválido' }, 400);
  const { lead_id, mensagem } = body;
  if (!lead_id || !mensagem) return json({ error: 'lead_id e mensagem obrigatórios' }, 400);

  const lead = await buscarLeadPorId(env, lead_id);
  if (!lead) return json({ error: 'Lead não encontrado' }, 404);

  await salvarMensagem(env, lead_id, 'agent', mensagem);
  await enviarWhatsApp(env, lead.telefone, mensagem);
  return json({ ok: true });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/webhook-lead')     return handleWebhookLead(request, env);
    if (request.method === 'POST' && path === '/webhook-whatsapp') return handleWebhookWhatsApp(request, env);
    if (request.method === 'POST' && path === '/enviar-mensagem')  return handleEnviarMensagem(request, env);
    if (path === '/health') return json({ ok: true });
    return json({ error: 'Rota não encontrada' }, 404);
  },
};
