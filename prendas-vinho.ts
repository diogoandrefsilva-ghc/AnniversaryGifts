// supabase/functions/prendas-vinho/index.ts
// AnniversaryGifts — "Procurar informação" sobre a garrafa oferecida.
//
// A app pergunta PRIMEIRO ao catálogo comum (`winecatalog.comparar`,
// grátis, aberta a qualquer sessão) e só chama isto quando o catálogo não
// sabe. Isto é uma pesquisa Google a sério (grounding), SÍNCRONA — ao
// contrário da `catalogo-info`, que é assíncrona com polling: aqui a
// pergunta é mais curta (os campos de uma ficha de prenda, não os vinte) e
// quem espera é uma pessoa com o telemóvel na mão, 20–60 s.
//
// NÃO ESCREVE NO CATÁLOGO. Só devolve a ficha; quem a grava é a app, na
// prenda. O catálogo tem dono (a WineCatalog) e regras de força por origem
// que uma quinta porta de escrita não pode contornar.
//
// Lições das irmãs, aplicadas à partida (ver CLAUDE.md da WineCatalog):
//   · só ponteiros "-latest", nunca nomes de versão fixos (os 404);
//   · nada de `thinkingBudget: 0` com `google_search` (os 400);
//   · o CORPO lê-se dentro do ciclo dos modelos: um 200 sem texto passa ao
//     seguinte, e se nenhum escrever fecha em ERRO com o finishReason —
//     nunca como "não encontrei nada";
//   · uma linha por chamada em `ia_uso.registos` (app "anniversarygifts"),
//     dentro de um try/catch que engole tudo.
//
// Deploy: supabase functions deploy prendas-vinho

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 100_000;
const CUSTO_PESQUISA_EUR = 0.01; // estimativa GROSSEIRA; os tokens é que são facto

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── Modelos (mesma estratégia das irmãs) ── */
let _models: string[] | null = null;
function rankFlash(names: string[]): string[] {
  const ok = [...new Set(names.filter((n) =>
    n.includes("flash") && !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)))];
  const score = (n: string) => {
    if (n === "gemini-flash-latest") return 100;
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    return m ? parseFloat(m[1]) : 0;
  };
  return ok.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
async function descobrirFlash(signal: AbortSignal): Promise<string[]> {
  if (_models) return _models;
  try {
    const r = await fetch(`${GAPI}/models?pageSize=200&key=${GEMINI_KEY}`, { signal });
    if (r.ok) {
      const d = await r.json();
      const names = (d.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""));
      const ranked = rankFlash(names);
      if (ranked.length) _models = ranked;
    }
  } catch (_) { /* fica o fallback */ }
  return _models ?? [];
}
// O lite primeiro, pela mesma constatação da catalogo-info: o flash-latest
// tem devolvido 200 vazio com a pesquisa ligada. Se voltar a escrever, o
// finishReason no log di-lo-á.
const ESTAVEIS = ["gemini-flash-lite-latest", "gemini-flash-latest"];
async function candidatos(signal: AbortSignal): Promise<string[]> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  const vistos = new Set<string>();
  return [...(pinned ? [pinned] : []), ...ESTAVEIS, ...(await descobrirFlash(signal))]
    .filter((m) => (vistos.has(m) ? false : (vistos.add(m), true)));
}

/* ── Normalizar o que vem ── */
const TIPOS = ["Tinto", "Branco", "Rosé", "Espumante", "Licoroso", "Frisante"];
const texto = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function numero(v: unknown, min: number, max: number, casas = 2): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return isFinite(n) && n >= min && n <= max ? Number(n.toFixed(casas)) : null;
}
function extrairJson(txt: string): any | null {
  const s = String(txt || "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
  if (!s) return null;
  const sem = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(sem); } catch (_) { /* segue */ }
  const ini = sem.indexOf("{"), fim = sem.lastIndexOf("}");
  if (ini < 0 || fim <= ini) return null;
  try { return JSON.parse(sem.slice(ini, fim + 1)); } catch (_) { return null; }
}
function normalizar(raw: any): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || raw.encontrado === false) return {};
  const castas = Array.isArray(raw.castas)
    ? [...new Set(raw.castas.map((c: unknown) => texto(c, 50))
        .filter((c: string) => c && !/^(blend|lote|v[áa]rias|diversas|castas?)$/i.test(c)))].slice(0, 12)
    : [];
  const tipo = TIPOS.find((t) => t.toLowerCase() === texto(raw.tipo, 20).toLowerCase()) ?? "";
  const out: Record<string, unknown> = {
    produtor: texto(raw.produtor, 90),
    tipo,
    regiao: texto(raw.regiao, 60),
    pais: texto(raw.pais, 40),
    castas,
    teor: numero(raw.teor, 4, 25, 1),
    estagio: texto(raw.estagio, 160),
    vivino_nota: numero(raw.vivinoNota, 1, 5, 2),
    vivino_url: /^https?:\/\/([a-z0-9-]+\.)*vivino\.com\//i.test(String(raw.vivinoUrl ?? "").trim()) ? texto(raw.vivinoUrl, 300) : "",
    imagem_url: /^https?:\/\/\S+\.(jpe?g|png|webp|avif)(\?\S*)?$/i.test(String(raw.imagemUrl ?? "").trim()) ? texto(raw.imagemUrl, 400) : "",
    preco_medio: numero(raw.precoMedio, 0.5, 100_000, 2),
    notas_prova: texto(raw.notasProva, 600),
    harmonizacao: texto(raw.harmonizacao, 300),
    resumo: texto(raw.resumo, 900),
  };
  Object.keys(out).forEach((k) => {
    const v = out[k];
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) delete out[k];
  });
  return out;
}
function fontesGrounding(body: any): { titulo: string; url: string }[] {
  const out: { titulo: string; url: string }[] = [];
  const vistos = new Set<string>();
  for (const c of body?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const url = String(c?.web?.uri ?? "").trim();
    if (!/^https?:\/\//i.test(url) || vistos.has(url)) continue;
    vistos.add(url);
    out.push({ titulo: texto(c?.web?.title ?? url, 120), url: url.slice(0, 400) });
    if (out.length >= 6) break;
  }
  return out;
}

const prompt = (nome: string, produtor: string, ano: number | null, tipo: string) => `
És um enólogo a preencher a ficha de um vinho que foi oferecido como prenda de anos.
Usa PESQUISA WEB para confirmar os dados — não respondas de memória.

VINHO:
  Nome: ${nome}
${tipo ? `  Cor: ${tipo} (dita por quem tem a garrafa — é um dado seguro; se o nome tiver versões de outra cor, é ESTA)\n` : ""}${produtor ? `  Produtor: ${produtor}\n` : ""}${ano ? `  Colheita: ${ano}\n` : ""}
REGRAS:
1. NÃO INVENTES. Um campo que não confirmes fica fora do JSON.
2. Se o produtor tiver vários vinhos com este nome (Reserva, Grande Reserva,
   Colheita…) e não se souber qual, prefere a versão SEM qualificador e diz no
   "aviso" que outras encontraste.
3. A página do Vivino é do VINHO, não da colheita: basta nome e produtor
   baterem certo. A nota é o número 1.0–5.0 ao lado das estrelas.
4. "imagemUrl" tem de ser link DIRETO de imagem (.jpg/.png/.webp), nunca a página.
5. Castas separadas por nome (nunca "blend"/"lote").
6. "precoMedio" é o preço de RETALHO em euros, garrafa de 0,75 L.

Responde SÓ com este JSON, sem texto à volta:
{
  "encontrado": true,
  "produtor": "",
  "tipo": "um de: ${TIPOS.join(" | ")}",
  "regiao": "",
  "pais": "Portugal",
  "castas": [],
  "teor": 13.5,
  "estagio": "",
  "vivinoNota": 4.0,
  "vivinoUrl": "",
  "imagemUrl": "",
  "precoMedio": 15.0,
  "notasProva": "duas ou três frases",
  "harmonizacao": "",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
  "aviso": ""
}
Se não conseguires identificar o vinho, responde {"encontrado": false, "aviso": "porquê"}.`;

async function registarIaUso(estado: string, detalhe: Record<string, unknown>, quem: string | null) {
  try {
    const u = (detalhe.usageMetadata ?? null) as any;
    await fetch(`${SB_URL}/rest/v1/registos`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: "Bearer " + SB_SRV, "Content-Type": "application/json",
        "Content-Profile": "ia_uso", Prefer: "return=minimal",
      },
      body: JSON.stringify({
        app: "anniversarygifts", funcao: "prendas-vinho",
        estado: estado === "erro" ? "erro" : "ok",
        modelo: (detalhe.modelo as string) ?? null,
        pesquisa_web: true,
        tokens_entrada: u?.promptTokenCount ?? null,
        tokens_saida: u?.candidatesTokenCount ?? null,
        tokens_pensamento: u?.thoughtsTokenCount ?? null,
        tokens_total: u?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number) ?? null,
        duracao_ms: (detalhe.ms as number) ?? null,
        quem,
        erro: estado === "erro" ? String(detalhe.erro ?? detalhe.passo ?? "").slice(0, 500) || null : null,
        detalhe,
      }),
    });
  } catch (_) { /* registo, não trabalho: nunca deita a chamada abaixo */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  const t0 = Date.now();

  // Quem chama: a mesma `acesso()` da app, com o token de quem chama.
  const ra = await fetch(`${SB_URL}/rest/v1/rpc/acesso`, {
    method: "POST",
    headers: {
      apikey: SB_ANON, Authorization: req.headers.get("Authorization") ?? "", "Content-Type": "application/json",
      "Content-Profile": "anniversarygifts", "Accept-Profile": "anniversarygifts",
    },
    body: "{}",
  });
  const acesso = ra.ok ? await ra.json() : null;
  if (!acesso?.permitido) return json({ error: "não autorizado" }, 403);
  const quem: string = acesso.email;

  let corpo: any = {};
  try { corpo = await req.json(); } catch (_) { /* vazio */ }
  const nome = texto(corpo.nome, 120);
  const produtor = texto(corpo.produtor, 90);
  const ano = numero(corpo.ano, 1900, 2100, 0);
  // A cor, escolhida no formulário ANTES da procura: é o que separa o "Papa
  // Figos" tinto do branco. Só entra no prompt se for uma das cores conhecidas.
  const tipoPedido = TIPOS.find((x) => x.toLowerCase() === texto(corpo.tipo, 20).toLowerCase()) ?? "";
  if (!nome) return json({ error: "falta o nome do vinho" }, 400);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let modelo = "";
  try {
    const lista = await candidatos(ctrl.signal);
    let vazioMotivo = "";
    let ultimoErro = "";
    let usage: any = null;
    for (const m of lista) {
      if (ctrl.signal.aborted) break;
      modelo = m;
      const g = await fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt(nome, produtor, ano, tipoPedido) }] }],
          generationConfig: { temperature: 0 },
          tools: [{ google_search: {} }],
        }),
      });
      if (!g.ok) {
        ultimoErro = `gemini ${g.status} (${m})`;
        if (g.status === 404) { _models = null; continue; }
        if (g.status === 429 || g.status >= 500) continue;
        break;
      }
      const gd = await g.json();
      const cand = gd?.candidates?.[0];
      const motivo = String(cand?.finishReason ?? "");
      const bruto = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
      usage = gd?.usageMetadata ?? usage;
      if (!bruto) { vazioMotivo = motivo || "resposta vazia"; continue; } // 200 vazio → modelo seguinte

      const parsed = extrairJson(bruto);
      if (!parsed) {
        await registarIaUso("erro", { passo: "json", modelo, erro: "resposta ilegível", usageMetadata: usage, ms: Date.now() - t0, custo_estimado_eur: CUSTO_PESQUISA_EUR, nome }, quem);
        return json({ error: "o modelo respondeu mas não percebi a resposta — tenta outra vez" }, 502);
      }
      const ficha = normalizar(parsed);
      const fontes = fontesGrounding(gd);
      await registarIaUso("ok", { passo: "ok", modelo, campos: Object.keys(ficha).length, fontes: fontes.length, finishReason: motivo, usageMetadata: usage, ms: Date.now() - t0, custo_estimado_eur: CUSTO_PESQUISA_EUR, nome }, quem);
      return json({
        encontrado: parsed.encontrado !== false && Object.keys(ficha).length > 0,
        ficha, fontes, aviso: texto(parsed.aviso, 300), modelo,
      });
    }
    // Nenhum escreveu nada: é ERRO, e diz-se porquê.
    const erro = vazioMotivo
      ? `o modelo respondeu sem escrever nada (${vazioMotivo}) — tenta outra vez`
      : (ultimoErro || "não consegui falar com o Gemini — tenta outra vez");
    await registarIaUso("erro", { passo: vazioMotivo ? "gemini_vazio" : "gemini", modelo, erro, finishReason: vazioMotivo || null, usageMetadata: usage, ms: Date.now() - t0, nome }, quem);
    return json({ error: erro }, 502);
  } catch (e) {
    const abort = (e as Error).name === "AbortError";
    await registarIaUso("erro", { passo: abort ? "timeout" : "excecao", modelo, erro: String((e as Error).message).slice(0, 300), ms: Date.now() - t0, nome }, quem);
    return json({ error: abort ? "a pesquisa demorou demasiado — tenta outra vez" : (e as Error).message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
