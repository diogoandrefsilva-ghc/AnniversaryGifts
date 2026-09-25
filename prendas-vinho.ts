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

/* HOUVE PESQUISA OU NÃO. Ligar o `google_search` não obriga o modelo a
   pesquisar — ele decide, e nos registos até 24/09/2026 nunca o fez (em
   nenhuma das apps): as respostas vinham do que aprendeu no treino. Para
   toda a gente fica como está; a resposta passa a dizê-lo (`pesquisaWeb`) e
   ao admin a app oferece a "pesquisa profunda" (`profunda:true`). Mesmo
   critério das outras apps — ver o CLAUDE.md da WineCatalog, "De memória ou
   pesquisado". */
function fezPesquisa(gd: any): boolean {
  const gm = gd?.candidates?.[0]?.groundingMetadata;
  return (Array.isArray(gm?.webSearchQueries) && gm.webSearchQueries.length > 0) ||
    (Array.isArray(gm?.groundingChunks) && gm.groundingChunks.length > 0) ||
    Number(gd?.usageMetadata?.toolUsePromptTokenCount ?? 0) > 0;
}

/* A PESQUISA PROFUNDA É SERPER, NÃO GROUNDING (25/09/2026). Não há
   parâmetro nenhum na API do Gemini que o OBRIGUE a pesquisar, e mudar o
   prompt só mexe nas probabilidades (a 24/09/2026, com o prompt a pedir
   "primeiro pesquisa", a Garrafeira respondeu de memória na mesma). Só uma
   pesquisa feita por NÓS é garantida: duas consultas ao Google pelo Serper
   (uma geral — preço, lojas — e uma ao Vivino), e o Gemini só LÊ os
   resultados, sem `google_search`. A chave (`SEARCH_API_KEY`) é segredo do
   PROJETO Supabase — a mesma do "modo grátis" da Garrafeira. Mesmo
   critério da `catalogo-info`, da `verificar-vinhos` e da `vinho-info`. */
const SEARCH_API_KEY = Deno.env.get("SEARCH_API_KEY") ?? "";
const SEARCH_API_URL = Deno.env.get("SEARCH_API_URL") || "https://google.serper.dev/search";
const CUSTO_SERPER_EUR = 0.001;      // por consulta, grosseiro como os outros
const CUSTO_GEMINI_SO_EUR = 0.002;   // a profunda: o Gemini só lê, não pesquisa
async function pesquisarSerper(consultas: string[], signal: AbortSignal):
  Promise<{ texto: string; fontes: { titulo: string; url: string }[] }> {
  if (!SEARCH_API_KEY) throw new Error("a pesquisa externa não está configurada (falta SEARCH_API_KEY)");
  const respostas = await Promise.all(consultas.map(async (q) => {
    const r = await fetch(SEARCH_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": SEARCH_API_KEY },
      body: JSON.stringify({ q, gl: "pt", hl: "pt", num: 8 }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (!r.ok) throw new Error(`a pesquisa externa respondeu ${r.status}`);
    const d = await r.json();
    return Array.isArray(d?.organic) ? d.organic : [];
  }));
  const vistos = new Set<string>();
  const linhas: any[] = [];
  for (const x of respostas.flat()) {
    const url = String(x?.link || "").trim();
    if (!/^https?:\/\//i.test(url) || vistos.has(url)) continue;
    vistos.add(url);
    linhas.push(x);
  }
  const txt = linhas.map((x, i) =>
    `[${i + 1}] ${String(x?.title || "").trim()}\nURL: ${String(x.link).trim()}\n` +
    `Resumo: ${String(x?.snippet || "").replace(/\s+/g, " ").trim()}`).join("\n\n");
  return {
    texto: txt.slice(0, 8000),
    fontes: linhas.slice(0, 6).map((x) => ({ titulo: texto(x?.title || x.link, 120), url: String(x.link).slice(0, 400) })),
  };
}

// `evidencia` (só na profunda): os resultados do Serper.
const prompt = (nome: string, produtor: string, ano: number | null, tipo: string, evidencia = "") => `
És um enólogo a preencher a ficha de um vinho que foi oferecido como prenda de anos.
${evidencia
  ? `Responde APENAS com base na BASE DE EVIDÊNCIA abaixo (resultados de uma
pesquisa Google já feita). Não uses o que sabes de memória: o que não estiver
nestes resultados fica fora do JSON.`
  : "Usa PESQUISA WEB para confirmar os dados — não respondas de memória."}

VINHO:
  Nome: ${nome}
${tipo ? `  Cor: ${tipo} (dita por quem tem a garrafa — é um dado seguro; se o nome tiver versões de outra cor, é ESTA)\n` : ""}${produtor ? `  Produtor: ${produtor}\n` : ""}${ano ? `  Colheita: ${ano}\n` : ""}${evidencia ? `
BASE DE EVIDÊNCIA:
${evidencia}
` : ""}
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
  const profunda = corpo.profunda === true;
  if (profunda && !acesso.admin) return json({ error: "a pesquisa profunda é só para o admin" }, 403);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let modelo = "";
  try {
    // Profunda: a pesquisa faz-se AQUI, antes do Gemini (ver `pesquisarSerper`).
    let evidencia = "";
    let fontesSerper: { titulo: string; url: string }[] = [];
    const serperConsultas = profunda ? 2 : 0;
    if (profunda) {
      const q = [nome, produtor, ano].filter(Boolean).join(" ");
      try {
        const r = await pesquisarSerper([`${q} vinho preço`, `${[nome, produtor].filter(Boolean).join(" ")} vivino`], ctrl.signal);
        evidencia = r.texto;
        fontesSerper = r.fontes;
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        await registarIaUso("erro", { passo: "serper", profunda: true, erro: String((e as Error).message).slice(0, 300), ms: Date.now() - t0, nome }, quem);
        return json({ error: `a pesquisa Google não respondeu (${(e as Error).message}) — tenta outra vez` }, 503);
      }
      if (!evidencia) {
        await registarIaUso("ok", { passo: "serper_vazio", profunda: true, serper_consultas: serperConsultas, custo_estimado_eur: serperConsultas * CUSTO_SERPER_EUR, ms: Date.now() - t0, nome }, quem);
        return json({ error: "a pesquisa Google não encontrou nada sobre este vinho — confirma o nome e o produtor" }, 404);
      }
    }
    const lista = await candidatos(ctrl.signal);
    const textoPedido = prompt(nome, produtor, ano, tipoPedido, evidencia);
    const custo = profunda ? CUSTO_GEMINI_SO_EUR + serperConsultas * CUSTO_SERPER_EUR : CUSTO_PESQUISA_EUR;
    const serperLog = profunda ? { pesquisa_externa: "serper", serper_consultas: serperConsultas } : {};
    let vazioMotivo = "";
    let ultimoErro = "";
    let usage: any = null;
    const responder = async (gd: any, bruto: string, motivo: string) => {
      const parsed = extrairJson(bruto);
      if (!parsed) {
        await registarIaUso("erro", { passo: "json", modelo, erro: "resposta ilegível", usageMetadata: usage, ms: Date.now() - t0, custo_estimado_eur: custo, ...serperLog, nome }, quem);
        return json({ error: "o modelo respondeu mas não percebi a resposta — tenta outra vez" }, 502);
      }
      const ficha = normalizar(parsed);
      // Na profunda, a pesquisa foi nossa: as fontes são as do Serper, e houve pesquisa.
      const fontes = profunda ? fontesSerper : fontesGrounding(gd);
      const pesquisaWeb = profunda ? true : fezPesquisa(gd);
      await registarIaUso("ok", { passo: "ok", modelo, campos: Object.keys(ficha).length, fontes: fontes.length, pesquisaWeb, ...(profunda ? { profunda: true } : {}), ...serperLog, finishReason: motivo, usageMetadata: usage, ms: Date.now() - t0, custo_estimado_eur: custo, nome }, quem);
      return json({
        encontrado: parsed.encontrado !== false && Object.keys(ficha).length > 0,
        ficha, fontes, aviso: texto(parsed.aviso, 300), modelo, pesquisaWeb, profunda,
      });
    };
    for (const m of lista) {
      if (ctrl.signal.aborted) break;
      modelo = m;
      // Na profunda a pesquisa já foi feita (Serper): sem tool, e JSON direto.
      const g = await fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: textoPedido }] }],
          ...(profunda
            ? { generationConfig: { temperature: 0, responseMimeType: "application/json" } }
            : { generationConfig: { temperature: 0 }, tools: [{ google_search: {} }] }),
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
      return await responder(gd, bruto, motivo);
    }
    // Nenhum escreveu nada: é ERRO, e diz-se porquê.
    const erro = vazioMotivo
      ? `o modelo respondeu sem escrever nada (${vazioMotivo}) — tenta outra vez`
      : (ultimoErro || "não consegui falar com o Gemini — tenta outra vez");
    await registarIaUso("erro", { passo: vazioMotivo ? "gemini_vazio" : "gemini", modelo, erro, finishReason: vazioMotivo || null, usageMetadata: usage, ms: Date.now() - t0, ...serperLog, nome }, quem);
    return json({ error: erro }, 502);
  } catch (e) {
    const abort = (e as Error).name === "AbortError";
    await registarIaUso("erro", { passo: abort ? "timeout" : "excecao", modelo, erro: String((e as Error).message).slice(0, 300), ms: Date.now() - t0, nome }, quem);
    return json({ error: abort ? "a pesquisa demorou demasiado — tenta outra vez" : (e as Error).message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
