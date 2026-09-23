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
- **A COR escolhe-se ANTES da procura** (o produtor vem depois, e a procura
  preenche-o): quem tem a garrafa sabe sempre a cor, e é ela que separa o
  "Papa Figos" tinto do branco. A `prendas-vinho` recebe-a no prompt como
  dado seguro. O catálogo ainda NÃO tem a cor na chave (é "a mudança da cor
  na chave", decidida e por fazer na WineCatalog), por isso a app confere
  à mão: se o catálogo devolver outra cor, **não copia nada** e diz porquê.
- **A ficha é uma CÓPIA, e não se atualiza sozinha.** O que muda depois no
  catálogo (uma imagem nova, uma nota) só chega à prenda pelo botão
  **"🔄 Atualizar do catálogo"** da ficha (quem gere a prenda): a
  `winecatalog.comparar` recebe a ficha da prenda como "a minha" e devolve
  só o que difere; mostra-se "agora → catálogo" campo a campo e grava-se o
  que for escolhido (`aplicarDoCatalogo`, pela `guardar_evento`). À mão de
  propósito — nada muda sem confirmar.
- **Esta app NÃO escreve no catálogo.** O catálogo tem dono (WineCatalog) e
  regras de força por origem; uma porta de escrita nova teria de passar pela
  `juntar` e pela `forca()` de lá — decisão desse repo, não deste.
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
