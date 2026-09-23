/* ── SESSÃO SUPABASE (mesmo projeto das outras apps; schema `anniversarygifts`) ──
   Mesmo padrão do SplitBill/WineCatalog: sessão em localStorage, refresh
   automático do access token (expira em ~1h), e Accept/Content-Profile a
   escolher o schema — NUNCA no URL.

   A chave aqui em baixo é a `anon`, pública POR DESIGN (protegida por RLS +
   login). Não é bug nem risco — não a "corrijas" nem a escondas. */
const SB_URL = 'https://gjweqwfbnkgnibhajldc.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk';
const SCHEMA = 'anniversarygifts';
// O mesmo par VAPID do SplitBill: os secrets das Edge Functions são do
// PROJETO, e a privada já lá está. A subscription é que é desta app (outro
// service worker, outro scope) — daí a tabela própria.
const VAPID_PUBLIC_KEY = 'BFiwf_z5NJzkXFP6gzxS_naH9cNC2MfCEmejJf32MID8Y_1i49cb8sGINYhH-aFAZmFQLf3V__2ZyeotQIZYQ0U';
const SESSION_KEY = 'pg_sb_session';

let _sbSession = null;
let _refreshing = null;

function sbHeaders(extra, schema) {
    return Object.assign({
        'Content-Type': 'application/json',
        'apikey': SB_KEY,
        'Accept-Profile': schema || SCHEMA,
        'Content-Profile': schema || SCHEMA
    }, extra || {});
}
function sbSaveSession(s) {
    _sbSession = s;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
}
function tokenQuaseExpirado() {
    if (!_sbSession) return false;
    if (!_sbSession.expires_at) return true;
    return (_sbSession.expires_at - Date.now() / 1000) < 120;
}
async function sbRefresh() {
    if (!_sbSession || !_sbSession.refresh_token) return false;
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
        try {
            const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
                method: 'POST', headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: _sbSession.refresh_token })
            });
            if (!r.ok) return false;
            const d = await r.json();
            sbSaveSession({
                access_token: d.access_token,
                refresh_token: d.refresh_token || _sbSession.refresh_token,
                expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
                user: d.user || _sbSession.user
            });
            return true;
        } catch (e) { return false; }
    })();
    const ok = await _refreshing;
    _refreshing = null;
    return ok;
}
async function sbEnsureFresh() {
    if (_sbSession && _sbSession.refresh_token && tokenQuaseExpirado()) await sbRefresh();
}
// fetch com token fresco; se ainda assim vier 401, refresh + 1 retry.
// Uma LEITURA nunca vem da cache do browser (lição do SplitBill: o URL do
// PostgREST é sempre o mesmo e o Safari servia a resposta de há bocado).
async function sbFetch(url, opt) {
    opt = opt || {};
    if ((opt.method || 'GET').toUpperCase() === 'GET') opt.cache = 'no-store';
    await sbEnsureFresh();
    opt.headers = Object.assign({}, opt.headers, { 'Authorization': `Bearer ${_sbSession?.access_token || SB_KEY}` });
    let r = await fetch(url, opt);
    if (r.status === 401 && _sbSession && _sbSession.refresh_token && await sbRefresh()) {
        opt.headers['Authorization'] = `Bearer ${_sbSession.access_token}`;
        r = await fetch(url, opt);
    }
    return r;
}
async function _sbErro(r) {
    let m = 'HTTP ' + r.status;
    try { const j = await r.json(); m = j.message || j.error || m; } catch (_) {}
    // O primeiro dia tem sempre o mesmo erro, e o "schema cache" não o diz.
    if (/schema must be one of|does not exist|schema cache|Invalid schema/i.test(m))
        m = 'Falta expor o schema "anniversarygifts" no Supabase (Settings → API → Exposed schemas).';
    return new Error(m);
}
async function sbGet(path) {
    const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
    if (!r.ok) throw await _sbErro(r);
    return await r.json();
}
async function sbReq(method, path, body, extra) {
    const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
        method, headers: sbHeaders(Object.assign({ 'Prefer': 'return=minimal' }, extra || {})),
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!r.ok) throw await _sbErro(r);
    const tx = await r.text();
    return tx ? JSON.parse(tx) : null;
}
async function rpc(fn, args, schema) {
    const r = await sbFetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: sbHeaders({}, schema), body: JSON.stringify(args || {})
    });
    if (!r.ok) throw await _sbErro(r);
    const tx = await r.text();
    return tx ? JSON.parse(tx) : null;
}
async function edgeFn(nome, corpo, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
        const r = await sbFetch(`${SB_URL}/functions/v1/${nome}`, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', 'apikey': SB_KEY },
            body: JSON.stringify(corpo || {})
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
    } finally { clearTimeout(t); }
}
setInterval(() => { sbEnsureFresh(); }, 10 * 60 * 1000);

/* ── ESCAPES & FORMATOS ─────────────────────────────────────────────────
   `esc` para conteúdo, `escJs` para o que vai dentro de onclick="…('…')". */
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escJs(s) { return esc(String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")); }
function eur(v) { return '€' + (Number(v) || 0).toFixed(2); }
/* Valores em euros nos CAMPOS: <input type="text" inputmode="decimal">, e
   nunca type="number". No iPhone em português o teclado dá VÍRGULA, e um
   campo number com "12," fica com value "" — a app lia isso como "sem preço",
   redesenhava a folha e o campo aparecia limpo a meio de se escrever. Por
   isso: texto, aceita vírgula ou ponto (`lerNum`), e mostra com vírgula
   (`numTxt`). */
function lerNum(s) { const v = parseFloat(String(s == null ? '' : s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) ? v : NaN; }
function numTxt(v) { return v == null || v === '' ? '' : Number(v).toFixed(2).replace('.', ','); }
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function isoDe(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function hoje() { const d = new Date(); return isoDe(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
function addDias(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const x = new Date(Date.UTC(y, m - 1, d + n));
    return isoDe(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}
function diasEntre(a, b) {
    const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
function fmtData(iso, comAno) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MESES[m - 1]}${comAno === false ? '' : ' ' + y}`;
}
function quandoTexto(iso) {
    const n = diasEntre(hoje(), iso);
    if (n === 0) return 'hoje';
    if (n === 1) return 'amanhã';
    if (n === -1) return 'ontem';
    if (n > 0) return `daqui a ${n} dias`;
    return `há ${-n} dias`;
}

/* ── TOAST ─────────────────────────────────────────────────────────────── */
let _toastT = null;
function toast(msg, ok) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast on' + (ok === false ? ' erro' : '');
    clearTimeout(_toastT);
    _toastT = setTimeout(() => { t.className = 'toast'; }, ok === false ? 5000 : 2800);
}

/* ── FOLHAS (bottom sheets) ─────────────────────────────────────────────
   Uma pilha: a prenda aberta, por cima o formulário, por cima um "tens a
   certeza?". Cada entrada é uma FUNÇÃO que desenha — fechar a de cima
   volta a desenhar a de baixo com os dados de agora (o pagamento que
   acabou de ser aceite já aparece aceite). */
const _folhas = [];
function abrirFolha(render) {
    _folhas.push(render);
    _desenharFolha();
}
function _desenharFolha() {
    const f = document.getElementById('folha');
    const fundo = document.getElementById('folha-fundo');
    if (!_folhas.length) {
        f.classList.remove('on'); fundo.classList.remove('on');
        document.documentElement.classList.remove('folha-aberta');
        return;
    }
    document.getElementById('folha-corpo').innerHTML = _folhas[_folhas.length - 1]();
    f.classList.add('on'); fundo.classList.add('on');
    document.documentElement.classList.add('folha-aberta');
    f.scrollTop = 0;
}
function fecharFolha() { _folhas.pop(); _desenharFolha(); }
function fecharTodasFolhas() { _folhas.length = 0; _desenharFolha(); }
function redesenharFolha() { if (_folhas.length) document.getElementById('folha-corpo').innerHTML = _folhas[_folhas.length - 1](); }

// Diálogo de confirmação sobre a pilha. Devolve uma Promise<boolean>.
function confirmar(titulo, msgHtml, textoOk, perigo) {
    return new Promise(res => {
        window._confRes = v => { window._confRes = null; fecharFolha(); res(v); };
        abrirFolha(() => `
          <h3 class="f-tit">${esc(titulo)}</h3>
          <p class="f-texto">${msgHtml}</p>
          <div class="f-acoes">
            <button class="btn ghost" onclick="_confRes(false)">Cancelar</button>
            <button class="btn ${perigo ? 'perigo' : 'prim'}" onclick="_confRes(true)">${esc(textoOk || 'Confirmar')}</button>
          </div>`);
    });
}
// Pedir um valor em euros (Já paguei / Recebi). Promise<number|null>.
function pedirValor(titulo, msgHtml, sugestao, textoOk) {
    return new Promise(res => {
        window._valRes = ok => {
            const v = ok ? lerNum(document.getElementById('f-valor-pedido').value) : null;
            if (ok && !(v > 0)) { toast('Valor inválido', false); return; }
            window._valRes = null; fecharFolha(); res(ok ? Math.round(v * 100) / 100 : null);
        };
        abrirFolha(() => `
          <h3 class="f-tit">${esc(titulo)}</h3>
          <p class="f-texto">${msgHtml}</p>
          <label class="campo"><span>Valor (€)</span>
            <input type="text" id="f-valor-pedido" inputmode="decimal" autocomplete="off" value="${sugestao ? numTxt(sugestao) : ''}">
          </label>
          <div class="f-acoes">
            <button class="btn ghost" onclick="_valRes(false)">Cancelar</button>
            <button class="btn prim" onclick="_valRes(true)">${esc(textoOk || 'Confirmar')}</button>
          </div>`);
    });
}

/* ── DADOS ──────────────────────────────────────────────────────────────
   Tudo o que a app sabe vem daqui e é pequeno (uma dúzia de amigos, uma
   prenda por aniversário): carrega-se tudo de uma vez, sempre. */
let AC = { email: '', permitido: false, admin: false, eu: null };   // quem sou (anniversarygifts.acesso)
let amigos = [], eventos = [], pagamentos = [], dividas = [], config = {};
let _carregadoEm = 0;

async function carregarDados() {
    const [am, ev, pg, dv, cf] = await Promise.all([
        sbGet('amigos?select=*&order=nome'),
        sbGet('eventos?select=*&order=data.desc'),
        sbGet('pagamentos?select=*&order=criado_em.desc'),
        sbGet('dividas?select=*'),
        sbGet('config?select=chave,valor')
    ]);
    amigos = am; eventos = ev; pagamentos = pg;
    dividas = dv.map(d => ({ ...d, quota: +d.quota, pago: +d.pago, por_confirmar: +d.por_confirmar, saldo: +d.saldo }));
    eventos.forEach(e => { e.valor = e.valor == null ? null : +e.valor; e.valor_dividir = e.valor_dividir == null ? null : +e.valor_dividir; e.vinho = e.vinho || {}; e.participantes = e.participantes || []; });
    pagamentos.forEach(p => { p.valor = +p.valor; });
    config = {}; cf.forEach(c => { config[c.chave] = c.valor; });
    _carregadoEm = Date.now();
}
async function recarregar(silencioso) {
    try {
        await carregarDados();
        renderTudo();
    } catch (e) {
        if (!silencioso) toast('⚠️ ' + e.message, false);
    }
}
// Voltar à app = ver o que os outros fizeram entretanto. Nunca com uma folha
// aberta: redesenhar a meio de um formulário deitava fora o que se escrevia.
document.addEventListener('visibilitychange', () => {
    if (document.hidden || !AC.permitido) return;
    sbEnsureFresh();
    if (!_folhas.length && Date.now() - _carregadoEm > 20000) recarregar(true);
});

function amigo(nome) { return amigos.find(a => a.nome === nome); }
function eventoPorId(id) { return eventos.find(e => e.id === id); }
function dividasDoEvento(id) { return dividas.filter(d => d.evento_id === id); }
function pagamentosDoEvento(id) { return pagamentos.filter(p => p.evento_id === id); }

/* ── O CICLO ────────────────────────────────────────────────────────────
   A regra toda: os amigos ATIVOS com data, ordenados pelo calendário,
   formam um círculo — quem faz anos imediatamente antes compra a garrafa
   para o seguinte (o primeiro do ano recebe do último).

   Para prendas JÁ REGISTADAS, quem manda é o que ficou gravado no evento
   (`responsavel`, `participantes`): o grupo muda, e uma prenda de março não
   pode passar a ser de outra pessoa porque em setembro entrou alguém. O
   ciclo só PROPÕE, na hora de registar. */
function amigosNoCiclo() {
    return amigos.filter(a => a.ativo && a.dia && a.mes)
        .sort((a, b) => a.mes - b.mes || a.dia - b.dia || a.nome.localeCompare(b.nome));
}
function responsavelPor(nome) {
    const c = amigosNoCiclo();
    const i = c.findIndex(a => a.nome === nome);
    if (i < 0 || c.length < 2) return null;
    return c[(i - 1 + c.length) % c.length].nome;
}
function recebeDe(nome) { // para quem é que `nome` compra
    const c = amigosNoCiclo();
    const i = c.findIndex(a => a.nome === nome);
    if (i < 0 || c.length < 2) return null;
    return c[(i + 1) % c.length].nome;
}
function bissexto(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
// Quem nasceu a 29 de fevereiro festeja a 1 de MARÇO nos anos comuns (é o
// que o João Paulo faz) — e não a 28. A posição no ciclo não muda: continua
// a ordenar-se como 29/fev, entre quem faz anos em fevereiro e em março.
function dataAnos(a, ano) {
    if (a.mes === 2 && a.dia === 29 && !bissexto(ano)) return isoDe(ano, 3, 1);
    return isoDe(ano, a.mes, a.dia);
}
// Desde quando o grupo faz isto (Definições › admin). Sem data escolhida,
// um ano para trás — chega para apanhar "isto já começou há uns meses".
function inicioGrupo() {
    const v = config.inicio;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return addDias(hoje(), -365);
}
// Cada aniversário entre o início do grupo e daqui a um ano, com a prenda
// que lhe corresponde (se já foi registada). A prenda casa pelo ANO: a
// garrafa pode ter sido entregue dias depois, e isso não a torna outra.
function aniversarios() {
    const ini = inicioGrupo(), fim = addDias(hoje(), 365);
    const out = [];
    for (const a of amigosNoCiclo()) {
        for (let y = +ini.slice(0, 4); y <= +fim.slice(0, 4); y++) {
            const d = dataAnos(a, y);
            if (d < ini || d > fim) continue;
            out.push({ nome: a.nome, data: d, ano: y, evento: eventos.find(e => e.aniversariante === a.nome && e.ano === y) || null });
        }
    }
    return out.sort((x, y) => x.data.localeCompare(y.data));
}
function proximosAniversarios() { const h = hoje(); return aniversarios().filter(x => x.data >= h); }
// Inclui os de HOJE: é o dia em que a garrafa se entrega, e é quando mais
// se quer registá-la.
function aniversariosPorRegistar() { const h = hoje(); return aniversarios().filter(x => x.data <= h && !x.evento); }

/* ── PERMISSÕES (a UI só decide que botões mostrar; o servidor confirma) ── */
function podeGerirEvento(ev) { return AC.admin || (!!AC.eu && ev.responsavel === AC.eu); }
function podeRegistarAniversario(nome) { return AC.admin || (!!AC.eu && responsavelPor(nome) === AC.eu); }

/* ── NAVEGAÇÃO ──────────────────────────────────────────────────────────── */
let _pagina = 'inicio';
const TITULOS = { inicio: 'Prendas', prendas: 'Prendas dadas', dividas: 'Dívidas', ciclo: 'Ciclo', definicoes: 'Definições' };
function irPara(p) {
    _pagina = p;
    document.querySelectorAll('.pagina').forEach(s => { s.hidden = s.id !== 'pg-' + p; });
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === p));
    document.getElementById('topo-titulo').textContent = TITULOS[p] || 'Prendas';
    renderPagina(p);
    window.scrollTo(0, 0);
    if (Date.now() - _carregadoEm > 30000) recarregar(true);
}
function renderPagina(p) {
    ({ inicio: renderInicio, prendas: renderPrendas, dividas: renderDividas, ciclo: renderCiclo, definicoes: renderDefinicoes }[p] || renderInicio)();
}
function renderTudo() {
    renderPagina(_pagina);
    redesenharFolha();
    const minhas = dividas.filter(d => d.devedor === AC.eu && d.saldo > 0.004).length
        + pagamentosParaConfirmar().length;
    const b = document.getElementById('badge-dividas');
    b.hidden = !minhas; b.textContent = minhas;
}

/* ── BOCADOS REUTILIZADOS ───────────────────────────────────────────────── */
function avatar(nome, grande) {
    const ini = String(nome || '?').split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
    let h = 0; for (const c of String(nome)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<span class="av${grande ? ' g' : ''}" style="--h:${h}" aria-hidden="true">${esc(ini)}</span>`;
}
function nomeVinho(v) {
    if (!v || !v.nome) return '';
    return v.nome + (v.ano ? ' ' + v.ano : '');
}
const ESTADOS = { por_comprar: 'Por comprar', comprado: 'Comprada', entregue: 'Entregue' };
function estadoPill(ev) {
    return `<span class="pill est-${ev.estado}">${ESTADOS[ev.estado] || ev.estado}</span>`;
}
// Quanto falta receber numa prenda: soma dos saldos > 0 da view.
function resumoPagamentos(ev) {
    const ds = dividasDoEvento(ev.id);
    if (!ds.length) return null;
    const pagos = ds.filter(d => d.saldo <= 0.004).length;
    return { pagos, total: ds.length, falta: ds.reduce((s, d) => s + Math.max(0, d.saldo), 0) };
}
/* A fotografia da garrafa. As das lojas vêm quase sempre em fundo BRANCO,
   e dentro da caixa lilás ficavam duas bandas brancas em cima e em baixo.
   `mix-blend-mode: multiply` (ver `.foto img`) funde o branco com o fundo
   da caixa — a garrafa fica, o rectângulo desaparece. */
function fotoVinho(v, cls) {
    return `<span class="foto ${cls}">${v && v.imagem_url
        ? `<img src="${esc(v.imagem_url)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('sem');this.remove()">`
        : ''}</span>`;
}
function cartaoPrenda(ev) {
    const v = ev.vinho || {};
    const r = resumoPagamentos(ev);
    const detalhe = [v.produtor, v.tipo, v.regiao].filter(Boolean).map(esc).join(' · ');
    const tags = [];
    if (v.vivino_nota) tags.push(`<span class="cp-tag">★ ${Number(v.vivino_nota).toFixed(1)}</span>`);
    if (ev.valor) tags.push(`<span class="cp-tag">${eur(ev.valor)}</span>`);
    if (r) tags.push(`<span class="cp-tag ${r.pagos === r.total ? 'ok' : 'espera'}">${r.pagos}/${r.total} pagos</span>`);
    return `
      <button class="cartao cp" onclick="abrirEvento(${ev.id})">
        ${fotoVinho(v, 'cp-foto' + (v.imagem_url ? '' : ' sem'))}
        <span class="cp-txt">
          <span class="cp-l1"><b>🎂 ${esc(ev.aniversariante)}</b><span class="cp-data">${fmtData(ev.data)}</span></span>
          <span class="cp-l2">${v.nome ? esc(nomeVinho(v)) : '<i>garrafa por escolher</i>'}</span>
          ${detalhe ? `<span class="cp-l3">${detalhe}</span>` : ''}
          <span class="cp-l3">comprada pelo ${esc(ev.responsavel)}</span>
          <span class="cp-tags">${ev.estado === 'entregue' ? '' : estadoPill(ev)}${tags.join('')}</span>
        </span>
      </button>`;
}
function vazio(txt) { return `<div class="vazio">${txt}</div>`; }

/* ── ECRÃ INICIAL ───────────────────────────────────────────────────────
   Primeiro o que pede uma ação MINHA (comprar uma garrafa, confirmar um
   pagamento, pagar a minha parte), depois a agenda. */
function pagamentosParaConfirmar() {
    return pagamentos.filter(p => {
        if (p.estado !== 'declarado') return false;
        const ev = eventoPorId(p.evento_id);
        return !!AC.eu && (p.credor === AC.eu || (ev && ev.responsavel === AC.eu));
    });
}
function renderInicio() {
    const el = document.getElementById('pg-inicio');
    const h = hoje();
    const prox = proximosAniversarios();
    let html = `<p class="ola">Olá${AC.eu ? ', <b>' + esc(AC.eu) + '</b>' : ''} 👋</p>`;

    if (!amigosNoCiclo().length) {
        html += `<div class="cartao aviso">Ainda não há datas de anos na lista de amigos.${AC.admin ? ' Mete-as em <a href="#" onclick="irPara(\'definicoes\');return false">Definições › Amigos</a>.' : ' O admin trata disso.'}</div>`;
    }

    // Os quatro cartões grandes: o que se quer saber ao abrir a app.
    html += `<div class="hero">${cartaoProximoAnos(prox)}${cartaoMinhaCompra(prox)}${cartaoUltimaRecebida()}${cartaoMinhaConta()}</div>`;

    // Pagamentos que me declararam e esperam por mim.
    const conf = pagamentosParaConfirmar();
    if (conf.length) {
        html += `<h2 class="sec">Para confirmar <span class="sec-tot">${conf.length}</span></h2><div class="lista">` + conf.map(p => {
            const ev = eventoPorId(p.evento_id);
            return `<div class="cartao linha">${avatar(p.devedor)}
              <span class="ln-txt"><b>${esc(p.devedor)}</b> diz que pagou <b>${eur(p.valor)}</b><small>prenda do ${esc(ev ? ev.aniversariante : '?')}</small></span>
              <span class="ln-acoes"><button class="btn mini ok" onclick="resolverPagamento(${p.id},true)">Aceitar</button><button class="btn mini ghost" onclick="resolverPagamento(${p.id},false)">Recusar</button></span></div>`;
        }).join('') + `</div>`;
    }

    // Aniversários passados sem prenda registada (o grupo já começou antes da app).
    const falta = aniversariosPorRegistar();
    if (falta.length) {
        html += `<h2 class="sec">Por registar <span class="sec-tot">${falta.length}</span></h2>
          <p class="sec-nota">Aniversários desde ${fmtData(inicioGrupo())} sem prenda na app.</p>
          <div class="lista">` + falta.slice().reverse().map(linhaAniversario).join('') + `</div>`;
    }
    el.innerHTML = html;
}
// 1. Quem faz anos a seguir, e quem compra.
function cartaoProximoAnos(prox) {
    const x = prox[0];
    if (!x) return `<div class="hc anos largo"><span class="hc-rot">Próximo aniversário</span><span class="hc-med">Sem datas marcadas</span></div>`;
    const resp = x.evento ? x.evento.responsavel : responsavelPor(x.nome);
    const n = diasEntre(hoje(), x.data);
    // Sem prenda ainda: quem a pode registar (quem compra, ou o admin) vai
    // direto ao formulário. Isto chegou a levar ao Ciclo — e a prenda dos anos
    // de HOJE ficava sem porta nenhuma, porque "Por registar" só tinha o passado.
    const podeReg = !x.evento && podeRegistarAniversario(x.nome);
    const click = x.evento ? `abrirEvento(${x.evento.id})` : (podeReg ? `novoEvento('${escJs(x.nome)}','${x.data}')` : `irPara('ciclo')`);
    return `<button class="hc anos largo" onclick="${click}">
        <span class="hc-deco" aria-hidden="true">🎂</span>
        <span class="hc-rot">Próximo aniversário</span>
        <span class="hc-big">${esc(x.nome)}${x.nome === AC.eu ? ' <small style="color:inherit;opacity:.8">(tu!)</small>' : ''}</span>
        <span class="hc-txt">${fmtData(x.data, false)} · ${n === 0 ? 'é hoje! 🎉' : quandoTexto(x.data)}</span>
        <span class="hc-pe"><span class="hc-chip">🛒 compra ${resp ? esc(resp) + (resp === AC.eu ? ' (tu)' : '') : '—'}</span>${x.evento ? `<span class="hc-chip">${ESTADOS[x.evento.estado]}</span>` : (podeReg ? `<span class="hc-chip">Registar ›</span>` : '')}</span>
      </button>`;
}
// 2. A próxima garrafa que ME cabe comprar.
function cartaoMinhaCompra(prox) {
    if (!AC.eu) return '';
    const x = prox.find(p => (p.evento ? p.evento.responsavel : responsavelPor(p.nome)) === AC.eu && !(p.evento && p.evento.estado === 'entregue'));
    if (!x) return `<div class="hc compra calma"><span class="hc-rot">A tua próxima prenda</span><span class="hc-med">Nada a comprar</span><span class="hc-txt">Não estás no ciclo, ou já está tudo entregue.</span></div>`;
    const n = diasEntre(hoje(), x.data);
    const urgente = n <= 30 && (!x.evento || x.evento.estado === 'por_comprar');
    const click = x.evento ? `abrirEvento(${x.evento.id})` : `novoEvento('${escJs(x.nome)}','${x.data}')`;
    return `<button class="hc compra${urgente ? '' : ' calma'}" onclick="${click}">
        <span class="hc-deco" aria-hidden="true">🎁</span>
        <span class="hc-rot">A tua próxima prenda</span>
        <span class="hc-med">Para o ${esc(x.nome)}</span>
        <span class="hc-txt">${fmtData(x.data, false)} · ${quandoTexto(x.data)}</span>
        <span class="hc-pe"><span class="hc-chip">${x.evento ? ESTADOS[x.evento.estado] : 'Registar ›'}</span></span>
      </button>`;
}
// 3. A última garrafa que me ofereceram.
function cartaoUltimaRecebida() {
    if (!AC.eu) return '';
    const ev = eventos.filter(e => e.aniversariante === AC.eu && e.data <= hoje()).sort((a, b) => b.data.localeCompare(a.data))[0];
    if (!ev) return `<div class="hc recebi"><span class="hc-rot">Última que recebeste</span><span class="hc-med">Ainda nenhuma</span><span class="hc-txt">Quando a tua prenda for registada, aparece aqui.</span></div>`;
    const v = ev.vinho || {};
    return `<button class="hc recebi" onclick="abrirEvento(${ev.id})">
        <span class="hc-rot">Última que recebeste</span>
        ${v.imagem_url ? fotoVinho(v, 'hc-img') : ''}
        <span class="hc-med">${v.nome ? esc(nomeVinho(v)) : '🍷 Garrafa sem nome'}</span>
        <span class="hc-txt">do ${esc(ev.responsavel)} · ${fmtData(ev.data)}</span>
      </button>`;
}
// 4. A minha conta: o que devo e o que tenho a receber.
function cartaoMinhaConta() {
    if (!AC.eu) return '';
    const pagar = dividas.filter(d => d.devedor === AC.eu && d.saldo > 0.004).reduce((s, d) => s + d.saldo, 0);
    const receber = dividas.filter(d => d.credor === AC.eu && d.saldo > 0.004).reduce((s, d) => s + d.saldo, 0);
    return `<button class="hc conta largo" onclick="_soMinhas=true;irPara('dividas')">
        <span class="hc-rot">A tua conta</span>
        <span class="hc-duo">
          <span><span class="hc-num ${pagar > 0.004 ? 'neg' : 'zero'}">${eur(pagar)}</span><span class="hc-sub">a pagar</span></span>
          <span><span class="hc-num ${receber > 0.004 ? 'pos' : 'zero'}">${eur(receber)}</span><span class="hc-sub">a receber</span></span>
        </span>
      </button>`;
}
function linhaAniversario(x) {
    const resp = x.evento ? x.evento.responsavel : responsavelPor(x.nome);
    const n = diasEntre(hoje(), x.data);
    const quando = n >= 0 && n <= 60 ? quandoTexto(x.data) : fmtData(x.data);
    let acao = '';
    if (x.evento) acao = estadoPill(x.evento);
    else if (podeRegistarAniversario(x.nome)) acao = `<button class="btn mini prim" onclick="event.stopPropagation();novoEvento('${escJs(x.nome)}','${x.data}')">Registar</button>`;
    const click = x.evento ? `abrirEvento(${x.evento.id})` : (podeRegistarAniversario(x.nome) ? `novoEvento('${escJs(x.nome)}','${x.data}')` : '');
    return `<div class="cartao linha"${click ? ` onclick="${click}"` : ''}>${avatar(x.nome)}
      <span class="ln-txt"><b>🎂 ${esc(x.nome)}</b><small>${esc(quando)} · compra ${resp ? '<b>' + esc(resp) + '</b>' + (resp === AC.eu ? ' (tu)' : '') : '—'}</small></span>
      ${acao}</div>`;
}

/* ── PRENDAS (histórico) ────────────────────────────────────────────────── */
let _filtroAno = null;
function renderPrendas() {
    const el = document.getElementById('pg-prendas');
    const anos = [...new Set(eventos.map(e => e.ano))].sort((a, b) => b - a);
    if (_filtroAno && !anos.includes(_filtroAno)) _filtroAno = null;
    const lista = eventos.filter(e => !_filtroAno || e.ano === _filtroAno);
    const total = lista.reduce((s, e) => s + (e.valor || 0), 0);
    let html = '';
    if (anos.length > 1) {
        html += `<div class="chips"><button class="chip${!_filtroAno ? ' on' : ''}" onclick="_filtroAno=null;renderPrendas()">Todas</button>` +
            anos.map(a => `<button class="chip${_filtroAno === a ? ' on' : ''}" onclick="_filtroAno=${a};renderPrendas()">${a}</button>`).join('') + `</div>`;
    }
    if (lista.length) html += `<p class="sec-nota">${lista.length} prenda${lista.length === 1 ? '' : 's'} · ${eur(total)} em vinho</p>`;
    html += lista.length ? `<div class="lista">${lista.map(cartaoPrenda).join('')}</div>`
        : vazio('Ainda não há prendas registadas.<br>Começa pelas que já foram dadas — estão em <b>Início › Por registar</b>.');
    if (AC.admin) html += `<button class="btn ghost largo" onclick="novoEvento(null, hoje())">+ Prenda fora do ciclo</button>`;
    el.innerHTML = html;
}

/* ── DÍVIDAS (públicas) ─────────────────────────────────────────────────
   Toda a gente vê tudo, de propósito: é um grupo de amigos, e a pergunta
   "quem é que ainda não pagou a garrafa do Filipe?" é de todos. Os números
   vêm só da view `dividas` — nunca se recalcula uma quota aqui. */
let _soMinhas = false;
function renderDividas() {
    const el = document.getElementById('pg-dividas');
    const abertas = dividas.filter(d => d.saldo > 0.004 && (!_soMinhas || d.devedor === AC.eu || d.credor === AC.eu));
    // Totais por pessoa (deve / a receber) — sobre todas, não sobre o filtro.
    const pp = {};
    dividas.filter(d => d.saldo > 0.004).forEach(d => {
        (pp[d.devedor] = pp[d.devedor] || { deve: 0, recebe: 0 }).deve += d.saldo;
        (pp[d.credor] = pp[d.credor] || { deve: 0, recebe: 0 }).recebe += d.saldo;
    });
    const pessoas = Object.keys(pp).sort((a, b) => (pp[b].deve - pp[b].recebe) - (pp[a].deve - pp[a].recebe));
    let html = `<div class="chips">
        <button class="chip${!_soMinhas ? ' on' : ''}" onclick="_soMinhas=false;renderDividas()">Todas</button>
        <button class="chip${_soMinhas ? ' on' : ''}" onclick="_soMinhas=true;renderDividas()">As minhas</button></div>`;

    const conf = pagamentosParaConfirmar();
    if (conf.length) html += `<div class="cartao aviso">Tens ${conf.length} pagamento${conf.length === 1 ? '' : 's'} para confirmar — estão no <a href="#" onclick="irPara('inicio');return false">Início</a>.</div>`;

    if (!_soMinhas && pessoas.length) {
        html += `<h2 class="sec">Por pessoa</h2><div class="cartao tabela">` + pessoas.map(n => `
          <div class="tb-l">${avatar(n)}<span class="tb-n">${esc(n)}</span>
            <span class="tb-v ${pp[n].deve > 0.004 ? 'neg' : ''}">${pp[n].deve > 0.004 ? 'deve ' + eur(pp[n].deve) : ''}</span>
            <span class="tb-v ${pp[n].recebe > 0.004 ? 'pos' : ''}">${pp[n].recebe > 0.004 ? 'recebe ' + eur(pp[n].recebe) : ''}</span></div>`).join('') + `</div>`;
    }

    html += `<h2 class="sec">Em aberto <span class="sec-tot">${eur(abertas.reduce((s, d) => s + d.saldo, 0))}</span></h2>`;
    if (!abertas.length) { el.innerHTML = html + vazio('Ninguém deve nada. 🥂'); return; }
    // Agrupadas por prenda, a mais antiga primeiro — é a que está há mais tempo à espera.
    const porEv = {};
    abertas.forEach(d => { (porEv[d.evento_id] = porEv[d.evento_id] || []).push(d); });
    const ids = Object.keys(porEv).map(Number).sort((a, b) => (eventoPorId(a)?.data || '').localeCompare(eventoPorId(b)?.data || ''));
    html += ids.map(id => {
        const ev = eventoPorId(id);
        if (!ev) return '';
        return `<div class="cartao grupo"><button class="gr-cab" onclick="abrirEvento(${id})">🎂 <b>${esc(ev.aniversariante)}</b> · ${fmtData(ev.data)}<span>pago por ${esc(ev.responsavel)} ›</span></button>` +
            porEv[id].map(d => `<div class="gr-l">${avatar(d.devedor)}<span class="gr-n">${esc(d.devedor)}${d.devedor === AC.eu ? ' (tu)' : ''}</span>
              ${d.por_confirmar > 0 ? '<span class="pill espera">⏳</span>' : ''}
              <b class="gr-v">${eur(d.saldo)}</b>
              ${d.devedor === AC.eu && !(d.por_confirmar > 0) ? `<button class="btn mini prim" onclick="declararPagamento(${id})">Já paguei</button>` : ''}</div>`).join('') + `</div>`;
    }).join('');
    el.innerHTML = html;
}

/* ── CICLO ──────────────────────────────────────────────────────────────── */
function renderCiclo() {
    const el = document.getElementById('pg-ciclo');
    const c = amigosNoCiclo();
    let html = `<p class="sec-nota">Por ordem de anos: cada um compra a garrafa ao seguinte, e o custo divide-se por todos menos quem faz anos.</p>`;
    if (c.length < 2) html += vazio('São precisos pelo menos dois amigos com data de anos.');
    else html += `<div class="ciclo">` + c.map((a, i) => `
        <div class="cc-l${a.nome === AC.eu ? ' eu' : ''}">
          <span class="cc-data"><b>${a.dia}</b>${MESES[a.mes - 1]}</span>
          ${avatar(a.nome)}<span class="cc-n">${esc(a.nome)}${a.nome === AC.eu ? ' <small>(tu)</small>' : ''}</span>
          <span class="cc-compra">🎁 compra ao <b>${esc(c[(i + 1) % c.length].nome)}</b></span>
        </div>`).join('') + `<div class="cc-volta">↺ e o ${esc(c[c.length - 1].nome)} compra ao ${esc(c[0].nome)}</div></div>`;
    const semData = amigos.filter(a => a.ativo && !(a.dia && a.mes));
    if (semData.length) html += `<p class="sec-nota">Sem data de anos (fora do ciclo): ${semData.map(a => esc(a.nome)).join(', ')}.</p>`;
    if (AC.admin) html += `<button class="btn ghost largo" onclick="irPara('definicoes')">Editar amigos e datas</button>`;
    el.innerHTML = html;
}

/* ── A PRENDA (ver) ─────────────────────────────────────────────────────── */
function abrirEvento(id) {
    abrirFolha(() => folhaEvento(id));
}
function folhaEvento(id) {
    const ev = eventoPorId(id);
    if (!ev) return `<p class="f-texto">Esta prenda já não existe.</p><div class="f-acoes"><button class="btn ghost" onclick="fecharFolha()">Fechar</button></div>`;
    const v = ev.vinho || {};
    const gerir = podeGerirEvento(ev);
    const ds = dividasDoEvento(ev.id);
    const n = ev.participantes.length;
    let html = `
      <div class="ev-cab">
        <div><h3 class="f-tit">🎂 ${esc(ev.aniversariante)}</h3>
        <div class="ev-sub">${fmtData(ev.data)} · compra <b>${esc(ev.responsavel)}</b></div></div>
        ${estadoPill(ev)}
      </div>`;

    // O vinho
    html += v.nome ? vinhoFicha(v) : `<div class="cartao vazio-vinho">🍷 Garrafa ainda por escolher${gerir ? ' — <a href="#" onclick="editarEvento(' + ev.id + ');return false">escolher</a>' : ''}.</div>`;
    if (gerir && v.nome) html += `<button class="btn ghost largo" id="btn-cat-${ev.id}" onclick="atualizarDoCatalogo(${ev.id})">🔄 Atualizar do catálogo</button>`;

    // A divisão
    html += `<h4 class="f-sec">Divisão</h4>`;
    if (!ev.valor) {
        html += `<p class="f-texto">${ev.estado === 'por_comprar' ? 'Ainda sem preço' : 'Sem preço registado — ninguém deve nada por esta prenda'}. ${n} pessoa${n === 1 ? '' : 's'} a dividir: ${ev.participantes.map(esc).join(', ')}.</p>`;
    } else {
        const div = valorADividir(ev);
        const quota = ds.length ? ds[0].quota : div;
        const excesso = Math.round((ev.valor - div) * 100) / 100;
        const parteResp = Math.round((div - quota * ds.length) * 100) / 100;
        html += `<p class="f-texto">${excesso > 0.004 ? `Custou <b>${eur(ev.valor)}</b>; divide-se <b>${eur(div)}</b> — os ${eur(excesso)} acima ficam com o ${esc(ev.responsavel)}.<br>` : ''}<b>${eur(div)}</b> ÷ ${n} = <b>${eur(quota)}</b> cada${Math.abs(parteResp - quota) > 0.004 && Math.abs(parteResp - quota) < 0.1 ? ` <small>(o ${esc(ev.responsavel)} fica com ${eur(parteResp)} — o cêntimo do arredondamento)</small>` : ''}</p>
          <div class="cartao tabela">
            <div class="tb-l">${avatar(ev.responsavel)}<span class="tb-n">${esc(ev.responsavel)}</span><span class="pill est-comprado">comprou</span></div>` +
            ds.map(d => {
                let est, acoes = '';
                if (d.saldo <= 0.004) est = `<span class="pill ok">✓ pago</span>`;
                else if (d.por_confirmar > 0) est = `<span class="pill espera">⏳ ${eur(d.por_confirmar)}</span>`;
                else est = `<b class="tb-v neg">${eur(d.saldo)}</b>`;
                if (d.saldo > 0.004) {
                    if (d.devedor === AC.eu && !(d.por_confirmar > 0)) acoes = `<button class="btn mini prim" onclick="declararPagamento(${ev.id})">Já paguei</button>`;
                    if (gerir) acoes += `<button class="btn mini ghost" onclick="registarRecebido(${ev.id},'${escJs(d.devedor)}')">Recebi</button><button class="btn mini ghost" title="Lembrar" onclick="lembrar(${ev.id},'${escJs(d.devedor)}')">🔔</button>`;
                }
                return `<div class="tb-l">${avatar(d.devedor)}<span class="tb-n">${esc(d.devedor)}</span>${est}${acoes ? `<span class="tb-acoes">${acoes}</span>` : ''}</div>`;
            }).join('') + `</div>`;
    }

    // Os pagamentos (histórico)
    const pgs = pagamentosDoEvento(ev.id);
    if (pgs.length) {
        html += `<h4 class="f-sec">Pagamentos</h4><div class="cartao tabela">` + pgs.map(p => {
            const ic = p.estado === 'confirmado' ? '✅' : p.estado === 'declarado' ? '⏳' : '✖️';
            const podeRes = p.estado === 'declarado' && (gerir || p.credor === AC.eu);
            const podeAnular = gerir || p.credor === AC.eu || (p.devedor === AC.eu && p.estado !== 'confirmado');
            return `<div class="tb-l pg-${p.estado}"><span class="pg-ic">${ic}</span><span class="tb-n">${esc(p.devedor)} · ${eur(p.valor)}<small>${fmtData(String(p.criado_em).slice(0, 10))}${p.estado === 'recusado' ? ' · recusado' : ''}${p.nota ? ' · ' + esc(p.nota) : ''}</small></span>
              <span class="tb-acoes">${podeRes ? `<button class="btn mini ok" onclick="resolverPagamento(${p.id},true)">Aceitar</button><button class="btn mini ghost" onclick="resolverPagamento(${p.id},false)">Recusar</button>` : ''}
              ${podeAnular ? `<button class="btn mini ghost" title="Anular" onclick="anularPagamento(${p.id})">↩︎</button>` : ''}</span></div>`;
        }).join('') + `</div>`;
    }
    if (ev.notas) html += `<h4 class="f-sec">Notas</h4><p class="f-texto">${esc(ev.notas)}</p>`;

    html += `<div class="f-acoes">
        <button class="btn ghost" onclick="fecharFolha()">Fechar</button>
        ${gerir ? `<button class="btn prim" onclick="editarEvento(${ev.id})">Editar</button>` : ''}
      </div>`;
    if (!gerir) html += `<p class="f-rodape">Quem mexe nesta prenda é o ${esc(ev.responsavel)} (ou o admin).</p>`;
    return html;
}
// O que se divide numa prenda: o preço, ou menos se ficou acima do limite.
function valorADividir(ev) { return ev.valor_dividir != null ? ev.valor_dividir : (ev.valor || 0); }
function vinhoFicha(v) {
    const linha2 = [v.produtor, v.tipo, v.regiao].filter(Boolean).map(esc).join(' · ');
    const factos = [];
    if (v.castas && v.castas.length) factos.push(['Castas', esc([].concat(v.castas).join(', '))]);
    if (v.teor) factos.push(['Álcool', esc(v.teor) + '%']);
    if (v.estagio) factos.push(['Estágio', esc(v.estagio)]);
    if (v.vivino_nota) factos.push(['Vivino', `★ ${Number(v.vivino_nota).toFixed(1)}${v.vivino_url ? ` <a href="${esc(v.vivino_url)}" target="_blank" rel="noopener">ver ›</a>` : ''}`]);
    else if (v.vivino_url) factos.push(['Vivino', `<a href="${esc(v.vivino_url)}" target="_blank" rel="noopener">ver página ›</a>`]);
    if (v.preco_medio) factos.push(['Preço de mercado', eur(v.preco_medio)]);
    if (v.loja) factos.push(['Comprado em', esc(v.loja)]);
    const origem = { catalogo: '📚 do catálogo de vinhos', pesquisa: '🔎 de uma pesquisa na internet', manual: '✍️ escrito à mão' }[v.origem] || '';
    return `
      <div class="cartao vinho">
        <div class="vn-topo">
          ${fotoVinho(v, 'vn-img' + (v.imagem_url ? '' : ' sem'))}
          <div><div class="vn-nome">${esc(nomeVinho(v))}</div><div class="vn-l2">${linha2}</div></div>
        </div>
        ${factos.length ? `<dl class="vn-factos">${factos.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join('')}</dl>` : ''}
        ${v.notas_prova ? `<p class="vn-p"><b>Prova.</b> ${esc(v.notas_prova)}</p>` : ''}
        ${v.harmonizacao ? `<p class="vn-p"><b>Com.</b> ${esc(v.harmonizacao)}</p>` : ''}
        ${v.resumo ? `<p class="vn-p">${esc(v.resumo)}</p>` : ''}
        ${origem || (v.fontes && v.fontes.length) ? `<p class="vn-origem">${origem}${(v.fontes || []).length ? ' · fontes: ' + v.fontes.slice(0, 3).map(f => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.titulo || 'link')}</a>`).join(', ') : ''}</p>` : ''}
      </div>`;
}

/* ── A PRENDA (registar / editar) ───────────────────────────────────────
   O formulário vive num objeto (`_form`) e não só no DOM: a pesquisa do
   vinho escreve nele, e redesenhar a folha (por exemplo ao voltar de um
   "tens a certeza?") não pode deitar fora o que já se escreveu. */
let _form = null;
const CAMPOS_VINHO = ['nome', 'produtor', 'ano', 'tipo', 'regiao', 'castas', 'preco_medio', 'vivino_nota', 'loja',
    'teor', 'estagio', 'vivino_url', 'imagem_url', 'notas_prova', 'harmonizacao', 'resumo'];
const TIPOS_VINHO = ['', 'Tinto', 'Branco', 'Rosé', 'Espumante', 'Licoroso', 'Frisante'];

function novoEvento(nome, data) {
    const aniv = nome || '';
    _form = {
        id: null, aniversariante: aniv, data: data || hoje(),
        responsavel: aniv ? (responsavelPor(aniv) || '') : (AC.eu || ''),
        participantes: amigos.filter(a => a.ativo && a.nome !== aniv).map(a => a.nome),
        estado: (data || hoje()) < hoje() ? 'entregue' : 'por_comprar',
        valor: '', dividir: '', dividirManual: false, notas: '', vinho: {}, pagos: [], pagosAntes: []
    };
    abrirFolha(folhaForm);
}
function editarEvento(id) {
    const ev = eventoPorId(id);
    if (!ev) return;
    // Quem já tem a conta a zero nesta prenda aparece marcado como "já pagou".
    const pagos = dividasDoEvento(id).filter(d => d.saldo <= 0.004).map(d => d.devedor);
    _form = {
        id: ev.id, aniversariante: ev.aniversariante, data: ev.data, responsavel: ev.responsavel,
        participantes: ev.participantes.slice(), estado: ev.estado,
        valor: ev.valor == null ? '' : numTxt(ev.valor), notas: ev.notas || '',
        dividir: ev.valor_dividir == null ? '' : numTxt(ev.valor_dividir), dividirManual: ev.valor_dividir != null,
        vinho: JSON.parse(JSON.stringify(ev.vinho || {})),
        pagos: pagos.slice(), pagosAntes: pagos
    };
    abrirFolha(folhaForm);
}
// Copia o que está nos campos para o `_form` (antes de qualquer redesenho).
function lerForm() {
    if (!_form) return;
    const $ = id => document.getElementById(id);
    if ($('f-aniv')) _form.aniversariante = $('f-aniv').value;
    if ($('f-resp')) _form.responsavel = $('f-resp').value;
    if ($('f-data')) _form.data = $('f-data').value;
    if ($('f-valor')) _form.valor = $('f-valor').value;
    if ($('f-dividir') && _form.dividirManual) _form.dividir = $('f-dividir').value;
    if ($('f-notas')) _form.notas = $('f-notas').value;
    CAMPOS_VINHO.forEach(k => {
        const e = $('fv-' + k);
        if (!e) return;
        let val = e.value.trim();
        if (k === 'castas') val = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
        else if (['ano', 'preco_medio', 'vivino_nota', 'teor'].includes(k)) val = val === '' ? null : Number(String(val).replace(',', '.'));
        if (val === null || val === '' || (Array.isArray(val) && !val.length)) delete _form.vinho[k];
        else _form.vinho[k] = val;
    });
}
/* O PREÇO é sempre OPCIONAL: registar a garrafa e gerir as contas pela app
   são coisas separadas, e a segunda é com cada um. Sem preço ninguém deve
   nada. (Chegou a ser obrigatório daqui em diante; saiu a pedido do dono —
   não voltar a pôr sem ele pedir.) A função fica para o formulário saber que
   rótulo mostrar. */
function _formPrecoObrigatorio() { return false; }
function _formValor() {
    const v = lerNum(_form.valor);
    return v > 0 ? v : 0;
}
/* O LIMITE (config `limite_prenda`, Definições › admin): quem escolhe gastar
   mais normalmente fica com o excedente. Por isso ao lado do preço há "A
   dividir", que PROPÕE min(preço, limite) — e que se pode mudar, porque
   "normalmente" não é "sempre". O servidor só garante que não passa do preço. */
function limitePrenda() {
    const v = Number(config.limite_prenda);
    return v > 0 ? v : null;
}
function _formDividirAuto() {
    const v = _formValor(), l = limitePrenda();
    return v ? (l && v > l ? l : v) : 0;
}
function _formDividir() {
    if (!_formValor()) return 0;
    if (!_formDividirManual()) return _formDividirAuto();
    const d = lerNum(_form.dividir);
    return d >= 0 ? d : 0;
}
function _formDividirManual() { return _form.dividirManual && String(_form.dividir).trim() !== ''; }
function folhaForm() {
    const f = _form;
    const v = f.vinho;
    const nomes = amigos.map(a => a.nome);
    const opts = (sel, excluir) => `<option value=""></option>` + nomes.filter(n => n !== excluir).map(n => `<option${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const campoV = (k, rot, tipo, extra) => `<label class="campo"><span>${rot}</span><input id="fv-${k}" type="${tipo || 'text'}" value="${esc(k === 'castas' ? [].concat(v.castas || []).join(', ') : (v[k] == null ? '' : v[k]))}" ${extra || ''}></label>`;
    const n = Math.max(1, _formParticipantes().length);
    const obrig = _formPrecoObrigatorio();
    return `
      <h3 class="f-tit">${f.id ? 'Editar prenda' : 'Registar prenda'}</h3>

      <div class="f-bloco">
        ${AC.admin ? `
          <div class="grelha2">
            <label class="campo"><span>Faz anos</span><select id="f-aniv" onchange="lerForm();_formMudouAniv()">${opts(f.aniversariante)}</select></label>
            <label class="campo"><span>Compra</span><select id="f-resp" onchange="lerForm();redesenharFolha()">${opts(f.responsavel, f.aniversariante)}</select></label>
          </div>` : `<p class="f-texto" style="margin-top:0">🎂 <b>${esc(f.aniversariante)}</b> · compra <b>${esc(f.responsavel)}</b></p>`}
        <label class="campo"><span>Data</span><input id="f-data" type="date" value="${esc(f.data)}" onchange="lerForm();redesenharFolha()"></label>
        <div class="seg" role="group" aria-label="Estado">
          ${Object.keys(ESTADOS).map(k => `<button class="${f.estado === k ? 'on' : ''}" onclick="lerForm();_form.estado='${k}';redesenharFolha()">${ESTADOS[k]}</button>`).join('')}
        </div>
        <div class="grelha2">
          <label class="campo"><span>Preço pago ${obrig ? '<b class="obrig">*</b>' : '<small>(opcional)</small>'}</span>
            <input id="f-valor" type="text" inputmode="decimal" autocomplete="off" value="${esc(f.valor)}" placeholder="${obrig ? '€' : 'sem preço'}" oninput="lerForm();_formAtualizarQuota()"></label>
          <label class="campo"><span>A dividir ${limitePrenda() ? `<small>(máx. ${eur(limitePrenda())})</small>` : ''}</span>
            <input id="f-dividir" type="text" inputmode="decimal" autocomplete="off" value="${_formDividirManual() ? esc(f.dividir) : (_formValor() ? numTxt(_formDividirAuto()) : '')}" oninput="_form.dividirManual=true;lerForm();_formAtualizarQuota()"></label>
        </div>
        <p class="f-quota" id="f-quota">${_formQuotaTexto(n)}</p>
      </div>

      <div class="f-bloco">
        <h4 class="f-sec">A garrafa</h4>
        ${campoV('nome', 'Vinho', 'text', 'placeholder="ex.: Papa Figos" autocomplete="off"')}
        <!-- A COR vai antes da procura, e o produtor depois: quem tem a garrafa
             na mão sabe sempre a cor, nem sempre o produtor — e é a cor que
             separa o "Papa Figos" tinto do branco. A procura preenche o produtor. -->
        <div class="grelha2">
          <label class="campo"><span>Cor</span><select id="fv-tipo">${TIPOS_VINHO.map(t => `<option${(v.tipo || '') === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
          ${campoV('ano', 'Colheita', 'number', 'inputmode="numeric" min="1900" max="2100"')}
        </div>
        <button class="btn procura largo" id="btn-procurar" onclick="procurarVinho()">🔎 Procurar informação do vinho</button>
        <div id="f-procura-res">${_procuraRelatorio || ''}</div>
        <div class="grelha2">
          ${campoV('produtor', 'Produtor', 'text', 'placeholder="ex.: Casa Ferreirinha"')}
          ${campoV('regiao', 'Região')}
        </div>
        ${campoV('castas', 'Castas <small>(separadas por vírgulas)</small>')}
        <div class="grelha2">
          ${campoV('preco_medio', 'Preço mercado', 'text', 'inputmode="decimal" autocomplete="off"')}
          ${campoV('vivino_nota', 'Nota Vivino', 'text', 'inputmode="decimal" autocomplete="off"')}
        </div>
        ${campoV('loja', 'Comprado em', 'text', 'placeholder="loja, site…"')}
        <details class="mais"${v.notas_prova || v.resumo || v.teor ? ' open' : ''}><summary>Mais sobre o vinho</summary>
          <div class="grelha2">${campoV('teor', 'Álcool (%)', 'text', 'inputmode="decimal" autocomplete="off"')}${campoV('estagio', 'Estágio')}</div>
          ${campoV('vivino_url', 'Link Vivino', 'url')}
          ${campoV('imagem_url', 'Link da fotografia', 'url')}
          <label class="campo"><span>Notas de prova</span><textarea id="fv-notas_prova" rows="2">${esc(v.notas_prova || '')}</textarea></label>
          <label class="campo"><span>Harmonização</span><textarea id="fv-harmonizacao" rows="2">${esc(v.harmonizacao || '')}</textarea></label>
          <label class="campo"><span>Resumo</span><textarea id="fv-resumo" rows="3">${esc(v.resumo || '')}</textarea></label>
        </details>
      </div>

      <div class="f-bloco">
        <h4 class="f-sec">Quem divide <small>(${n})</small></h4>
        <p class="sec-nota">Todos menos quem faz anos. Tira quem não entrou nesta.</p>
        <div class="chips quem">${amigos.filter(a => a.nome !== f.aniversariante && (a.ativo || f.participantes.includes(a.nome))).map(a => {
          const on = f.participantes.includes(a.nome) || a.nome === f.responsavel;
          return `<button class="chip${on ? ' on' : ''}"${a.nome === f.responsavel ? ' disabled title="Quem compra divide sempre"' : ''} onclick="lerForm();_formTogglePart('${escJs(a.nome)}')">${esc(a.nome)}</button>`;
        }).join('')}</div>
        ${folhaFormPagos()}
      </div>

      <label class="campo"><span>Notas</span><textarea id="f-notas" rows="2" placeholder="opcional">${esc(f.notas)}</textarea></label>

      <div class="f-acoes">
        ${f.id ? `<button class="btn perigo-ghost" onclick="apagarEvento(${f.id})">Apagar</button>` : ''}
        <button class="btn ghost" onclick="_procuraRelatorio='';fecharFolha()">Cancelar</button>
        <button class="btn prim" id="btn-guardar" onclick="guardarEvento()">Guardar</button>
      </div>`;
}
/* QUEM JÁ PAGOU — marca-se AQUI, no mesmo gesto de registar, e é gravado
   ANTES de sair qualquer aviso. Sobretudo nas prendas passadas: quase
   toda a gente já pagou, e não pode receber uma notificação de dívida por
   causa do intervalo entre registar e ir marcar um a um. */
function folhaFormPagos() {
    if (!_formDividir()) return '';
    const devedores = _formParticipantes().filter(p => p !== _form.responsavel);
    if (!devedores.length) return '';
    const todos = devedores.every(p => _form.pagos.includes(p));
    return `
      <h4 class="f-sec">Quem já pagou ao ${esc(_form.responsavel || '…')}? <small>(${devedores.filter(p => _form.pagos.includes(p)).length}/${devedores.length})</small></h4>
      <p class="sec-nota">Quem ficar por marcar fica a dever${diasEntre(_form.data || hoje(), hoje()) <= 45 ? ' e recebe um aviso' : ''}.</p>
      <div class="pago-atalhos">
        <button class="btn mini ghost" onclick="lerForm();_form.pagos=${todos ? '[]' : '_formParticipantes().filter(p=>p!==_form.responsavel)'};redesenharFolha()">${todos ? 'Desmarcar todos' : 'Todos já pagaram'}</button>
      </div>
      <div class="chips">${devedores.map(p => `<button class="chip pago${_form.pagos.includes(p) ? ' on' : ''}" onclick="lerForm();_formTogglePago('${escJs(p)}')">${_form.pagos.includes(p) ? '✓ ' : ''}${esc(p)}</button>`).join('')}</div>`;
}
function _formTogglePago(nome) {
    const i = _form.pagos.indexOf(nome);
    if (i >= 0) _form.pagos.splice(i, 1); else _form.pagos.push(nome);
    redesenharFolha();
}
// Quem divide, como o servidor o vai gravar: sem quem faz anos, com quem
// compra (mesmo que o chip dele tenha ficado desligado de uma troca).
function _formParticipantes() {
    return [...new Set(_form.participantes.concat(_form.responsavel ? [_form.responsavel] : []))]
        .filter(p => p && p !== _form.aniversariante);
}
function _formQuotaTexto(n) {
    const valor = _formValor();
    if (valor) {
        const div = _formDividir(), l = limitePrenda();
        let t = div > 0 ? `${eur(div)} ÷ ${n} = <b>${eur(Math.round(div / n * 100) / 100)}</b> por pessoa` : `Nada a dividir: o ${esc(_form.responsavel || '…')} fica com tudo.`;
        if (div > valor + 0.004) t += `<br><span class="aviso-lim">⚠️ Não pode passar do preço pago.</span>`;
        else if (valor - div > 0.004) t += `<br><span class="nada">Os ${eur(valor - div)} acima ficam com o ${esc(_form.responsavel || '…')}.</span>`;
        if (l && div > l + 0.004) t += `<br><span class="aviso-lim">Acima do limite de ${eur(l)} — só se o grupo concordar.</span>`;
        return t;
    }
    return _formPrecoObrigatorio() ? `A dividir por ${n}.` : `<span class="nada">Sem preço: ninguém deve nada por esta prenda.</span>`;
}
function _formAtualizarQuota() {
    const el = document.getElementById('f-quota');
    if (!el || !_form) return;
    // Aparecer/desaparecer "quem já pagou" muda a folha: redesenha só quando
    // se passa de sem-preço a com-preço (ou vice-versa), para não roubar o
    // cursor a cada tecla.
    // "A dividir" segue o preço (até ao limite) enquanto ninguém lhe mexer.
    const dv = document.getElementById('f-dividir');
    if (dv && !_formDividirManual() && document.activeElement !== dv) dv.value = _formValor() ? numTxt(_formDividirAuto()) : '';
    const temPagos = !!document.getElementById('btn-guardar') && !!document.querySelector('.pago-atalhos');
    if (!!_formDividir() !== temPagos) {
        redesenharFolha();
        const inp = document.getElementById('f-valor');
        if (inp && document.activeElement !== dv) { inp.focus(); const l = inp.value.length; try { inp.setSelectionRange(l, l); } catch (e) {} }
        return;
    }
    el.innerHTML = _formQuotaTexto(Math.max(1, _formParticipantes().length));
}
function _formMudouAniv() {
    // Mudou quem faz anos: o ciclo volta a propor quem compra, e quem faz
    // anos sai de quem divide.
    const r = responsavelPor(_form.aniversariante);
    if (r) _form.responsavel = r;
    _form.participantes = _form.participantes.filter(p => p !== _form.aniversariante);
    redesenharFolha();
}
function _formTogglePart(nome) {
    const i = _form.participantes.indexOf(nome);
    if (i >= 0) _form.participantes.splice(i, 1); else _form.participantes.push(nome);
    redesenharFolha();
}
async function guardarEvento() {
    lerForm();
    const f = _form;
    if (!f.aniversariante || !f.responsavel) { toast('Falta quem faz anos ou quem compra', false); return; }
    if (!f.data) { toast('Falta a data', false); return; }
    const valor = String(f.valor).trim() === '' ? null : lerNum(f.valor);
    if (valor !== null && !(valor >= 0)) { toast('Preço inválido', false); return; }
    const dividir = valor > 0 ? Math.round(_formDividir() * 100) / 100 : null;
    if (dividir !== null && dividir > valor + 0.004) { toast('O valor a dividir não pode passar do preço pago', false); return; }
    if (f.vinho.nome && !f.vinho.origem) f.vinho.origem = 'manual';
    const btn = document.getElementById('btn-guardar');
    btn.disabled = true; btn.textContent = 'A guardar…';
    try {
        const r = await rpc('guardar_evento', {
            p_id: f.id, p_aniversariante: f.aniversariante, p_data: f.data, p_responsavel: f.responsavel,
            p_participantes: _formParticipantes(), p_estado: f.estado, p_valor: valor, p_vinho: f.vinho, p_notas: f.notas,
            p_valor_dividir: dividir
        });
        // Quem já pagou, gravado ANTES do aviso: só as mudanças. Com o preço
        // alterado, quem estava marcado é marcado outra vez (acerta o saldo).
        if (dividir > 0) {
            const devedores = (r.participantes || []).filter(p => p !== r.responsavel);
            for (const p of devedores) {
                const quer = f.pagos.includes(p), tinha = f.pagosAntes.includes(p);
                if (quer && (!tinha || r.valor_mudou)) await rpc('marcar_pago', { p_evento: r.id, p_devedor: p, p_pago: true });
                else if (!quer && tinha) await rpc('marcar_pago', { p_evento: r.id, p_devedor: p, p_pago: false });
            }
        }
        _procuraRelatorio = '';
        await carregarDados();
        fecharFolha();
        if (!f.id) { fecharTodasFolhas(); abrirEvento(r.id); }
        renderTudo();
        toast('✓ Prenda guardada');
        // Preço novo = dívidas novas → avisar quem AINDA deve (a função só
        // avisa saldos > 0, e quem já pagou acabou de ficar a zero). Só para
        // prendas recentes: registar o histórico não acorda ninguém.
        if (r.valor_mudou && diasEntre(r.data, hoje()) <= 45) {
            edgeFn('prendas-notificar', { tipo: 'divida', evento_id: r.id }).catch(() => {});
        }
    } catch (e) {
        toast('⚠️ ' + e.message, false);
        btn.disabled = false; btn.textContent = 'Guardar';
    }
}
async function apagarEvento(id) {
    const ev = eventoPorId(id);
    if (!ev) return;
    const pgs = pagamentosDoEvento(id).length;
    const ok = await confirmar('Apagar esta prenda?',
        `A prenda do <b>${esc(ev.aniversariante)}</b> (${fmtData(ev.data)})${pgs ? ` e os seus <b>${pgs} pagamento${pgs === 1 ? '' : 's'}</b>` : ''} desaparecem de vez.`, 'Apagar', true);
    if (!ok) return;
    try {
        await rpc('apagar_evento', { p_id: id });
        await carregarDados();
        fecharTodasFolhas();
        renderTudo();
        toast('Prenda apagada');
    } catch (e) { toast('⚠️ ' + e.message, false); }
}

/* ── O VINHO: procurar informação ───────────────────────────────────────
   Dois degraus, do mais barato para o mais caro:
     1. o CATÁLOGO comum (`winecatalog.comparar` — grátis, aberto a qualquer
        sessão): o que a Garrafeira e a WineSelection já descobriram;
     2. só se o catálogo não souber: uma pesquisa Google a sério pela Edge
        Function `prendas-vinho` (~€0.01 e 20–60 s).
   Nenhum dos dois ESCREVE por cima do que já está no formulário: só
   preenche o que está vazio. Quem tem a garrafa na mão sabe melhor. */
let _procuraRelatorio = '';
// Os nomes de campo do catálogo → os desta app.
const MAPA_CATALOGO = {
    tipo: 'tipo', regiao: 'regiao', pais: 'pais', castas: 'castas', teor: 'teor', estagio_texto: 'estagio',
    vivino_nota: 'vivino_nota', vivino_url: 'vivino_url', imagem_url: 'imagem_url', preco_medio: 'preco_medio',
    notas_prova: 'notas_prova', harmonizacao: 'harmonizacao', ai_resumo: 'resumo'
};
const ROTULOS = {
    produtor: 'produtor', tipo: 'cor', regiao: 'região', pais: 'país', castas: 'castas', teor: 'álcool', estagio: 'estágio',
    vivino_nota: 'nota Vivino', vivino_url: 'link Vivino', imagem_url: 'fotografia', preco_medio: 'preço de mercado',
    notas_prova: 'notas de prova', harmonizacao: 'harmonização', resumo: 'resumo'
};
function _preencherVazios(ficha) {
    const entrou = [];
    Object.keys(ficha).forEach(k => {
        const val = ficha[k];
        if (val == null || val === '' || (Array.isArray(val) && !val.length)) return;
        const atual = _form.vinho[k];
        if (atual != null && atual !== '' && !(Array.isArray(atual) && !atual.length)) return;
        _form.vinho[k] = val;
        entrou.push(ROTULOS[k] || k);
    });
    return entrou;
}
async function procurarVinho() {
    lerForm();
    const v = _form.vinho;
    if (!v.nome) { toast('Escreve primeiro o nome do vinho', false); return; }
    const btn = document.getElementById('btn-procurar');
    btn.disabled = true; btn.textContent = '📚 A perguntar ao catálogo…';
    let doCatalogo = [];
    try {
        const r = await rpc('comparar', { p_nome: v.nome, p_produtor: v.produtor || '', p_ano: v.ano || null, p_ficha: {} }, 'winecatalog');
        // O catálogo ainda não separa a cor na chave (é a "mudança da cor na
        // chave", decidida e por fazer na WineCatalog): pedir "Papa Figos"
        // pode trazer o tinto quando a garrafa é o branco. Com a cor escolhida
        // e diferente da do catálogo, não se copia nada — é outro vinho.
        const corCat = r && r.encontrado ? ((r.campos || []).find(c => c.campo === 'tipo') || {}).catalogo : null;
        if (r && r.encontrado && v.tipo && corCat && String(corCat).toLowerCase() !== String(v.tipo).toLowerCase()) {
            _procuraRelatorio = `<div class="relatorio">📚 O catálogo tem um <b>${esc(r.nome)}</b>, mas <b>${esc(corCat)}</b> — e esta garrafa é <b>${esc(v.tipo)}</b>. Não copiei nada: deve ser outro vinho.</div>`;
        } else if (r && r.encontrado) {
            const ficha = {};
            (r.campos || []).forEach(c => { const k = MAPA_CATALOGO[c.campo]; if (k) ficha[k] = c.catalogo; });
            if (!v.produtor && r.produtor) ficha.produtor = r.produtor;
            doCatalogo = _preencherVazios(ficha);
            _form.vinho.catalogo_id = r.id;
            if (doCatalogo.length) _form.vinho.origem = 'catalogo';
            _procuraRelatorio = `<div class="relatorio ok">📚 Encontrado no catálogo: <b>${esc(r.nome)}${r.ano ? ' ' + r.ano : ''}</b>${r.produtor ? ' · ' + esc(r.produtor) : ''}${r.mesmaColheita === false && v.ano ? ` <small>(outra colheita — os dados estáveis servem, a nota pode não servir)</small>` : ''}.<br>${doCatalogo.length ? 'Preenchi: ' + doCatalogo.join(', ') + '.' : 'Não havia nada novo para os campos vazios.'}</div>`;
        } else {
            _procuraRelatorio = `<div class="relatorio">📚 O catálogo ainda não conhece este vinho.</div>`;
        }
    } catch (e) {
        _procuraRelatorio = `<div class="relatorio">📚 Não consegui perguntar ao catálogo (${esc(e.message)}).</div>`;
    }
    // Poucos campos do catálogo → oferecer a pesquisa a sério.
    if (doCatalogo.length < 4) {
        _procuraRelatorio += `<button class="btn ghost largo" id="btn-pesquisar" onclick="pesquisarVinhoInternet()">🌐 Pesquisar na internet <small>(~30 s)</small></button>`;
    }
    redesenharFolha();
}
async function pesquisarVinhoInternet() {
    lerForm();
    const v = _form.vinho;
    const btn = document.getElementById('btn-pesquisar');
    if (btn) { btn.disabled = true; btn.innerHTML = '🌐 A pesquisar… <small>pode levar um minuto</small>'; }
    try {
        const r = await edgeFn('prendas-vinho', { nome: v.nome, produtor: v.produtor || '', ano: v.ano || null, tipo: v.tipo || '' }, 110000);
        if (!_form) return;
        if (!r.encontrado) {
            _procuraRelatorio = `<div class="relatorio">🌐 A pesquisa não encontrou este vinho${r.aviso ? ': ' + esc(r.aviso) : '.'} Confirma o nome e o produtor.</div>`;
        } else {
            const entrou = _preencherVazios(r.ficha || {});
            if (entrou.length) {
                _form.vinho.origem = _form.vinho.origem === 'catalogo' ? 'catalogo' : 'pesquisa';
                _form.vinho.fontes = r.fontes || [];
            }
            _procuraRelatorio = `<div class="relatorio ok">🌐 ${entrou.length ? 'Preenchi: ' + entrou.join(', ') + '.' : 'Nada de novo para os campos vazios.'}${r.aviso ? `<br><small>⚠️ ${esc(r.aviso)}</small>` : ''}${(r.fontes || []).length ? '' : '<br><small>Sem fontes citadas — confirma antes de acreditar.</small>'}</div>`;
        }
    } catch (e) {
        _procuraRelatorio = `<div class="relatorio erro">🌐 ${esc(e.name === 'AbortError' ? 'A pesquisa demorou demasiado — tenta outra vez.' : e.message)}</div>`;
    }
    redesenharFolha();
}

/* ── O VINHO: atualizar do catálogo ─────────────────────────────────────
   A ficha da prenda é uma CÓPIA tirada no "Procurar informação" — o que se
   muda depois no catálogo (uma imagem nova, uma nota) não chega cá sozinho.
   Isto é o caminho de volta, e é à mão de propósito: mostra só o que o
   catálogo tem DE DIFERENTE (a própria `winecatalog.comparar` faz a
   comparação, com a ficha da prenda como "a minha") e quem gere a prenda
   escolhe o que trazer. Nada muda sem confirmar — a mesma regra do
   "Procurar": quem tem a garrafa na mão pode saber melhor. */
let _cat = null;
async function atualizarDoCatalogo(id) {
    const ev = eventoPorId(id);
    if (!ev) return;
    const v = ev.vinho || {};
    // A ficha da prenda, com os nomes de campo do catálogo.
    const minha = {};
    Object.entries(MAPA_CATALOGO).forEach(([kc, km]) => { if (v[km] != null && v[km] !== '') minha[kc] = v[km]; });
    const btn = document.getElementById('btn-cat-' + id);
    if (btn) { btn.disabled = true; btn.textContent = '📚 A comparar com o catálogo…'; }
    try {
        const r = await rpc('comparar', { p_nome: v.nome, p_produtor: v.produtor || '', p_ano: v.ano || null, p_ficha: minha }, 'winecatalog');
        if (!r || !r.encontrado) { toast('O catálogo não conhece este vinho', false); return; }
        const linhas = (r.campos || [])
            .filter(c => MAPA_CATALOGO[c.campo] && c.catalogo != null && c.catalogo !== '')
            .map(c => ({ k: MAPA_CATALOGO[c.campo], atual: v[MAPA_CATALOGO[c.campo]], novo: c.catalogo, sel: true }));
        if (!linhas.length) { toast('✓ A prenda já está igual ao catálogo'); return; }
        _cat = { id, catId: r.id, colheita: r.mesmaColheita === false ? r.ano : null, linhas };
        abrirFolha(folhaCatalogo);
    } catch (e) {
        toast('⚠️ ' + e.message, false);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Atualizar do catálogo'; }
    }
}
function _catValor(k, x) {
    if (x == null || x === '' || (Array.isArray(x) && !x.length)) return '<i class="cat-vazio">vazio</i>';
    if (k === 'imagem_url') return `<img class="cat-img" src="${esc(x)}" alt="" onerror="this.replaceWith(document.createTextNode('(imagem não abre)'))">`;
    if (k === 'vivino_url') return `<a href="${esc(x)}" target="_blank" rel="noopener">link</a>`;
    if (k === 'preco_medio') return eur(x);
    if (Array.isArray(x)) return esc(x.join(', '));
    const t = String(x);
    return esc(t.length > 140 ? t.slice(0, 140) + '…' : t);
}
function folhaCatalogo() {
    const c = _cat;
    const n = c.linhas.filter(l => l.sel).length;
    return `
      <h3 class="f-tit">Atualizar do catálogo</h3>
      <p class="f-texto">O catálogo tem ${c.linhas.length} campo${c.linhas.length === 1 ? '' : 's'} diferente${c.linhas.length === 1 ? '' : 's'} desta prenda. Escolhe o que trazer.${c.colheita ? ` <small>(o catálogo tem a colheita ${c.colheita} — os dados da garrafa servem, a nota pode não servir)</small>` : ''}</p>
      <div class="lista">${c.linhas.map((l, i) => `
        <button class="cartao cat-linha${l.sel ? ' on' : ''}" onclick="_cat.linhas[${i}].sel=!_cat.linhas[${i}].sel;redesenharFolha()">
          <span class="cat-check">${l.sel ? '✓' : ''}</span>
          <span class="cat-txt"><b>${esc(ROTULOS[l.k] || l.k)}</b>
            <span class="cat-par"><span class="cat-lado"><small>agora</small>${_catValor(l.k, l.atual)}</span><span class="cat-seta">→</span><span class="cat-lado"><small>catálogo</small>${_catValor(l.k, l.novo)}</span></span>
          </span>
        </button>`).join('')}</div>
      <div class="f-acoes">
        <button class="btn ghost" onclick="fecharFolha()">Cancelar</button>
        <button class="btn prim" id="btn-cat-aplicar" onclick="aplicarDoCatalogo()"${n ? '' : ' disabled'}>Trazer ${n}</button>
      </div>`;
}
async function aplicarDoCatalogo() {
    const c = _cat, ev = eventoPorId(c && c.id);
    if (!ev) return;
    const vinho = JSON.parse(JSON.stringify(ev.vinho || {}));
    c.linhas.filter(l => l.sel).forEach(l => { vinho[l.k] = l.novo; });
    vinho.catalogo_id = c.catId;
    const btn = document.getElementById('btn-cat-aplicar');
    btn.disabled = true; btn.textContent = 'A guardar…';
    try {
        await rpc('guardar_evento', {
            p_id: ev.id, p_aniversariante: ev.aniversariante, p_data: ev.data, p_responsavel: ev.responsavel,
            p_participantes: ev.participantes, p_estado: ev.estado, p_valor: ev.valor, p_vinho: vinho, p_notas: ev.notas,
            p_valor_dividir: ev.valor_dividir
        });
        await carregarDados();
        _cat = null;
        fecharFolha();
        renderTudo();
        toast('✓ Ficha atualizada');
    } catch (e) {
        toast('⚠️ ' + e.message, false);
        btn.disabled = false; btn.textContent = 'Trazer';
    }
}

/* ── PAGAMENTOS ─────────────────────────────────────────────────────────
   O fluxo do SplitBill: quem deve DECLARA "já paguei", quem recebeu ACEITA
   ou RECUSA (e é avisado, e avisa). Quem recebeu também pode registar
   "recebi" diretamente. As regras vivem nas funções do servidor; aqui só
   se pergunta o valor e se avisa. */
async function declararPagamento(eventoId) {
    const d = dividas.find(x => x.evento_id === eventoId && x.devedor === AC.eu);
    const ev = eventoPorId(eventoId);
    if (!d || !ev) return;
    const v = await pedirValor('Já paguei', `A tua parte da prenda do <b>${esc(ev.aniversariante)}</b>. O ${esc(ev.responsavel)} recebe um aviso para confirmar.`, d.saldo, 'Declarar');
    if (v == null) return;
    try {
        const id = await rpc('declarar_pagamento', { p_evento: eventoId, p_valor: v });
        edgeFn('prendas-notificar', { tipo: 'pagamento_declarado', pagamento_id: id }).catch(() => {});
        await recarregar();
        toast('✓ Declarado — falta o ' + ev.responsavel + ' confirmar');
    } catch (e) { toast('⚠️ ' + e.message, false); }
}
async function registarRecebido(eventoId, devedor) {
    const d = dividas.find(x => x.evento_id === eventoId && x.devedor === devedor);
    const v = await pedirValor('Recebi', `Quanto é que o <b>${esc(devedor)}</b> te pagou?`, d ? d.saldo : null, 'Registar');
    if (v == null) return;
    try {
        await rpc('registar_recebido', { p_evento: eventoId, p_devedor: devedor, p_valor: v });
        await recarregar();
        toast('✓ Registado');
    } catch (e) { toast('⚠️ ' + e.message, false); }
}
async function resolverPagamento(id, aceitar) {
    const p = pagamentos.find(x => x.id === id);
    if (!p) return;
    if (!aceitar) {
        const ok = await confirmar('Recusar pagamento?', `O <b>${esc(p.devedor)}</b> diz que te pagou <b>${eur(p.valor)}</b>. Recusar volta a pôr a dívida em aberto e avisa-o.`, 'Recusar', true);
        if (!ok) return;
    }
    try {
        await rpc('resolver_pagamento', { p_id: id, p_aceitar: aceitar });
        edgeFn('prendas-notificar', { tipo: 'pagamento_resolvido', pagamento_id: id }).catch(() => {});
        await recarregar();
        toast(aceitar ? '✓ Pagamento aceite' : 'Pagamento recusado');
    } catch (e) { toast('⚠️ ' + e.message, false); }
}
async function anularPagamento(id) {
    const p = pagamentos.find(x => x.id === id);
    if (!p) return;
    const ok = await confirmar('Anular pagamento?', `${esc(p.devedor)} · ${eur(p.valor)} (${p.estado}). ${p.estado === 'confirmado' ? 'A dívida volta a ficar em aberto.' : ''}`, 'Anular', true);
    if (!ok) return;
    try {
        await rpc('anular_pagamento', { p_id: id });
        await recarregar();
        toast('Pagamento anulado');
    } catch (e) { toast('⚠️ ' + e.message, false); }
}
async function lembrar(eventoId, devedor) {
    const ok = await confirmar('Enviar lembrete?', `Mandar uma notificação ao <b>${esc(devedor)}</b> a lembrar a parte dele?`, 'Enviar');
    if (!ok) return;
    try {
        const r = await edgeFn('prendas-notificar', { tipo: 'lembrete', evento_id: eventoId, devedor });
        toast(r && r.enviados > 0 ? '✓ Lembrete enviado' : `⚠️ O ${devedor} ainda não ativou as notificações`, !!(r && r.enviados > 0));
    } catch (e) { toast('⚠️ ' + e.message, false); }
}

/* ── DEFINIÇÕES ─────────────────────────────────────────────────────────── */
let _pedidosAcesso = [];
async function renderDefinicoes() {
    const el = document.getElementById('pg-definicoes');
    let html = `
      <div class="cartao">
        <div class="conta">${avatar(AC.eu || AC.email, true)}<div><b>${esc(AC.eu || '—')}</b><small>${esc(AC.email)}${AC.admin ? ' · admin' : ''}</small></div></div>
        <div class="push-box" id="push-box"></div>
        <button class="btn ghost largo" onclick="sbLogout()">Sair</button>
      </div>`;
    if (AC.admin) {
        html += `<h2 class="sec">Amigos</h2>
          <p class="sec-nota">Ter email aqui É o acesso à app. Sem data de anos, o amigo fica fora do ciclo.</p>
          <div class="cartao tabela">` + amigos.map(a => `
            <button class="tb-l tb-btn" onclick="editarAmigo('${escJs(a.nome)}')">${avatar(a.nome)}
              <span class="tb-n">${esc(a.nome)}${a.ativo ? '' : ' <small>(inativo)</small>'}<small>${a.email ? esc(a.email) : '<i>sem conta ligada</i>'}</small></span>
              <span class="tb-v">${a.dia ? a.dia + ' ' + MESES[a.mes - 1] : '<i>sem data</i>'}</span></button>`).join('') + `</div>
          <button class="btn ghost largo" onclick="editarAmigo(null)">+ Amigo</button>

          <h2 class="sec">Limite por prenda</h2>
          <p class="sec-nota">O que se divide no máximo. Quem gastar mais fica com o excedente (a app propõe; quem regista pode mudar).</p>
          <div class="cartao linha-form"><input type="text" inputmode="decimal" autocomplete="off" id="cfg-limite" placeholder="sem limite" value="${numTxt(limitePrenda())}"><button class="btn prim" onclick="guardarConfig('limite_prenda', lerNum(document.getElementById('cfg-limite').value) || 0)">Guardar</button></div>

          <h2 class="sec">Desde quando</h2>
          <p class="sec-nota">A partir desta data a app propõe registar as prendas dos aniversários que já passaram.</p>
          <div class="cartao linha-form"><input type="date" id="cfg-inicio" value="${esc(inicioGrupo())}"><button class="btn prim" onclick="guardarInicio()">Guardar</button></div>
          <div id="pedidos-acesso"></div>`;
    }
    el.innerHTML = html;
    pushRenderStatus();
    if (AC.admin) carregarPedidosAcesso();
}
async function carregarPedidosAcesso() {
    try { _pedidosAcesso = await sbGet('access_requests?select=*&order=requested_at.desc'); } catch (e) { _pedidosAcesso = []; }
    const el = document.getElementById('pedidos-acesso');
    if (!el || !_pedidosAcesso.length) return;
    const semConta = amigos.filter(a => !a.email);
    el.innerHTML = `<h2 class="sec">Pedidos de acesso</h2><div class="lista">` + _pedidosAcesso.map((p, i) => `
      <div class="cartao">
        <b>${esc(p.email)}</b><small class="bloco">${fmtData(String(p.requested_at).slice(0, 10))}</small>
        <div class="linha-form"><select id="pa-${i}"><option value="">É o…</option>${amigos.map(a => `<option>${esc(a.nome)}</option>`).join('')}</select>
        <button class="btn prim" onclick="ligarPedido(${i})">Ligar</button><button class="btn ghost" onclick="ignorarPedido(${i})">Ignorar</button></div>
        ${semConta.length ? '' : '<small class="bloco">Todos os amigos já têm conta — acrescenta um amigo novo primeiro.</small>'}
      </div>`).join('') + `</div>`;
}
async function ligarPedido(i) {
    const p = _pedidosAcesso[i], nome = document.getElementById('pa-' + i).value;
    if (!p || !nome) { toast('Escolhe o amigo', false); return; }
    const a = amigo(nome);
    if (a && a.email && !(await confirmar('Trocar a conta?', `O ${esc(nome)} já está ligado a <b>${esc(a.email)}</b>. Passa a ser <b>${esc(p.email)}</b>.`, 'Trocar'))) return;
    try { await rpc('ligar_email', { p_nome: nome, p_email: p.email }); await recarregar(); toast('✓ ' + nome + ' tem acesso'); }
    catch (e) { toast('⚠️ ' + e.message, false); }
}
async function ignorarPedido(i) {
    const p = _pedidosAcesso[i];
    try { await sbReq('DELETE', 'access_requests?email=eq.' + encodeURIComponent(p.email)); renderDefinicoes(); }
    catch (e) { toast('⚠️ ' + e.message, false); }
}
async function guardarInicio() {
    const v = document.getElementById('cfg-inicio').value;
    if (v) guardarConfig('inicio', v);
}
async function guardarConfig(chave, valor) {
    try {
        await sbReq('POST', 'config', { chave, valor, atualizado_em: new Date().toISOString() }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
        await recarregar();
        toast('✓ Guardado');
    } catch (e) { toast('⚠️ ' + e.message, false); }
}
function editarAmigo(nome) {
    const a = nome ? amigo(nome) : null;
    // O ano do <input type=date> não quer dizer nada: guardam-se só o dia e o
    // mês. 2000 é bissexto, para o 29 de fevereiro caber.
    const dataIso = a && a.dia ? isoDe(2000, a.mes, a.dia) : '';
    abrirFolha(() => `
      <h3 class="f-tit">${a ? esc(a.nome) : 'Amigo novo'}</h3>
      ${a ? '' : `<label class="campo"><span>Nome</span><input id="am-nome" type="text" placeholder="como aparece nas prendas"></label>`}
      <label class="campo"><span>Email da conta</span><input id="am-email" type="email" value="${esc(a && a.email || '')}" placeholder="o do login (Google)"></label>
      <label class="campo"><span>Dia de anos <small>(o ano não conta)</small></span><input id="am-data" type="date" value="${dataIso}"></label>
      <label class="campo check"><input id="am-ativo" type="checkbox"${!a || a.ativo ? ' checked' : ''}> <span>Faz parte do grupo (entra no ciclo e nas divisões novas)</span></label>
      <div class="f-acoes">
        ${a ? `<button class="btn perigo-ghost" onclick="apagarAmigo('${escJs(a.nome)}')">Apagar</button>` : ''}
        <button class="btn ghost" onclick="fecharFolha()">Cancelar</button>
        <button class="btn prim" onclick="guardarAmigo(${a ? `'${escJs(a.nome)}'` : 'null'})">Guardar</button>
      </div>`);
}
async function guardarAmigo(nome) {
    const novo = !nome;
    const n = novo ? document.getElementById('am-nome').value.trim() : nome;
    if (!n) { toast('Falta o nome', false); return; }
    const email = document.getElementById('am-email').value.trim().toLowerCase() || null;
    const d = document.getElementById('am-data').value;
    const [, m, dia] = d ? d.split('-').map(Number) : [null, null, null];
    const corpo = { email, dia: d ? dia : null, mes: d ? m : null, ativo: document.getElementById('am-ativo').checked };
    try {
        if (novo) await sbReq('POST', 'amigos', Object.assign({ nome: n }, corpo));
        else await sbReq('PATCH', 'amigos?nome=eq.' + encodeURIComponent(n), corpo);
        await recarregar();
        fecharFolha();
        renderDefinicoes();
        toast('✓ ' + n + ' guardado');
    } catch (e) {
        toast('⚠️ ' + (/duplicate|unique/i.test(e.message) ? 'Esse nome ou email já existe.' : e.message), false);
    }
}
async function apagarAmigo(nome) {
    const ok = await confirmar('Apagar ' + nome + '?', 'Só dá para apagar quem nunca entrou numa prenda. Para quem saiu do grupo, desmarca "Faz parte do grupo".', 'Apagar', true);
    if (!ok) return;
    try {
        await sbReq('DELETE', 'amigos?nome=eq.' + encodeURIComponent(nome));
        await recarregar(); fecharFolha(); renderDefinicoes();
        toast(nome + ' apagado');
    } catch (e) {
        toast('⚠️ ' + (/foreign key|violates/i.test(e.message) ? nome + ' já tem prendas — desmarca "Faz parte do grupo" em vez de apagar.' : e.message), false);
    }
}

/* ── NOTIFICAÇÕES PUSH ──────────────────────────────────────────────────
   Ativadas por conta+dispositivo. Quem manda é a Edge Function
   `prendas-notificar`, que escolhe o texto e lê os valores da BD — daqui só
   sai "de que evento/pagamento se trata". */
function pushSuportado() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function _b64ToU8(s) {
    const p = '='.repeat((4 - s.length % 4) % 4);
    const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function pushSubAtual() {
    if (!pushSuportado()) return null;
    try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch (e) { return null; }
}
async function pushRenderStatus() {
    const box = document.getElementById('push-box');
    if (!box) return;
    if (!pushSuportado()) { box.innerHTML = `<small>Este browser não suporta notificações. No iPhone, instala a app no ecrã principal primeiro.</small>`; return; }
    const ativo = !!(await pushSubAtual());
    box.innerHTML = `<button class="btn ${ativo ? 'ghost' : 'prim'} largo" onclick="${ativo ? 'pushDesativar()' : 'pushAtivar()'}">${ativo ? '🔕 Desativar notificações' : '🔔 Ativar notificações'}</button>
      <small>${ativo ? 'Ativas neste dispositivo.' : 'Para saberes quando te pagam, quando deves, e quando alguém confirma.'}</small>`;
}
async function pushAtivar() {
    try {
        if (await Notification.requestPermission() !== 'granted') { toast('Permissão recusada', false); return; }
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _b64ToU8(VAPID_PUBLIC_KEY) });
        const j = sub.toJSON();
        await sbReq('POST', 'push_subscriptions', { endpoint: sub.endpoint, email: AC.email, p256dh: j.keys.p256dh, auth_key: j.keys.auth },
            { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
        toast('✓ Notificações ativadas');
    } catch (e) { toast('⚠️ ' + e.message, false); }
    pushRenderStatus();
}
async function pushDesativar() {
    try {
        const sub = await pushSubAtual();
        if (sub) {
            await sbReq('DELETE', 'push_subscriptions?endpoint=eq.' + encodeURIComponent(sub.endpoint)).catch(() => {});
            await sub.unsubscribe();
        }
        toast('Notificações desativadas');
    } catch (e) { toast('⚠️ ' + e.message, false); }
    pushRenderStatus();
}
// Se a permissão já foi dada (noutra altura), volta a subscrever sem
// perguntar nada — um telemóvel novo da mesma pessoa não fica mudo.
async function pushReativarSilencioso() {
    if (!pushSuportado() || Notification.permission !== 'granted') return;
    if (!(await pushSubAtual())) pushAtivar();
}

/* ── AUTH (Supabase) ────────────────────────────────────────────────────── */
function sbLoginGoogle() {
    window.location.href = `${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(window.location.href.split('#')[0])}`;
}
async function sbLoginEmail() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const st = document.getElementById('login-status');
    st.textContent = 'A entrar…'; st.className = 'auth-status on';
    try {
        const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const d = await r.json();
        if (!r.ok) { st.textContent = d.error_description || d.msg || 'Erro ao entrar.'; st.className = 'auth-status on erro'; return; }
        sbSaveSession({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: d.user });
        await sbAposLogin();
    } catch (e) { st.textContent = 'Erro de ligação.'; st.className = 'auth-status on erro'; }
}
function sbLogout() {
    _sbSession = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    location.reload();
}
function mostrarEcra(id) {
    ['page-login', 'page-sem-acesso'].forEach(p => { document.getElementById(p).style.display = p === id ? 'flex' : 'none'; });
    document.getElementById('app').hidden = id !== 'app';
    if (window.pgEsconderSplash) window.pgEsconderSplash();
}
async function sbInit() {
    // Regresso do login Google: o token vem no hash.
    const hash = window.location.hash;
    if (hash.includes('access_token')) {
        const p = new URLSearchParams(hash.substring(1));
        const at = p.get('access_token');
        if (at) {
            const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${at}` } });
            if (r.ok) {
                sbSaveSession({
                    access_token: at, refresh_token: p.get('refresh_token'),
                    expires_at: parseInt(p.get('expires_at')) || Math.floor(Date.now() / 1000) + (parseInt(p.get('expires_in')) || 3600),
                    user: await r.json()
                });
                history.replaceState({}, document.title, location.pathname);
                return sbAposLogin();
            }
        }
    }
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
    if (s) {
        _sbSession = s;
        if (tokenQuaseExpirado()) await sbRefresh();
        let r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${_sbSession.access_token}` } }).catch(() => null);
        if (r && !r.ok && await sbRefresh())
            r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${_sbSession.access_token}` } }).catch(() => null);
        if (r && r.ok) { sbSaveSession({ ..._sbSession, user: await r.json() }); return sbAposLogin(); }
        // Sem rede: entra com a sessão guardada em vez de pedir login.
        if (!r) return sbAposLogin();
        _sbSession = null;
        try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    }
    mostrarEcra('page-login');
}
async function sbAposLogin() {
    try {
        AC = await rpc('acesso');
    } catch (e) {
        mostrarEcra('page-sem-acesso');
        document.getElementById('sem-acesso-email').innerHTML = `Sessão iniciada como ${esc(_sbSession?.user?.email || '')}.<br><small>${esc(e.message)}</small>`;
        return;
    }
    if (!AC || !AC.permitido) {
        mostrarEcra('page-sem-acesso');
        document.getElementById('sem-acesso-email').textContent = `Sessão iniciada como ${_sbSession?.user?.email || ''}. Esta conta ainda não está ligada a nenhum amigo.`;
        return;
    }
    try { await carregarDados(); } catch (e) { toast('⚠️ ' + e.message, false); }
    mostrarEcra('app');
    irPara('inicio');
    renderTudo();
    pushReativarSilencioso();
}
async function sbSolicitarAcesso() {
    const btn = document.getElementById('btn-solicitar');
    const st = document.getElementById('solicitar-status');
    btn.disabled = true;
    try {
        const r = await sbFetch(`${SB_URL}/rest/v1/access_requests`, {
            method: 'POST', headers: sbHeaders({ 'Prefer': 'return=minimal' }),
            body: JSON.stringify({ email: String(_sbSession.user.email).toLowerCase() })
        });
        if (r.ok || r.status === 409) {
            st.textContent = r.status === 409 ? '✓ O pedido já lá estava. Aguarda.' : '✓ Pedido enviado. Aguarda.';
            st.className = 'auth-status on ok';
            if (r.ok) edgeFn('prendas-notificar', { tipo: 'pedido_acesso' }).catch(() => {});
            return;
        }
        throw await _sbErro(r);
    } catch (e) {
        st.textContent = 'Erro: ' + e.message; st.className = 'auth-status on erro';
        btn.disabled = false;
    }
}

/* ── INIT ───────────────────────────────────────────────────────────────── */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && _folhas.length) fecharFolha(); });
sbInit();
