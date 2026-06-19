/**
 * Cloudflare Worker — Realizzare Agente IA
 * Backend do agente de atendimento WhatsApp
 *
 * Variáveis de ambiente (configurar no painel Cloudflare Workers):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   ANTHROPIC_API_KEY
 *   EVOLUTION_API_URL
 *   EVOLUTION_API_KEY
 *   EVOLUTION_INSTANCE
 */

const SYSTEM_PROMPT = `Você é a assistente virtual da Realizzare Planejados, empresa de móveis planejados de alto padrão em Curitiba/PR, com fabricação própria desde 2015.

PERSONALIDADE:
- Calorosa, profissional e objetiva
- Linguagem natural e humanizada, nunca robótica
- Mensagens curtas (máximo 3 linhas por vez no WhatsApp)
- Sempre termine com UMA única pergunta

FUNIL DE QUALIFICAÇÃO (siga nessa ordem obrigatoriamente):
1. Confirmar o ambiente de interesse (cozinha, closet, dormitório, sala, banheiro, área gourmet, projeto completo)
2. Obra nova ou reforma?
3. Faixa de investimento: até R$10k / R$10k–R$30k / R$30k–R$60k / acima de R$60k
4. Prazo desejado: 1 a 3 meses / 3 a 6 meses / sem pressa
5. Oferecer visita técnica gratuita e confirmar melhor horário

REGRAS:
- Se o lead já informou o ambiente no formulário, pule a pergunta 1 e já parabenize pela escolha
- Responda brevemente se perguntarem sobre estilos ou materiais, depois volte ao funil
- Quando tiver todas as informações, confirme os dados e diga que um consultor vai entrar em contato para confirmar a visita
- Nunca mencione que é uma IA a menos que perguntado diretamente
- Se perguntado se é robô/IA, responda: "Sou a assistente virtual da Realizzare! Mas nossa equipe acompanha tudo de perto. Posso te ajudar a agendar uma visita?"

DADOS PARA EXTRAIR (retorne sempre no final da sua resposta um bloco JSON separado por ---JSON---):
{
  "ambiente": "string ou null",
  "tipo_projeto": "obra nova | reforma | null",
  "orcamento_faixa": "ate-10k | 10k-30k | 30k-60k | acima-60k | null",
  "prazo_desejado": "1-3-meses | 3-6-meses | sem-pressa | null",
  "qualificado": true ou false
}

O JSON deve aparecer APÓS sua mensagem normal, separado por ---JSON--- em linha própria. O usuário não verá esse bloco.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function supabaseFetch(env, path, options = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...options.headers,
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

async function buscarLeadPorTelefone(env, telefone) {
  const limpo = telefone.replace(/\D/g, '');
  const sufixo = limpo.slice(-11);
  const { data } = await supabaseFetch(env, `/leads?telefone=ilike.*${sufixo}&limit=1`);
  return data && data.length > 0 ? data[0] : null;
}

async function criarLead(env, payload) {
  const { data } = await supabaseFetch(env, '/leads', {
    method: 'POST',
    body: JSON.stringify(payload),
    prefer: 'return=representation',
  });
  return data && data.length > 0 ? data[0] : null;
}

async function atualizarLead(env, id, campos) {
  await supabaseFetch(env, `/leads?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(campos),
    prefer: 'return=minimal',
  });
}

async function buscarHistorico(env, leadId, limite = 20) {
  const { data } = await supabaseFetch(
    env,
    `/conversas?lead_id=eq.${leadId}&order=created_at.asc&limit=${limite}`
  );
  return data || [];
}

async function salvarMensagem(env, leadId, role, mensagem) {
  await supabaseFetch(env, '/conversas', {
    method: 'POST',
    body: JSON.stringify({ lead_id: leadId, role, mensagem }),
    prefer: 'return=minimal',
  });
}

// ─── Evolution API ────────────────────────────────────────────────────────────

async function enviarWhatsApp(env, telefone, mensagem) {
  const limpo = telefone.replace(/\D/g, '');
  const numero = limpo.startsWith('55') ? limpo : `55${limpo}`;

  const url = `${env.EVOLUTION_API_URL}/message/sendText/${env.EVOLUTION_INSTANCE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number: numero, text: mensagem }),
  });

  if (!res.ok) console.error('Erro Evolution API:', await res.text());
  return res.ok;
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function chamarClaude(env, historico, mensagemUsuario, dadosLead) {
  const contextoLead = dadosLead.ambiente
    ? `\n\nContexto: lead já informou que quer ${dadosLead.ambiente}.`
    : '';

  const messages = historico.map((h) => ({
    role: h.role === 'agent' ? 'assistant' : 'user',
    content: h.mensagem,
  }));
  messages.push({ role: 'user', content: mensagemUsuario });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT + contextoLead,
      messages,
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
  const result = await res.json();
  return result.content[0].text;
}

function parseRespostaClaude(texto) {
  const idx = texto.indexOf('---JSON---');
  if (idx === -1) return { mensagem: texto.trim(), dados: null };
  const mensagem = texto.slice(0, idx).trim();
  try {
    return { mensagem, dados: JSON.parse(texto.slice(idx + 10).trim()) };
  } catch {
    return { mensagem, dados: null };
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleWebhookLead(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'JSON inválido' }, 400); }

  const { nome, telefone, email, ambiente, mensagem } = body;
  if (!nome || !telefone) return json({ error: 'nome e telefone são obrigatórios' }, 400);

  let lead = await buscarLeadPorTelefone(env, telefone);

  if (!lead) {
    lead = await criarLead(env, {
      nome, telefone,
      email: email || null,
      ambiente: ambiente || null,
      mensagem: mensagem || null,
      status: 'novo',
      agente_ativo: true,
      origem: 'site',
    });
  } else if (!lead.agente_ativo) {
    await atualizarLead(env, lead.id, { agente_ativo: true });
  }

  if (!lead) return json({ error: 'Erro ao criar lead' }, 500);

  if (mensagem) await salvarMensagem(env, lead.id, 'user', mensagem);

  const primeiraMsg = ambiente
    ? `Olá ${nome}! Vi que você tem interesse em ${ambiente}. Que ótima escolha! 😊 É para uma obra nova ou reforma?`
    : `Olá ${nome}! Sou a assistente virtual da Realizzare Planejados. Para te ajudar melhor, qual ambiente você quer transformar? (cozinha, closet, dormitório, sala...)`;

  await salvarMensagem(env, lead.id, 'agent', primeiraMsg);
  await enviarWhatsApp(env, telefone, primeiraMsg);

  return json({ ok: true, lead_id: lead.id });
}

async function handleWebhookWhatsApp(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'JSON inválido' }, 400); }

  const data = body.data || body;
  if (data.key?.fromMe || data.fromMe) return json({ ok: true, skipped: 'mensagem própria' });

  const remoteJid = data.key?.remoteJid || data.remoteJid || '';
  const telefoneRaw = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  const textoMensagem =
    data.message?.conversation ||
    data.message?.extendedTextMessage?.text ||
    data.message?.buttonsResponseMessage?.selectedDisplayText || '';

  if (!textoMensagem || !telefoneRaw) return json({ ok: true, skipped: 'sem texto' });

  let lead = await buscarLeadPorTelefone(env, telefoneRaw);
  if (!lead) {
    lead = await criarLead(env, {
      nome: data.pushName || 'Lead WhatsApp',
      telefone: telefoneRaw,
      status: 'novo',
      agente_ativo: true,
      origem: 'whatsapp',
    });
  }
  if (!lead) return json({ error: 'Erro ao localizar lead' }, 500);
  if (!lead.agente_ativo) return json({ ok: true, skipped: 'agente pausado' });

  const historico = await buscarHistorico(env, lead.id);
  await salvarMensagem(env, lead.id, 'user', textoMensagem);

  let respostaBruta;
  try { respostaBruta = await chamarClaude(env, historico, textoMensagem, lead); }
  catch (err) { console.error('Erro Claude:', err); return json({ error: 'Erro IA' }, 500); }

  const { mensagem: respostaFinal, dados } = parseRespostaClaude(respostaBruta);
  await salvarMensagem(env, lead.id, 'agent', respostaFinal);

  if (dados) {
    const upd = {};
    if (dados.ambiente && !lead.ambiente) upd.ambiente = dados.ambiente;
    if (dados.tipo_projeto) upd.tipo_projeto = dados.tipo_projeto;
    if (dados.orcamento_faixa) upd.orcamento_faixa = dados.orcamento_faixa;
    if (dados.prazo_desejado) upd.prazo_desejado = dados.prazo_desejado;
    if (dados.qualificado === true) { upd.qualificado = true; upd.status = 'qualificado'; }
    if (Object.keys(upd).length > 0) await atualizarLead(env, lead.id, upd);
  }

  await enviarWhatsApp(env, telefoneRaw, respostaFinal);
  return json({ ok: true });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    const path = new URL(request.url).pathname;

    if (request.method === 'POST' && path === '/webhook-lead')      return handleWebhookLead(request, env);
    if (request.method === 'POST' && path === '/webhook-whatsapp')  return handleWebhookWhatsApp(request, env);
    if (path === '/health') return json({ ok: true });

    return json({ error: 'Rota não encontrada' }, 404);
  },
};
