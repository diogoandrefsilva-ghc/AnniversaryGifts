# Prendas de Anos 🍷

As prendas de anos do grupo — sempre uma garrafa de vinho. Quem faz anos
imediatamente antes compra a garrafa para o seguinte, e o custo divide-se
por todos menos quem faz anos. A app diz a quem cabe comprar, guarda a ficha
da garrafa, e trata das contas como o SplitBill: quem deve declara que
pagou, quem recebeu confirma. As dívidas são públicas no grupo.

## Os ecrãs
- **Início** — a garrafa que te cabe comprar, pagamentos para confirmar, o
  que deves, os próximos anos e os aniversários passados por registar.
- **Prendas** — todas as garrafas oferecidas, por ano.
- **Dívidas** — quem deve quanto a quem, por pessoa e por prenda.
- **Ciclo** — quem compra a quem, pela ordem dos anos.
- **Definições** — notificações; e, para o admin, amigos e datas, desde
  quando o grupo faz isto, e pedidos de acesso.

## Instalar
Site estático, **sem build e sem npm**. PWA.
1. **Base de dados** — ver [`db/README.md`](db/README.md).
2. **Edge Functions** — `supabase functions deploy prendas-notificar` e
   `supabase functions deploy prendas-vinho`.
3. **Publicar** — GitHub Pages a partir de `main`.

Ver [`CLAUDE.md`](CLAUDE.md) para as decisões e o porquê.
