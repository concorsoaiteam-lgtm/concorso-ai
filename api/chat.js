import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const SYSTEM_PROMPT_BASE = `Sei un commissario d'esame per concorsi pubblici italiani.
Ruolo: formale, freddo, diretto. Dai SEMPRE del Lei al candidato.

REGOLE FISSE:
1. Fai UNA domanda alla volta.
2. NON correggere errori durante l'esame: tienili per il feedback finale.
3. Usa il contesto del bando per fare domande specifiche.
4. Adatta il tono alla difficoltà:
   - Facile: domande lineari, meno pressione
   - Realistico: commissione vera, follow-up normali
   - Difficile: incalzante, cambi materia improvvisi, scenari pratici
5. Dopo la tua risposta/domanda, restituisci SEMPRE alla fine un JSON con i punteggi dell'ULTIMA risposta dell'utente (se c'è stata una risposta):
   { "chiarezza": X, "struttura": Y, "contenuto": Z } dove X,Y,Z sono numeri da 1 a 10.
6. Massimo 80 parole per domanda/risposta.

Contesto bando RAG:
`;

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Metodo non supportato' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await req.json();
    const { messages, selectedBandoIds, difficulty, userId, userLastSimulations = [] } = body;

    // 1. Recupera chunks RAG
    let ragContext = '';
    if (selectedBandoIds && selectedBandoIds.length > 0) {
      const { data: chunks, error: chunksError } = await supabase
        .from('chunks')
        .select('content')
        .in('bando_id', selectedBandoIds)
        .order('chunk_index', { ascending: true })
        .limit(5);

      if (!chunksError && chunks && chunks.length > 0) {
        ragContext = chunks.map(c => c.content).join('\n---\n');
      }
    }

    // 2. Costruisci system prompt completo
    let adaptivePart = '';
    if (userLastSimulations.length > 0) {
      adaptivePart = `\nDebolezze utente da ultime simulazioni: ${JSON.stringify(userLastSimulations)}. Insisti su queste aree.`;
    }
    const systemPrompt = SYSTEM_PROMPT_BASE + ragContext + `\nDifficoltà corrente: ${difficulty}` + adaptivePart;

    // 3. Prepara messaggi per BluesMinds (OpenAI-compatible)
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    // 4. Chiamata BluesMinds
    const bluesMindsResponse = await fetch('https://api.bluesminds.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BLUESMINDS_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: apiMessages,
        temperature: 0.4,
        stream: true
      })
    });

    if (!bluesMindsResponse.ok) {
      const errorText = await bluesMindsResponse.text();
      return new Response(JSON.stringify({ error: `Errore AI: ${errorText}` }), {
        status: bluesMindsResponse.status, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 5. Proxy streaming risposta
    return new Response(bluesMindsResponse.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });

  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: 'Errore interno: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}