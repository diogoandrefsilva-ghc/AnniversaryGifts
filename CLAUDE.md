# AnniversaryGifts (Prendas de Anos) — guia para o assistente

App pessoal: as prendas de anos do grupo de amigos, que são sempre **uma
garrafa de vinho**. **Sem build, sem npm, sem dependências.** Site estático
(GitHub Pages, caminho `/AnniversaryGifts/`), PWA. Dados e login em
**Supabase** — o mesmo projeto das outras apps (`gjweqwfbnkgnibhajldc`),
schema **`anniversarygifts`**.

## A regra do grupo (é isto que a app modela)
1. Cada amigo tem um dia de anos. Ordenados pelo calendário formam um
   **ciclo**.
2. Quem faz anos **imediatamente antes** compra e escolhe a garrafa para o
   seguinte (o primeiro do ano recebe do último).
3. Quem compra **divide o custo com todos os outros, menos quem faz anos**
   (quem compra paga a sua parte, como os outros).
4. Pagamentos à SplitBill: quem deve **declara** "já paguei", quem recebeu
   **aceita ou recusa**; há avisos push em cada passo.
5. **As dívidas são públicas** dentro do grupo — toda a gente vê tudo.
6. A garrafa tem **ficha**: primeiro o catálogo comum (WineCatalog), depois,
   se preciso, uma pesquisa na internet.
7. O grupo já fazia isto antes da app: há **prendas passadas** a registar.

## Ficheiros
- `index.html` — só markup: splash, login, "sem acesso", a app (4 separadores
  + Definições) e UMA folha (bottom sheet) genérica.
- `app.js` — toda a lógica. Secções (`grep` pelo título `/* ── `):
  Sessão Supabase · Escapes & formatos · Toast · **Folhas** · **Dados** ·
  **O ciclo** · Permissões · Navegação · Bocados reutilizados · Ecrã inicial ·
  Prendas · **Dívidas** · Ciclo · **A prenda (ver)** · **A prenda
  (registar/editar)** · **O vinho: procurar informação** · **Pagamentos** ·
  Definições · Notificações push · Auth · Init.
- `style.css` — todo o CSS. Paleta de **festa** (violeta `--pri`, coral,
  amarelo `--sol`) e fonte Nunito — **de propósito longe do bordô/dourado**
  das apps de vinhos: já havia várias assim, e o dono quis variar. Não
  voltar a puxar isto para o estilo da Garrafeira.
- `sw.js` — service worker (cache + push). **Sobe `CACHE_NAME`** sempre que
  mexeres em `app.js`, `style.css` ou `index.html`.
- `db/schema.sql` — o schema inteiro, idempotente. `db/seed-amigos.sql` —
  primeira lista de amigos, copiada de `splitbill.amigo_users`.
- `prendas-notificar.ts`, `prendas-vinho.ts` — Edge Functions (Deno). **Não
  correm no site**: `supabase functions deploy <nome>`.
- `icone-original.png` / `icone-transparente.png` — o ícone (garrafa +
  prenda), escolhido pelo dono, nas duas versões que ele deu. São as FONTES:
  `icon-512.png` e `apple-touch-icon.png` (ícone da app, precisa de fundo)
  saem do original, recortado ao miolo sem a moldura clara (quadrado de
  1040 px centrado em 627,625); `logo.png` (cabeçalho, separador Prendas,
  splash, login) sai do transparente, aparado ao desenho. Tudo num canvas
  do Chromium — ícone novo = refazer a partir das fontes, não à mão.
- **Cada `<img>` leva `width`/`height` no próprio HTML, e o CSS/JS vão com
  `?v=N` no link.** Já aconteceu: o iPhone apanhou o `index.html` novo com o
  `style.css` antigo (o CDN do GitHub Pages guarda ~10 min) e os logos
  saíram no tamanho natural, a ocupar meio ecrã. Mexeste em `style.css` ou
  `app.js`? Sobe o `?v=` no `index.html` e o `CACHE_NAME` no `sw.js`.

## Decisões que seguram o resto
- **Uma só fonte de cêntimos: a view `anniversarygifts.dividas`.** A quota é
  `round(coalesce(valor_dividir, valor) / nº participantes, 2)`, quem compra não aparece e absorve o
  cêntimo que sobrar. A app E a Edge Function das notificações leem a view;
  **ninguém recalcula uma quota**. É a lição do SplitBill (o mesmo David a
  17.50 no PDF e 17.51 nas dívidas). Sítio novo que mostre quanto alguém
  deve = lê a view.
- **`participantes` é uma fotografia.** Fica gravado na prenda; o ciclo só
  PROPÕE na hora de registar. O grupo muda, e uma prenda de março não pode
  passar a dividir-se por quem entrou em setembro. O mesmo para
  `responsavel`: o gravado manda, o ciclo sugere.
- **Uma prenda por aniversariante por ano** (`UNIQUE (aniversariante, ano)`,
  `ano` gerado da `data`). A app casa aniversário ↔ prenda pelo ano, não pela
  data exata — a garrafa pode ser entregue dias depois.
- **O acesso é ter email em `amigos`.** Não há `allowed_users`: dois sítios
  a dizer quem é do grupo divergiam. Quem entra sem estar ligado vê "sem
  acesso", pede, e o admin liga a conta a um nome (`ligar_email`).
- **Escritas em `eventos` e `pagamentos` só por RPC SECURITY DEFINER**
  (`guardar_evento`, `apagar_evento`, `declarar_pagamento`,
  `registar_recebido`, `resolver_pagamento`, `anular_pagamento`,
  `marcar_pago`). As regras
  vivem lá, num sítio só. Resumo: regista/edita a prenda **quem compra ou o
  admin**; quem compra não muda o aniversariante nem passa a
  responsabilidade (isso é do admin); declara quem deve; aceita/recusa quem
  recebeu; anula o próprio "já paguei" enquanto não for aceite, e quem
  recebeu anula qualquer um. `amigos` e `config`: só o admin (RLS).
- **Armadilha já evitada no SQL:** com `eu()` a NULL, `NOT (false OR NULL)`
  é NULL e um `IF NULL` NÃO entra no `RAISE` — deixava passar. Toda a
  verificação de permissão vai dentro de `coalesce(…, false)`.
- **Ler é aberto a quem tem acesso** (`is_allowed()`), escrever nunca por
  REST direto. GRANTs tabela a tabela; nada executável por `anon` (a
  consulta de confirmação está no fim do `schema.sql`).

## O vinho (`vinho jsonb` na prenda)
Campos: `nome, produtor, ano, tipo, regiao, pais, castas[], teor, estagio,
vivino_nota, vivino_url, imagem_url, preco_medio, notas_prova, harmonizacao,
resumo, loja, fontes[], origem ('catalogo'|'pesquisa'|'manual'),
catalogo_id`.
- **Dois degraus, do mais barato ao mais caro:** (1) `winecatalog.comparar`
  com `p_ficha = {}` (grátis, aberta a qualquer sessão — devolve o que o
  catálogo sabe); (2) só se o catálogo souber pouco, a Edge Function
  `prendas-vinho` (pesquisa Google com grounding, síncrona, ~€0.01).
- **Nenhum dos dois escreve por cima do que já está no formulário** — só
  preenche vazios. Quem tem a garrafa na mão sabe melhor.
- **O ecrã fala por etapas, com as mesmas palavras da Garrafeira**
  (26/09/2026, revisto a 27/09): "Procurar" mostra primeiro os CANDIDATOS do
  catálogo em lista (`winecatalog.colheitas`: todas as colheitas, a cor
  tirada dos dois lados, o produtor como um "contém"), com nome, ano,
  produtor, castas e região; o da colheita escrita vem marcado. Escolhe-se
  um (`escolherCandidato`: a `comparar` com o nome e o ano dessa linha
  enche os vazios; de outra colheita, sem nota nem preço) ou "Nenhum
  destes". Depois: "Queres usar a IA…?" → uma procura só: o admin (pacote
  completo) faz na `prendas-vinho`, de seguida, o Serper e depois o
  grounding pelo que faltar; os outros só o grounding. Já não há botão de
  pesquisa profunda — está dentro da procura do admin. Os sites de
  referência ainda não existem aqui.
- **A COR escolhe-se ANTES da procura** (o produtor vem depois, e a procura
  preenche-o): quem tem a garrafa sabe sempre a cor, e é ela que separa o
  "Papa Figos" tinto do branco. A `prendas-vinho` recebe-a no prompt como
  dado seguro. O catálogo tem a cor na chave desde 27/09/2026 (a `colheitas`
  já só devolve a mesma cor ou nenhuma), e a app confere-a na mesma: se o
  catálogo devolver outra cor, **não copia nada** e diz porquê — e o trigger
  que leva a prenda ao catálogo também não usa uma ligação de outra cor.
- **A ficha é uma CÓPIA, e não se atualiza sozinha.** O que muda depois no
  catálogo (uma imagem nova, uma nota) só chega à prenda pelo botão
  **"🔄 Atualizar do catálogo"** da ficha (quem gere a prenda): a
  `winecatalog.comparar` recebe a ficha da prenda como "a minha" e devolve
  só o que difere; mostra-se "agora → catálogo" campo a campo e grava-se o
  que for escolhido (`aplicarDoCatalogo`, pela `guardar_evento`). À mão de
  propósito — nada muda sem confirmar.
- **O vinho de uma prenda vai para o catálogo** (29/09/2026, o dono: "os
  vinhos pesquisados/gravados na AnniversaryGifts não estão a ficar no
  Catálogo — quero que fiquem"). Até aí a app só lia: a pesquisa com IA de
  uma prenda morria na prenda, e o próximo a procurar o mesmo vinho pagava-a
  outra vez. Agora um trigger na `eventos` (`eventos_catalogo` →
  `catalogar_vinho`, `db/schema.sql`, "O VINHO VAI PARA O CATÁLOGO") passa a
  ficha pela `winecatalog.juntar` — a porta de escrita do catálogo, com a
  força de lá: origem **`prenda`, força 1 em tudo** (enche o que falta, perde
  para qualquer coisa a sério), "uma prenda de anos" no histórico, nunca quem
  gravou. A origem vive na `forca()`/`quem_escreve()` do repo WineCatalog, que
  tem de correr antes. As regras:
  · **só depois da surpresa**: uma prenda por entregar cujo dia ainda não
    passou fica pendente (`catalogado_em` NULL) — o admin do catálogo também
    faz anos. Vai quando é entregue, ou no dia a seguir aos anos pelo
    `pg_cron` (`anniversarygifts-catalogo`, 04:17 UTC, `catalogar_pendentes`);
  · **só o que é do vinho**: a loja, o preço pago e as notas nunca vão; as
    castas perdem o que não é casta ("Vinhas Velhas"), o link do Vivino só no
    formato `/<nome>/w/<nº>`, o produtor sem o parêntesis, e a `vivino_nota`
    entra como a de TODAS as colheitas (é a da página do vinho que a
    `prendas-vinho` pede);
  · **a ligação manda**: com `vinho.catalogo_id` escreve-se NA linha ligada,
    com o nome dela; noutra colheita, é essa casa com a colheita da prenda e
    sem o que é da colheita; mudado nome/produtor/ano/cor com a mesma
    ligação, ela sai e procura-se pelo nome; cor diferente nunca serve. No
    fim o id fica em `vinho.catalogo_id`;
  · **nunca deita a gravação abaixo**: um erro é um WARNING no log e a prenda
    fica pendente para o cron.
  Um vinho só PESQUISADO (sem gravar a prenda) não vai — a lição da
  Garrafeira: gravar antes de confirmar o nome pôs no catálogo o "Cristo
  Vinhas Velhas". As 8 prendas que já existiam foram registadas a 29/09/2026
  por esta mesma porta (5 linhas novas; o "Tapada de Coelheiros" 2020 e o
  "Chocapalha Vinha Mãe" 2019 nasceram com o nome do vinho, e não o da
  prenda).
- **De memória ou pesquisado (24/09/2026).** Ligar o `google_search` não
  obriga o modelo a pesquisar, e nos registos das apps nunca o fez:
  respondeu de memória. Para toda a gente fica assim; a resposta leva
  `pesquisaWeb`, e ao admin (`acesso().admin`, confirmado na função) a de
  memória mostra 🧠 e o botão **🔬 Pesquisa profunda** (`profunda:true`),
  que desde 25/09/2026 é **Serper, não grounding** (não há parâmetro na API
  que obrigue o Gemini a pesquisar): a função faz duas consultas ao Google
  pelo Serper (geral + Vivino, chave `SEARCH_API_KEY`, segredo do projeto)
  e o Gemini só lê os resultados; sem resultados, erro sem chamar o Gemini. O
  que a profunda confirmar substitui só o que a de memória tinha preenchido
  (`_pesqMemoria`), nunca o que foi escrito à mão. Mesmo critério nas
  quatro apps — ver o `CLAUDE.md` da WineCatalog, "De memória ou
  pesquisado".
- A `prendas-vinho` segue as lições das irmãs (ver o `CLAUDE.md` da
  WineCatalog): só ponteiros `-latest`; nada de `thinkingBudget:0` com
  `google_search`; o corpo lê-se DENTRO do ciclo e um 200 vazio passa ao
  modelo seguinte e, se nenhum escrever, é **erro** (com o `finishReason`),
  nunca "não encontrei"; regista cada chamada em `ia_uso.registos`
  (`app: "anniversarygifts"`) num try/catch que engole tudo — e está
  registada em `ia_uso.funcoes` (`grounding = true`), que é de onde a app
  dos custos tira a regra de faturação da pesquisa. **Função nova que chame
  o Gemini = linha nova em `ia_uso.funcoes`**, senão o custo sai errado. **Se mexeres na
  escolha de modelo aqui, vai ver as outras no mesmo dia.**

## A lista de amigos é também um portão noutra app (25/09/2026)
A WineSelection mostra marcas nos vinhos de uma carta — 🍾 na garrafeira
de um amigo, ⭐ bebido e com nota, 💭 na wishlist, 🎁 já foi prenda — e
"os amigos" são ESTA tabela: quem está em `amigos` (ativo, com email) vê as
marcas, e só contam as garrafeiras dos que estão cá. Quem responde é a
`winecatalog.marcas_amigos` (`db/amigos.sql` no repo WineCatalog), que lê
`amigos` e `eventos` diretamente. Por isso: **pôr ou tirar alguém daqui,
ou desligar o `ativo`, também decide o que essa pessoa vê e mostra lá.**
A regra da surpresa vale lá também — uma prenda por entregar nunca aparece
a quem a vai receber —, e se mudares os estados (`comprado`/`entregue`) ou
os campos `vinho.nome`/`produtor`/`catalogo_id`, vê essa função no mesmo
dia.

## A garrafa é SURPRESA para quem faz anos
- **Estados: só `comprado` e `entregue`.** "Por comprar" saiu a pedido do
  dono: a prenda regista-se quando a garrafa já foi comprada, e "comprada"
  já chega para quem comprou receber as partes. Data no passado → nasce
  "Entregue"; hoje ou à frente → "Comprada".
- **Quem faz anos NÃO vê a garrafa até ela passar a `entregue`** — nem o
  nome, nem a foto, nem a ficha, nem as notas. As dívidas vê (são públicas).
  Isto é do SERVIDOR, não da UI: `authenticated` já não tem SELECT na
  `eventos`; lê-se a view **`eventos_v`** (corre como o dono, portão
  `is_allowed()`), que devolve `vinho = {}`, `notas = NULL` e
  `vinho_oculto = true` a quem faz anos numa prenda por entregar. A
  `dividas` passou também a `security_invoker = false` pela mesma razão.
  A app só mostra "🎁 Surpresa" onde vê `vinho_oculto`.
- **Nem o admin mexe na própria prenda antes de a receber**
  (`guardar_evento` recusa registar e alterar): a app recebe a ficha vazia,
  e gravar por cima apagava a garrafa. `podeGerirEvento`/
  `podeRegistarAniversario` escondem os botões pelo mesmo motivo.
- Sítio novo que leia prendas = lê a `eventos_v`, nunca a `eventos`. As
  Edge Functions leem a tabela com a service role e **não podem pôr o vinho
  num aviso** que chegue a quem faz anos.
- **Portão `is_allowed()` numa view que uma Edge Function lê = deixar
  passar também `auth.role() = 'service_role'`.** A service role não tem
  `eu()`: a `dividas` chegou a devolver-lhe zero linhas e os avisos de
  dívida e os lembretes não saíam para ninguém (200, `enviados: 0`).

## O ecrã inicial: quatro cartões grandes
Próximo aniversário (e quem compra) · a próxima prenda que EU compro · a
última que recebi · a minha conta (a pagar / a receber). Por baixo só o que
pede ação (pagamentos para confirmar, aniversários por registar). O dono
gosta de inícios assim, com cartões grandes — lista nova vai por baixo ou
para outro separador, não entre os cartões.

## O preço e "quem já pagou"
- **O preço é SEMPRE opcional.** Registar a garrafa e gerir as contas pela
  app são coisas separadas, e a segunda é com cada um: quem quiser mete o
  preço e as dívidas nascem; quem não quiser não mete, e **sem preço ninguém
  deve nada** (a view não gera linhas). Chegou a ser obrigatório a partir de
  23/09/2026 (`preco_obrigatorio_desde`); saiu a pedido do dono — não voltar
  a pôr sem ele pedir.
- **"Quem já pagou" marca-se no próprio formulário** (`folhaFormPagos`),
  gravado pela `marcar_pago` ANTES de sair o aviso `divida`. Senão, numa
  prenda passada, toda a gente recebia uma notificação de dívida no
  intervalo entre registar e ir marcar um a um. Marcar deixa a conta
  **exatamente a zero** (tira o "já paguei" pendente, que pode ter outro
  valor, e mete um confirmado pelo saldo); desmarcar apaga os pagamentos
  dessa pessoa nessa prenda.

## O limite por prenda (`valor_dividir`)
Há um valor máximo combinado (`config.limite_prenda`, Definições › admin).
Quem escolhe gastar mais **normalmente** fica com o excedente — por isso o
que se DIVIDE (`eventos.valor_dividir`) pode ser menos do que o que se PAGOU
(`valor`). No formulário, "A dividir" fica ao lado do preço e **propõe**
`min(preço, limite)`, mas pode mudar-se ("normalmente" não é "sempre"); o
servidor só garante que não passa do preço. `NULL` = divide-se o preço todo.
A view `dividas` usa `coalesce(valor_dividir, valor)` — continua a ser a
única fonte de cêntimos, e o excedente fica com quem comprou, como o cêntimo
do arredondamento.

## Notificações (`prendas-notificar`)
O cliente só diz **de que se trata** (`evento_id`, `pagamento_id`); valores,
nomes e texto saem da BD, lá dentro. Assim nenhum aviso diz um valor
diferente do ecrã. Tipos: `divida` (ao guardar um preço novo, só em prendas
dos últimos 45 dias — registar o histórico não acorda ninguém), `lembrete`,
`pagamento_declarado`, `pagamento_resolvido`, `pedido_acesso`.
Mesmo par VAPID do SplitBill (os secrets são do projeto); a tabela de
subscriptions é própria porque o service worker é outro.

**Insistir com quem não as tem** (pedido do dono), em dois níveis:
- um **aviso fixo no topo do Início** enquanto não estiverem ativas NESTE
  dispositivo (`pushAvisoHTML`) — texto curto, porque fica lá sempre;
- uma **folha de cada vez que se abre a app** (`pushConvidar` → `folhaPush`).
  "Agora não" vale só até à próxima entrada — é de propósito, o dono quer
  insistir. Já esteve limitada a 3 em 3 dias; não voltar a pôr sem ele pedir.
Três casos (`_pushEstado`): `pedir` (tem botão Ativar — o
`requestPermission` precisa do toque); `negado` (o browser já não deixa a app
perguntar: só se explica onde se liga); `instalar` (iPhone no Safari: sem a
app no ecrã principal não há push nenhum). O estado é por DISPOSITIVO, não
por conta — é a subscription que conta.

**Painel do admin (Definições › Amigos):** cada amigo mostra 🔔/🔕 (só
sim/não — quantos dispositivos não interessa ao dono) e a última entrada,
pela `estado_amigos()` (só admin — é quem lê as subscriptions dos outros).
A entrada é DESTA app: a app chama `registar_entrada()` sempre que abre
(tabela `entradas`, sem acesso por REST). O `last_sign_in_at` do auth NÃO
se mostra: o projeto é partilhado com as outras apps e a sessão renova-se
sem login novo, e o dono só quer saber quando entraram nesta.

## 29 de fevereiro
Nos anos comuns o aniversário conta a **1 de março** (`dataAnos`), não a 28 —
é quando o João Paulo festeja. Na ordem do ciclo continua a valer 29/fev.

## Eventos passados
`config.inicio` (Definições › admin) diz desde quando o grupo faz isto. A
app lista em **Início › Por registar** cada aniversário desde essa data sem
prenda. Sem data escolhida, um ano para trás. Uma prenda registada com data
no passado nasce "Entregue" e não notifica ninguém.

## Regras técnicas (não partir a app)
- `app.js` é `<script src>` **normal, NÃO module** — há `onclick="…"`, as
  funções têm de ser globais.
- `esc()` para conteúdo, `escJs()` para o que vai dentro de
  `onclick="…('…')"` (nomes com plica).
- A chave `anon` no topo do `app.js` é **pública por design**. Não é bug.
- **Alterar o schema:** edita primeiro `db/schema.sql` (idempotente) e só
  depois corre no SQL Editor.
- Um nome de amigo é a identidade (PK, e está em `participantes`, que é um
  array sem FK). **Não há renomear**: apagar só funciona para quem nunca
  entrou numa prenda; quem sai do grupo fica `ativo = false`.
- **Campos de euros são `type="text" inputmode="decimal"`, nunca
  `type="number"`**, lidos com `lerNum()` (vírgula ou ponto) e mostrados com
  `numTxt()`. No iPhone em português o teclado dá vírgula, e um campo number
  com "12," fica com `value` vazio: a app lia "sem preço", redesenhava a
  folha e o campo aparecia limpo a meio de se escrever. Já aconteceu.
- Edições **cirúrgicas**.

## Deploy
GitHub Pages a partir de `main`. Edge Functions:
`supabase functions deploy prendas-notificar` e
`supabase functions deploy prendas-vinho` (verify_jwt ligado nas duas).
