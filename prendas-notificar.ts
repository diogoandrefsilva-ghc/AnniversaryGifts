// supabase/functions/prendas-notificar/index.ts
// AnniversaryGifts — notificações Web Push.
//
// Irmã da `push-notificar` do SplitBill (mesmo par VAPID — os secrets são
// do projeto, não da função), com UMA diferença de desenho: o cliente não
// manda valores nem nomes, só diz DE QUE se trata (um evento, um
// pagamento). Quanto se deve e a quem lê-se aqui, da view
// `anniversarygifts.dividas` — a mesma fonte de cêntimos da app. Assim
// nenhum aviso pode dizer um valor diferente do ecrã.
//
// Tipos:
//   'divida'               evento_id → cada participante que ainda deve
//                           (quem o chama: o responsável da prenda ou o admin)
//   'lembrete'             evento_id + devedor → só essa pessoa
//                           (idem)
//   'pagamento_declarado'  pagamento_id → quem recebe (o responsável)
//                           (quem o chama: quem declarou, ou o admin)
//   'pagamento_resolvido'  pagamento_id → quem declarou: aceite ou recusado
//                           (quem o chama: quem recebeu, ou o admin)
//   'pedido_acesso'        → o admin (qualquer sessão válida o pode chamar)
//
// verify_jwt LIGADO no deploy. Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT (opcional) — os mesmos da push-notificar.
//
// Deploy: supabase functions deploy prendas-notificar

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@splitbill.app";
const URL_APP = "/AnniversaryGifts/";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SCHEMA = { "Content-Profile": "anniversarygifts", "Accept-Profile": "anniversarygifts" };
const srv = { apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`, "Content-Type": "application/json", ...SCHEMA };

async function ler<T>(path: string): Promise<T[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: srv });
  return r.ok ? await r.json() : [];
}
const lista = (xs: string[]) => xs.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(",");

// Quem chama — perguntado à BD COM O TOKEN DELE, pela mesma `acesso()` da
// app: é ela que sabe quem é admin e que amigo corresponde a este email.
type Acesso = { email: string; permitido: boolean; admin: boolean; eu: string | null };
async function acessoDe(auth: string): Promise<Acesso | null> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/acesso`, {
    method: "POST",
    headers: { apikey: SB_ANON, Authorization: auth, "Content-Type": "application/json", ...SCHEMA },
    body: "{}",
  });
  if (!r.ok) return null;
  return await r.json();
}

type Sub = { endpoint: string; email: string; p256dh: string; auth_key: string };
async function enviar(emails: string[], msg: { title: string; body: string }) {
  if (!emails.length) return { enviados: 0, falhados: 0 };
  const subs = await ler<Sub>(`push_subscriptions?email=in.(${lista(emails)})&select=endpoint,email,p256dh,auth_key`);
  const payload = JSON.stringify({ ...msg, url: URL_APP });
  let enviados = 0, falhados = 0;
  const mortos: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
      enviados++;
    } catch (e) {
      const st = (e as { statusCode?: number }).statusCode;
      if (st === 404 || st === 410) mortos.push(s.endpoint);
      falhados++;
    }
  }));
  if (mortos.length) {
    await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=in.(${lista(mortos)})`, { method: "DELETE", headers: srv }).catch(() => {});
  }
  return { enviados, falhados };
}

async function emailsDe(nomes: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!nomes.length) return m;
  const rows = await ler<{ nome: string; email: string | null }>(`amigos?nome=in.(${lista(nomes)})&select=nome,email`);
  rows.forEach((r) => { if (r.email) m.set(r.nome, r.email.toLowerCase()); });
  return m;
}

type Evento = { id: number; aniversariante: string; responsavel: string; ano: number };
type Divida = { devedor: string; credor: string; saldo: number };
type Pagamento = { id: number; evento_id: number; devedor: string; credor: string; valor: number; estado: string };

const eur = (v: number) => `€${Number(v).toFixed(2)}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    const acesso = await acessoDe(req.headers.get("Authorization") ?? "");
    if (!acesso || !acesso.email) return json({ error: "não autorizado" }, 403);
    const { tipo, evento_id, pagamento_id, devedor } = await req.json() as {
      tipo?: string; evento_id?: number; pagamento_id?: number; devedor?: string;
    };

    if (tipo === "pedido_acesso") {
      const adm = await ler<{ valor: string }>(`config?chave=eq.admin_email&select=valor`);
      const email = String(adm[0]?.valor ?? "").toLowerCase();
      return json(await enviar(email ? [email] : [], {
        title: "🆕 Pedido de acesso",
        body: `${acesso.email} pediu acesso às Prendas — liga a conta a um amigo nas Definições`,
      }));
    }
    if (!acesso.permitido) return json({ error: "não autorizado" }, 403);

    if (tipo === "divida" || tipo === "lembrete") {
      const ev = (await ler<Evento>(`eventos?id=eq.${Number(evento_id)}&select=id,aniversariante,responsavel,ano`))[0];
      if (!ev) return json({ error: "evento inexistente" }, 404);
      if (!acesso.admin && acesso.eu !== ev.responsavel) return json({ error: "não autorizado" }, 403);
      let dividas = await ler<Divida>(`dividas?evento_id=eq.${ev.id}&saldo=gt.0&select=devedor,credor,saldo`);
      if (tipo === "lembrete") dividas = dividas.filter((d) => d.devedor === devedor);
      const emails = await emailsDe(dividas.map((d) => d.devedor));
      let enviados = 0, falhados = 0;
      for (const d of dividas) {
        const em = emails.get(d.devedor);
        if (!em) continue;
        const r = await enviar([em], tipo === "lembrete"
          ? { title: "🔔 Lembrete — prenda de anos", body: `${ev.responsavel} lembra-te que ainda deves ${eur(d.saldo)} da prenda do ${ev.aniversariante}` }
          : { title: "🍷 Prenda de anos", body: `A garrafa do ${ev.aniversariante} está paga pelo ${ev.responsavel} — a tua parte é ${eur(d.saldo)}` });
        enviados += r.enviados; falhados += r.falhados;
      }
      return json({ enviados, falhados });
    }

    if (tipo === "pagamento_declarado" || tipo === "pagamento_resolvido") {
      const p = (await ler<Pagamento>(`pagamentos?id=eq.${Number(pagamento_id)}&select=id,evento_id,devedor,credor,valor,estado`))[0];
      if (!p) return json({ error: "pagamento inexistente" }, 404);
      const ev = (await ler<Evento>(`eventos?id=eq.${p.evento_id}&select=id,aniversariante,responsavel,ano`))[0];
      if (!ev) return json({ error: "evento inexistente" }, 404);
      if (tipo === "pagamento_declarado") {
        if (!acesso.admin && acesso.eu !== p.devedor) return json({ error: "não autorizado" }, 403);
        if (p.estado !== "declarado") return json({ enviados: 0, falhados: 0 });
        const em = (await emailsDe([ev.responsavel])).get(ev.responsavel);
        return json(await enviar(em ? [em] : [], {
          title: "✅ Pagamento declarado",
          body: `${p.devedor} diz que já te pagou ${eur(p.valor)} da prenda do ${ev.aniversariante} — confirma na app`,
        }));
      }
      if (!acesso.admin && acesso.eu !== p.credor && acesso.eu !== ev.responsavel) return json({ error: "não autorizado" }, 403);
      if (p.estado === "declarado") return json({ enviados: 0, falhados: 0 });
      const em = (await emailsDe([p.devedor])).get(p.devedor);
      return json(await enviar(em ? [em] : [], p.estado === "confirmado"
        ? { title: "👍 Pagamento confirmado", body: `${ev.responsavel} confirmou os teus ${eur(p.valor)} da prenda do ${ev.aniversariante}` }
        : { title: "⚠️ Pagamento recusado", body: `${ev.responsavel} não confirmou os ${eur(p.valor)} da prenda do ${ev.aniversariante} — fala com ele` }));
    }

    return json({ error: "tipo desconhecido" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
