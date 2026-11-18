// NEXAR Confirm Action — Supabase Edge Function
//
// This function is deployed with gateway JWT verification disabled because it
// performs its own session validation with auth.getUser(). Never remove that
// validation while verify_jwt is false.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const MAX_BODY_BYTES = 4096;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get('Authorization') ?? '';
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value);
}

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  try {
    const jwt = bearerToken(req);
    if (!jwt) return json({ error: 'unauthorized' }, 401);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userResult, error: userError } =
      await authClient.auth.getUser(jwt);

    if (userError || !userResult?.user) {
      return json({ error: 'invalid_session' }, 401);
    }

    const contentType = req.headers.get('Content-Type') ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return json({ error: 'unsupported_media_type' }, 415);
    }

    const rawBody = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!rawBody) {
      return json({ error: 'request_too_large' }, 413);
    }

    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const actionId = String(body?.action_id ?? '').trim();
    if (!isUuid(actionId)) {
      return json({ error: 'invalid_action_id' }, 400);
    }
    if (typeof body?.accept !== 'boolean') {
      return json({ error: 'invalid_accept' }, 400);
    }

    const userId = userResult.user.id;
    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const consumedAt = new Date().toISOString();

    // Claim exactly one still-live action before performing any side effect.
    // This single conditional UPDATE is the replay/concurrency boundary: an
    // accept/cancel race can have only one winner.
    const { data: claimed, error: claimError } = await serviceClient
      .from('nexar_pending_actions')
      .update({ consumed_at: consumedAt })
      .eq('id', actionId)
      .eq('user_id', userId)
      .eq('action_type', 'delete_pipeline')
      .is('consumed_at', null)
      .gt('expires_at', consumedAt)
      .select('id, user_id, action_type, target_id, preview, expires_at, consumed_at')
      .maybeSingle();

    if (claimError) {
      console.error('nexar-confirm-action claim failed', claimError);
      return json({ error: 'claim_failed' }, 500);
    }
    if (!claimed) {
      return json({ error: 'not_actionable' }, 409);
    }

    if (!body.accept) {
      return json({
        ok: true,
        action: 'cancelled',
        preview: claimed.preview,
      });
    }

    // The action row is now consumed. A failed delete is fail-closed; the user
    // must request a new confirmation rather than replay this action.
    const { data: deletedRows, error: deleteError } = await serviceClient
      .from('nexar_pipeline')
      .delete()
      .eq('id', claimed.target_id)
      .eq('user_id', userId)
      .select('id, title, company');

    if (deleteError) {
      console.error('nexar-confirm-action delete failed', deleteError);
      return json({ error: 'delete_failed' }, 500);
    }

    const target = deletedRows?.[0];
    if (!target) {
      return json({
        ok: true,
        action: 'already_gone',
        preview: claimed.preview,
      });
    }

    return json({
      ok: true,
      action: 'deleted',
      target: {
        id: target.id,
        title: target.title,
        company: target.company,
      },
      preview: claimed.preview,
    });
  } catch (error) {
    console.error('nexar-confirm-action fatal', error);
    return json({ error: 'internal_error' }, 500);
  }
});
