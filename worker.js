export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Use POST com { message, state, history, model }.' }, 405, corsHeaders);
    }

    if (!env.GROQ_API_KEY) {
      return json({ error: 'GROQ_API_KEY não foi configurada como secret do Worker.' }, 500, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON inválido.' }, 400, corsHeaders);
    }

    const message = cleanText(body.message, 600);
    if (!message) {
      return json({ error: 'Mensagem vazia.' }, 400, corsHeaders);
    }

    const state = body.state && typeof body.state === 'object' ? body.state : {};
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
    const model = cleanText(body.model || env.GROQ_MODEL || 'llama-3.1-8b-instant', 120);

    const systemPrompt = `Você é Chatty Wild, uma inteligência artificial companheira dentro do jogo Kaio Wildlands.
Responda em português do Brasil, curto e útil.
Você pode controlar uma companheira no jogo com estratégias e ações.
Nunca invente recursos que o estado do jogo não possui.
Priorize sobreviver, proteger Kaio, coletar recursos, atacar ameaças, construir base e preparar chefões.

Responda APENAS com JSON válido neste formato:
{
  "reply": "mensagem curta para o chat",
  "strategy": "follow|gather|attack|build_base|mob_trap|boss_prep|defend",
  "actions": [
    {"type":"move|gather|attack|build|choose_upgrade|toggle_auto_upgrades|set_base", "target":"player|nearest_enemy|nearest_resource|boss|base", "slot":"wall|spike|special|tech|spawn", "value":true}
  ]
}

Regras práticas:
- Se Kaio pedir armadilha/mob trap, use strategy mob_trap e build special/spike.
- Se Kaio pedir chefão, use boss_prep e tente spawn/tech/attack.
- Se Kaio pedir base, use build_base e build wall/spike/tech.
- Se Kaio pedir farm, use gather.
- Se Kaio pedir luta, use attack.
- Se Kaio pedir melhoria, use choose_upgrade.
- Máximo 3 ações.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: cleanText(m.content, 700) }))
        .filter(m => m.content),
      {
        role: 'user',
        content: JSON.stringify({ message, game_state: state })
      }
    ];

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.35,
        max_completion_tokens: 350,
        response_format: { type: 'json_object' }
      })
    });

    const raw = await groqResponse.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    if (!groqResponse.ok) {
      return json({
        error: data?.error?.message || raw || `Erro Groq HTTP ${groqResponse.status}`,
        status: groqResponse.status
      }, groqResponse.status, corsHeaders);
    }

    const content = data?.choices?.[0]?.message?.content || '{}';
    let aiPayload;
    try {
      aiPayload = JSON.parse(content);
    } catch {
      aiPayload = { reply: content, strategy: 'follow', actions: [] };
    }

    const safePayload = normalizePayload(aiPayload);
    safePayload.model = model;
    return json(safePayload, 200, corsHeaders);
  }
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizePayload(payload) {
  const allowedStrategies = new Set(['follow', 'gather', 'attack', 'build_base', 'mob_trap', 'boss_prep', 'defend']);
  const allowedActions = new Set(['move', 'gather', 'attack', 'build', 'choose_upgrade', 'toggle_auto_upgrades', 'set_base']);
  const allowedTargets = new Set(['player', 'nearest_enemy', 'nearest_resource', 'boss', 'base']);
  const allowedSlots = new Set(['wall', 'spike', 'special', 'tech', 'spawn']);

  const strategy = allowedStrategies.has(payload?.strategy) ? payload.strategy : 'follow';
  const actions = Array.isArray(payload?.actions) ? payload.actions.slice(0, 3).map(action => {
    const safe = {};
    if (allowedActions.has(action?.type)) safe.type = action.type;
    if (allowedTargets.has(action?.target)) safe.target = action.target;
    if (allowedSlots.has(action?.slot)) safe.slot = action.slot;
    if (typeof action?.value === 'boolean') safe.value = action.value;
    return safe;
  }).filter(action => action.type) : [];

  return {
    reply: cleanText(payload?.reply || 'Entendido. Vou ajustar minha estratégia.', 450),
    strategy,
    actions
  };
}
