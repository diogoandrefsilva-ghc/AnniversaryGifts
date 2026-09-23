# Base de dados — schema `anniversarygifts`

Mesmo projeto Supabase das outras apps.

1. Correr `schema.sql` no SQL Editor (idempotente).
2. Correr `seed-amigos.sql` uma vez (copia nomes+emails de
   `splitbill.amigo_users`; as datas de anos metem-se na app).
3. **Settings → API → Exposed schemas**: acrescentar `anniversarygifts`.
   Sem isto a app diz "Falta expor o schema".
4. **Authentication → URL Configuration → Redirect URLs**: garantir que
   `https://<utilizador>.github.io/AnniversaryGifts/` é aceite (o login
   Google volta para lá).
5. Confirmar que nada ficou aberto a `anon` (tem de dar zero linhas):

```sql
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'anniversarygifts' AND has_function_privilege('anon', p.oid, 'execute');
```

As Edge Functions usam secrets que o projeto já tem: `GEMINI_API_KEY`
(`prendas-vinho`) e `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (`prendas-notificar`,
os mesmos da `push-notificar` do SplitBill).
