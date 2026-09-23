-- =====================================================================
-- AnniversaryGifts — primeira lista de amigos, copiada do SplitBill.
-- Correr UMA vez, depois de schema.sql. Idempotente (não mexe em quem já
-- lá estiver).
--
-- Copia-se de `splitbill.amigo_users` (nome ↔ email) em vez de escrever os
-- emails aqui: o repo é público e a equivalência já existe na BD. As DATAS
-- de anos não vêm de lado nenhum — metem-se na app (Definições › Amigos).
-- Quem não estiver no SplitBill acrescenta-se à mão no mesmo ecrã.
-- =====================================================================
INSERT INTO anniversarygifts.amigos (nome, email)
SELECT au.amigo, lower(au.email)
  FROM splitbill.amigo_users au
 WHERE au.amigo IS NOT NULL AND btrim(au.amigo) <> ''
ON CONFLICT (nome) DO NOTHING;
