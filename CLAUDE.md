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
- `style.css` — todo o CSS (paleta bordô/dourado das apps de vinhos).
- `sw.js` — service worker (cache + push). **Sobe `CACHE_NAME`** sempre que
  mexeres em `app.js`, `style.css` ou `index.html`.
- `db/schema.sql` — o schema inteiro, idempotente. `db/seed-amigos.sql` —
  primeira lista de amigos, copiada de `splitbill.amigo_users`.
- `prendas-notificar.ts`, `prendas-vinho.ts` — Edge Functions (Deno). **Não
  correm no site**: `supabase functions deploy <nome>`.
- `apple-touch-icon.png` / `icon-512.png` — gerados por um script Node
  descartável (encoder PNG à mão); não há fonte guardada.

## Decisões que seguram o resto
- **Uma só fonte de cêntimos: a view `anniversarygifts.dividas`.** A quota é
  `round(valor / nº participantes, 2)`, quem compra não aparece e absorve o
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
  `registar_recebido`, `resolver_pagamento`, `anular_pagamento`). As regras
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
- **Esta app NÃO escreve no catálogo.** O catálogo tem dono (WineCatalog) e
  regras de força por origem; uma porta de escrita nova teria de passar pela
  `juntar` e pela `forca()` de lá — decisão desse repo, não deste.
- A `prendas-vinho` segue as lições das irmãs (ver o `CLAUDE.md` da
  WineCatalog): só ponteiros `-latest`; nada de `thinkingBudget:0` com
  `google_search`; o corpo lê-se DENTRO do ciclo e um 200 vazio passa ao
  modelo seguinte e, se nenhum escrever, é **erro** (com o `finishReason`),
  nunca "não encontrei"; regista cada chamada em `ia_uso.registos`
  (`app: "anniversarygifts"`) num try/catch que engole tudo. **Se mexeres na
  escolha de modelo aqui, vai ver as outras no mesmo dia.**

## Notificações (`prendas-notificar`)
O cliente só diz **de que se trata** (`evento_id`, `pagamento_id`); valores,
nomes e texto saem da BD, lá dentro. Assim nenhum aviso diz um valor
diferente do ecrã. Tipos: `divida` (ao guardar um preço novo, só em prendas
dos últimos 45 dias — registar o histórico não acorda ninguém), `lembrete`,
`pagamento_declarado`, `pagamento_resolvido`, `pedido_acesso`.
Mesmo par VAPID do SplitBill (os secrets são do projeto); a tabela de
subscriptions é própria porque o service worker é outro.

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
- Edições **cirúrgicas**.

## Deploy
GitHub Pages a partir de `main`. Edge Functions:
`supabase functions deploy prendas-notificar` e
`supabase functions deploy prendas-vinho` (verify_jwt ligado nas duas).
