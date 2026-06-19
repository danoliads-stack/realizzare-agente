-- Rodar no Supabase SQL Editor (já pode ter sido executado parcialmente)
-- Todas as colunas usam IF NOT EXISTS para ser seguro rodar novamente

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS agente_ativo boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS qualificado boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS tipo_projeto text,
  ADD COLUMN IF NOT EXISTS orcamento_faixa text,
  ADD COLUMN IF NOT EXISTS prazo_desejado text,
  ADD COLUMN IF NOT EXISTS assumido_por text,
  ADD COLUMN IF NOT EXISTS assumido_em timestamptz;

CREATE TABLE IF NOT EXISTS conversas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('agent', 'user')),
  mensagem text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversas_lead_id ON conversas(lead_id);
CREATE INDEX IF NOT EXISTS idx_conversas_created_at ON conversas(created_at);
